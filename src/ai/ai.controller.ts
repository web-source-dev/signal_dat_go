import { BadRequestException, Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { AiService, type SuggestReplyInput } from "./ai.service";

@UseGuards(SessionGuard)
@Controller("ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post("suggest-reply")
  async suggestReply(@Body() body: SuggestReplyInput) {
    if (!body.brokerEmailBody) {
      throw new BadRequestException("brokerEmailBody is required");
    }
    const suggestion = await this.ai.suggestReply(body);
    return { suggestion };
  }
}
