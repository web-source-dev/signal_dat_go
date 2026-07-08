import { Body, Controller, HttpCode, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Provider } from "@prisma/client";
import { ConnectedAccountsService } from "../connected-accounts/connected-accounts.service";
import { NotificationsService } from "../notifications/notifications.service";
import { OutreachService } from "../outreach/outreach.service";
import { GmailService } from "./gmail.service";
import { OutlookService } from "./outlook.service";

interface GmailPubSubPush {
  message: { data: string; messageId: string; publishTime: string };
  subscription: string;
}

interface GraphNotificationPayload {
  value: Array<{ subscriptionId: string; clientState?: string; resourceData: { id: string } }>;
}

/**
 * Public, unauthenticated by session design — these are called by
 * Google/Microsoft's own infrastructure, not the browser. Production
 * hardening not yet implemented here (see inline TODOs): verifying Gmail's
 * Pub/Sub push OIDC token against Google's public keys, and confirming
 * Graph's `clientState` on every notification (not just logging a mismatch).
 */
@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly gmail: GmailService,
    private readonly outlook: OutlookService,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly outreach: OutreachService,
    private readonly notifications: NotificationsService
  ) {}

  @Post("gmail")
  @HttpCode(200)
  async gmailPush(@Body() body: GmailPubSubPush) {
    // TODO: verify the request's `Authorization: Bearer <OIDC token>` header
    // against Google's public keys + expected audience before trusting this
    // payload, per https://cloud.google.com/pubsub/docs/push#validate_tokens
    const decoded = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")) as {
      emailAddress: string;
      historyId: string;
    };

    const account = await this.connectedAccounts.findByProviderAccountEmail(Provider.GMAIL, decoded.emailAddress);
    if (!account?.accessTokenEncrypted) return { ok: true }; // unknown mailbox — ack anyway, nothing to retry

    const tokens = await this.connectedAccounts.getDecryptedTokens(account.userId, Provider.GMAIL);
    if (!tokens) return { ok: true };

    const metadata = account.providerMetadata as { gmailHistoryId?: string } | null;
    const startHistoryId = metadata?.gmailHistoryId ?? decoded.historyId;

    const { messages, historyId } = await this.gmail.listNewMessagesSince(
      tokens.accessToken,
      tokens.refreshToken,
      startHistoryId
    );

    for (const { messageId, threadId } of messages) {
      const thread = await this.outreach.findThreadByProviderThread(account.userId, Provider.GMAIL, threadId);
      if (!thread) continue; // not a thread we sent — ignore

      const detail = await this.gmail.getMessageSnippet(tokens.accessToken, tokens.refreshToken, messageId);
      if (detail.from === tokens.providerAccountEmail) continue; // our own sent copy, not a reply

      await this.outreach.recordReply(thread.id, {
        providerMessageId: messageId,
        fromAddress: detail.from,
        snippet: detail.snippet,
        receivedAt: detail.internalDate,
      });
      this.notifications.publish(account.userId, {
        type: "NEW_REPLY",
        loadRef: thread.loadRef,
        outreachThreadId: thread.id,
      });
    }

    await this.connectedAccounts.setProviderMetadata(account.userId, Provider.GMAIL, { gmailHistoryId: historyId });
    return { ok: true };
  }

  @Post("outlook")
  @HttpCode(200)
  async outlookNotification(
    @Query("validationToken") validationToken: string | undefined,
    @Body() body: GraphNotificationPayload,
    @Res() res: Response
  ) {
    // Graph's subscription-creation handshake: echo the token back as plain text.
    if (validationToken) {
      res.type("text/plain").send(validationToken);
      return;
    }

    for (const notification of body.value ?? []) {
      const account = await this.findAccountBySubscription(notification.subscriptionId);
      if (!account) continue;

      const metadata = account.providerMetadata as { graphClientState?: string } | null;
      if (notification.clientState && notification.clientState !== metadata?.graphClientState) {
        continue; // TODO: log/alert — a mismatched clientState may indicate a spoofed notification
      }

      const tokens = await this.connectedAccounts.getDecryptedTokens(account.userId, Provider.OUTLOOK);
      if (!tokens) continue;

      const message = await this.outlook.getMessage(
        tokens.accessToken,
        tokens.refreshToken,
        notification.resourceData.id
      );
      const fromAddress = message.from?.emailAddress?.address;
      if (!fromAddress || fromAddress === tokens.providerAccountEmail) continue;

      const thread = await this.outreach.findThreadByProviderThread(
        account.userId,
        Provider.OUTLOOK,
        message.conversationId
      );
      if (!thread) continue;

      await this.outreach.recordReply(thread.id, {
        providerMessageId: notification.resourceData.id,
        fromAddress,
        snippet: message.bodyPreview,
        receivedAt: new Date(message.receivedDateTime),
      });
      this.notifications.publish(account.userId, {
        type: "NEW_REPLY",
        loadRef: thread.loadRef,
        outreachThreadId: thread.id,
      });
    }

    res.status(200).send();
  }

  private async findAccountBySubscription(subscriptionId: string) {
    // providerMetadata is opaque JSON, so this is a scan rather than an
    // indexed lookup — fine at small scale; revisit (e.g. a dedicated
    // subscriptionId column) if the OUTLOOK connected-account count grows.
    return this.connectedAccounts.findByProviderMetadataField(Provider.OUTLOOK, "graphSubscriptionId", subscriptionId);
  }
}
