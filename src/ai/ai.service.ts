import { Injectable } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

export interface SuggestReplyInput {
  brokerEmailBody: string;
  tone?: "professional" | "firm" | "casual";
  loadContext?: {
    originCity?: string;
    originState?: string;
    destCity?: string;
    destState?: string;
    rateTotal?: number;
    equipmentType?: string;
  };
}

const TONE_INSTRUCTIONS: Record<NonNullable<SuggestReplyInput["tone"]>, string> = {
  professional: "Write in a polished, professional dispatcher tone.",
  firm: "Write firmly and directly — no hedging, get straight to the point.",
  casual: "Write in a brief, casual, conversational tone.",
};

/**
 * Server-side only — ANTHROPIC_API_KEY never reaches the extension client.
 * Structured load fields are passed explicitly rather than raw scraped HTML,
 * per the plan's data-privacy notes (keeps the prompt clean and avoids
 * sending unnecessary broker PII to the model beyond the reply text itself).
 */
@Injectable()
export class AiService {
  private getOpenRouterConfig():
    | {
        apiKey: string;
        model: string;
      }
    | null {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      apiKey,
      model: process.env.OPENROUTER_MODEL?.trim() || "anthropic/claude-3.5-sonnet",
    };
  }

  private getClient(): Anthropic {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set to use AI reply suggestions");
    return new Anthropic({ apiKey });
  }

  async suggestReply(input: SuggestReplyInput): Promise<string> {
    const tone = input.tone ?? "professional";

    const contextLines = input.loadContext
      ? Object.entries(input.loadContext)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "(no load context provided)";

    const systemPrompt = [
      "You are a freight dispatcher's email assistant.",
      "Draft a short, direct reply to the broker's email below.",
      TONE_INSTRUCTIONS[tone],
      "Reply with the email body only - no subject line, no signature, no commentary.",
    ].join(" ");
    const userPrompt = `Load context:\n${contextLines}\n\nBroker's email:\n${input.brokerEmailBody}`;

    const openRouter = this.getOpenRouterConfig();
    if (openRouter) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouter.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: openRouter.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 300,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const suggestion = data.choices?.[0]?.message?.content?.trim();
      if (!suggestion) throw new Error("OpenRouter did not return a text reply");
      return suggestion;
    }

    const client = this.getClient();
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude did not return a text reply");
    }
    return textBlock.text.trim();
  }
}
