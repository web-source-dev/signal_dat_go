const TONE_INSTRUCTIONS = {
  professional: "Write in a polished, professional dispatcher tone.",
  firm: "Write firmly and directly — no hedging, get straight to the point.",
  casual: "Write in a brief, casual, conversational tone.",
};

function getOpenRouterConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.OPENROUTER_MODEL?.trim() || "anthropic/claude-3.5-sonnet",
  };
}

function buildConversationTranscript(conversation) {
  if (!Array.isArray(conversation) || conversation.length === 0) return null;
  return conversation
    .filter((message) => message?.text || message?.content)
    .map((message) => {
      const speaker = message.role === "you" ? "You (dispatcher)" : "Broker";
      const text = String(message.text ?? message.content ?? "").trim();
      return `${speaker}: ${text}`;
    })
    .join("\n");
}

function parseJsonFromModel(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("AI did not return valid template JSON");
  }
}

async function callAi({ systemPrompt, userPrompt, maxTokens = 350, temperature = 0.35 }) {
  const openRouter = getOpenRouterConfig();
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
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim();
    if (!suggestion) throw new Error("OpenRouter did not return a text reply");
    return suggestion;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or ANTHROPIC_API_KEY must be set to use AI features");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const textBlock = data.content?.find((block) => block.type === "text");
  if (!textBlock?.text) throw new Error("Claude did not return a text reply");
  return textBlock.text.trim();
}

export async function generateTemplate(input) {
  const tone = input.tone ?? "professional";
  const systemPrompt = [
    "You are a freight dispatcher email template assistant.",
    "Create an outreach email template for reaching brokers about truck availability on posted loads.",
    TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.professional,
    "Use these variables where appropriate: {{origin}}, {{destination}}, {{rate}}, {{ratePerMile}}, {{miles}}, {{broker}}, {{equipment}}, {{weight}}, {{loadRef}}.",
    "Return ONLY valid JSON with keys: name (short template name), subject (email subject), body (HTML using <p> tags only, no signature).",
  ].join(" ");
  const userPrompt = input.prompt?.trim()
    ? `Create a broker outreach email template for: ${input.prompt.trim()}`
    : "Create a professional truck availability outreach template for freight brokers.";

  const raw = await callAi({ systemPrompt, userPrompt, maxTokens: 500, temperature: 0.4 });
  const parsed = parseJsonFromModel(raw);
  return {
    name: String(parsed.name ?? "AI template").trim(),
    subject: String(parsed.subject ?? "Re: {{origin}} → {{destination}}").trim(),
    body: String(parsed.body ?? "<p>Hi {{broker}},</p>").trim(),
  };
}

export async function improveTemplate(input) {
  const tone = input.tone ?? "professional";
  const systemPrompt = [
    "You are a freight dispatcher email template assistant.",
    "Improve the template below for clarity and professionalism while keeping the same intent.",
    TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.professional,
    "Preserve template variables like {{origin}} and {{broker}} exactly as written.",
    "Return ONLY valid JSON with keys: name, subject, body (HTML using <p> tags, no signature).",
  ].join(" ");
  const userPrompt = [
    `Template name: ${input.name ?? "Untitled"}`,
    `Subject: ${input.subject ?? ""}`,
    `Body:\n${htmlToPlain(input.body)}`,
  ].join("\n\n");

  const raw = await callAi({ systemPrompt, userPrompt, maxTokens: 500, temperature: 0.35 });
  const parsed = parseJsonFromModel(raw);
  return {
    name: String(parsed.name ?? input.name ?? "Untitled").trim(),
    subject: String(parsed.subject ?? input.subject ?? "").trim(),
    body: String(parsed.body ?? input.body ?? "").trim(),
  };
}

export async function suggestReply(input) {
  const tone = input.tone ?? "professional";
  const contextLines = input.loadContext
    ? Object.entries(input.loadContext)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "(no load context provided)";

  const transcript = buildConversationTranscript(input.conversation);

  const systemPrompt = [
    "You are a freight dispatcher's email assistant.",
    transcript
      ? "Draft the dispatcher's next reply to the broker based on the full conversation below."
      : "Draft a short, direct reply to the broker's email below.",
    TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.professional,
    input.autoSend
      ? "This reply will be sent automatically. Do NOT use bracket placeholders like [MC number]. Only state facts you know from the conversation/load context, or ask a short clarifying question."
      : "If the broker asked for information you don't have (like an MC number, rate, or documents), acknowledge the request and say you will provide it, using a placeholder like [MC number] the dispatcher can fill in.",
    "Reply with the email body only - no subject line, no signature, no commentary.",
  ].join(" ");

  const userPrompt = transcript
    ? [
        input.subject ? `Email subject: ${input.subject}` : null,
        `Load context:\n${contextLines}`,
        `Conversation so far (oldest first):\n${transcript}`,
        "Write the dispatcher's next reply to the broker.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : `Load context:\n${contextLines}\n\nBroker's email:\n${input.brokerEmailBody}`;

  const openRouter = getOpenRouterConfig();
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
    const data = await response.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim();
    if (!suggestion) throw new Error("OpenRouter did not return a text reply");
    return suggestion;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or ANTHROPIC_API_KEY must be set to use AI reply suggestions");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const textBlock = data.content?.find((block) => block.type === "text");
  if (!textBlock?.text) throw new Error("Claude did not return a text reply");
  return textBlock.text.trim();
}

export async function polishEmail(input) {
  const tone = input.tone ?? "professional";
  const systemPrompt = [
    "You are a freight dispatcher's email assistant.",
    "Polish the draft below for clarity and professionalism.",
    TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS.professional,
    "Keep it concise (under 120 words). Return the email body only — no subject, no signature block, no commentary.",
  ].join(" ");
  const userPrompt = `Subject: ${input.subject ?? "(none)"}\n\nDraft:\n${htmlToPlain(input.draftBody)}`;

  const openRouter = getOpenRouterConfig();
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
        temperature: 0.35,
        max_tokens: 350,
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim();
    if (!suggestion) throw new Error("OpenRouter did not return a polished email");
    return suggestion;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY or ANTHROPIC_API_KEY must be set to use AI polish");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 350,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  const textBlock = data.content?.find((block) => block.type === "text");
  if (!textBlock?.text) throw new Error("Claude did not return a polished email");
  return textBlock.text.trim();
}

function htmlToPlain(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}
