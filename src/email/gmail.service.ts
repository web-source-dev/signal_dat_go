import { Injectable } from "@nestjs/common";
import { google } from "googleapis";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.metadata",
];

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyHtml: string;
  /** Set when replying within an existing thread, to thread the message correctly. */
  inReplyToMessageId?: string;
  threadId?: string;
}

export interface SendEmailResult {
  providerMessageId: string;
  providerThreadId: string;
}

/** Pure function — easy to unit test without a live Gmail API call. */
export function buildRawGmailMessage(to: string, from: string, input: SendEmailInput): string {
  const headers = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/html; charset=utf-8",
    "MIME-Version: 1.0",
  ];

  if (input.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${input.inReplyToMessageId}`, `References: ${input.inReplyToMessageId}`);
  }

  const message = `${headers.join("\r\n")}\r\n\r\n${input.bodyHtml}`;

  return Buffer.from(message).toString("base64url");
}

@Injectable()
export class GmailService {
  private getOAuthClient() {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? process.env.GMAIL_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI must be set to use Gmail integration");
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  getAuthUrl(state: string): string {
    const client = this.getOAuthClient();
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // forces a refresh_token on every consent, not just the first time
      scope: GMAIL_SCOPES,
      state,
    });
  }

  async exchangeCode(code: string) {
    const client = this.getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) throw new Error("Google did not return an access token");

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };
  }

  private getGmailClient(accessToken: string, refreshToken: string | null) {
    const client = this.getOAuthClient();
    client.setCredentials({ access_token: accessToken, refresh_token: refreshToken ?? undefined });
    return google.gmail({ version: "v1", auth: client });
  }

  async getUserEmail(accessToken: string, refreshToken: string | null): Promise<string> {
    const gmail = this.getGmailClient(accessToken, refreshToken);
    const { data } = await gmail.users.getProfile({ userId: "me" });
    if (!data.emailAddress) throw new Error("Gmail profile did not return an email address");
    return data.emailAddress;
  }

  async sendEmail(
    accessToken: string,
    refreshToken: string | null,
    fromEmail: string,
    input: SendEmailInput
  ): Promise<SendEmailResult> {
    const gmail = this.getGmailClient(accessToken, refreshToken);
    const raw = buildRawGmailMessage(input.to, fromEmail, input);

    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: input.threadId },
    });

    if (!data.id || !data.threadId) throw new Error("Gmail send did not return a message/thread id");
    return { providerMessageId: data.id, providerThreadId: data.threadId };
  }

  /**
   * Registers push notifications via Cloud Pub/Sub. Requires
   * GMAIL_PUBSUB_TOPIC (format: projects/{project}/topics/{topic}), which
   * must already be granted publish permission to
   * gmail-api-push@system.gserviceaccount.com per Google's setup docs.
   */
  async watchMailbox(accessToken: string, refreshToken: string | null): Promise<string> {
    const topicName = process.env.GMAIL_PUBSUB_TOPIC;
    if (!topicName) throw new Error("GMAIL_PUBSUB_TOPIC must be set to enable Gmail reply tracking");

    const gmail = this.getGmailClient(accessToken, refreshToken);
    const { data } = await gmail.users.watch({
      userId: "me",
      requestBody: { topicName, labelIds: ["INBOX"] },
    });

    if (!data.historyId) throw new Error("Gmail watch did not return a historyId");
    return data.historyId;
  }

  /** Returns the new message/thread ids added since `startHistoryId`, and the new latest historyId. */
  async listNewMessagesSince(
    accessToken: string,
    refreshToken: string | null,
    startHistoryId: string
  ): Promise<{ messages: Array<{ messageId: string; threadId: string }>; historyId: string }> {
    const gmail = this.getGmailClient(accessToken, refreshToken);
    const { data } = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
    });

    const messages = (data.history ?? [])
      .flatMap((h) => h.messagesAdded ?? [])
      .map((m) => m.message)
      .filter((m): m is { id: string; threadId: string } => Boolean(m?.id && m.threadId));

    return {
      messages: messages.map((m) => ({ messageId: m.id, threadId: m.threadId })),
      historyId: data.historyId ?? startHistoryId,
    };
  }

  async getMessageSnippet(
    accessToken: string,
    refreshToken: string | null,
    messageId: string
  ): Promise<{ from: string; snippet: string; internalDate: Date }> {
    const gmail = this.getGmailClient(accessToken, refreshToken);
    const { data } = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From"],
    });

    const fromHeader = data.payload?.headers?.find((h) => h.name === "From")?.value ?? "";
    // "Display Name <email@example.com>" -> "email@example.com"
    const from = fromHeader.match(/<(.+)>/)?.[1] ?? fromHeader;

    return {
      from,
      snippet: data.snippet ?? "",
      internalDate: data.internalDate ? new Date(Number(data.internalDate)) : new Date(),
    };
  }
}
