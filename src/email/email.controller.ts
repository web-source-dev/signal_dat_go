import { randomBytes } from "node:crypto";
import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Provider } from "@prisma/client";
import { SessionGuard } from "../auth/session.guard";
import { ConnectedAccountsService } from "../connected-accounts/connected-accounts.service";
import { OutreachService } from "../outreach/outreach.service";
import { GmailService } from "./gmail.service";
import { OutlookService } from "./outlook.service";

const OAUTH_STATE_COOKIE = "cs_oauth_state";

interface AuthedRequest extends Request {
  user: { id: string };
}

@UseGuards(SessionGuard)
@Controller("email")
export class EmailController {
  constructor(
    private readonly gmail: GmailService,
    private readonly outlook: OutlookService,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly outreach: OutreachService
  ) {}

  @Get("oauth/google/start")
  startGoogle(@Res({ passthrough: true }) res: Response) {
    const state = randomBytes(16).toString("hex");
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 5 * 60 * 1000 });
    res.redirect(this.gmail.getAuthUrl(state));
  }

  @Get("oauth/google/callback")
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() req: AuthedRequest,
    @Res() res: Response
  ) {
    this.verifyState(req, state);
    const tokens = await this.gmail.exchangeCode(code);
    const email = await this.gmail.getUserEmail(tokens.accessToken, tokens.refreshToken);

    await this.connectedAccounts.upsertTokens(req.user.id, Provider.GMAIL, tokens, { providerAccountEmail: email });

    try {
      const historyId = await this.gmail.watchMailbox(tokens.accessToken, tokens.refreshToken);
      await this.connectedAccounts.setProviderMetadata(req.user.id, Provider.GMAIL, { gmailHistoryId: historyId });
    } catch (error) {
      // Non-fatal: sending still works without reply tracking; surfaced via ConnectedAccount.lastError.
      await this.connectedAccounts.recordError(req.user.id, Provider.GMAIL, (error as Error).message);
    }

    res.type("html").send(successPage("Gmail", email));
  }

  @Get("oauth/outlook/start")
  startOutlook(@Res({ passthrough: true }) res: Response) {
    const state = randomBytes(16).toString("hex");
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 5 * 60 * 1000 });
    res.redirect(this.outlook.getAuthUrl(state));
  }

  @Get("oauth/outlook/callback")
  async outlookCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() req: AuthedRequest,
    @Res() res: Response
  ) {
    this.verifyState(req, state);
    const tokens = await this.outlook.exchangeCode(code);
    const email = await this.outlook.getUserEmail(tokens.accessToken, tokens.refreshToken);

    await this.connectedAccounts.upsertTokens(req.user.id, Provider.OUTLOOK, tokens, { providerAccountEmail: email });

    try {
      const clientState = randomBytes(16).toString("hex");
      const subscription = await this.outlook.createSubscription(tokens.accessToken, tokens.refreshToken, clientState);
      await this.connectedAccounts.setProviderMetadata(req.user.id, Provider.OUTLOOK, {
        graphSubscriptionId: subscription.id,
        graphSubscriptionExpiresAt: subscription.expirationDateTime,
        graphClientState: clientState,
      });
    } catch (error) {
      await this.connectedAccounts.recordError(req.user.id, Provider.OUTLOOK, (error as Error).message);
    }

    res.type("html").send(successPage("Outlook", email));
  }

  @Post("send")
  async send(
    @Body()
    body: {
      provider: "GMAIL" | "OUTLOOK";
      to: string;
      subject: string;
      bodyHtml: string;
      loadRef?: string;
      threadId?: string;
      inReplyToMessageId?: string;
      aiGenerated?: boolean;
    },
    @Req() req: AuthedRequest
  ) {
    if (!body.to || !body.subject || !body.bodyHtml) {
      throw new BadRequestException("to, subject, and bodyHtml are required");
    }

    const provider = body.provider === "GMAIL" ? Provider.GMAIL : Provider.OUTLOOK;
    const tokens = await this.connectedAccounts.getDecryptedTokens(req.user.id, provider);
    if (!tokens) {
      throw new BadRequestException(`No connected ${body.provider} account — connect one in Options first`);
    }

    const result =
      provider === Provider.GMAIL
        ? await this.gmail.sendEmail(tokens.accessToken, tokens.refreshToken, tokens.providerAccountEmail ?? "", body)
        : await this.outlook.sendEmail(tokens.accessToken, tokens.refreshToken, body);

    return this.outreach.recordSentEmail(req.user.id, {
      loadRef: body.loadRef ?? null,
      provider,
      providerThreadId: result.providerThreadId,
      providerMessageId: result.providerMessageId,
      subject: body.subject,
      brokerEmail: body.to,
      bodySnippet: body.bodyHtml.replace(/<[^>]+>/g, "").slice(0, 280),
      aiGenerated: body.aiGenerated ?? false,
    });
  }

  private verifyState(req: Request, state: string) {
    const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
    if (!state || !cookieState || state !== cookieState) {
      throw new BadRequestException("Invalid or expired OAuth state");
    }
  }
}

function successPage(provider: string, email: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px">
    <h2>${provider} connected</h2><p>${email} is now connected to CargoSignal. You can close this tab.</p>
  </body></html>`;
}
