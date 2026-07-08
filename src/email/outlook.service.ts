import { Injectable } from "@nestjs/common";
import type { SendEmailInput, SendEmailResult } from "./gmail.service";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = ["Mail.Send", "Mail.ReadBasic", "offline_access", "User.Read"].join(" ");

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/**
 * Plain fetch-based Microsoft Graph client — deliberately not pulling in
 * @azure/msal-node or @microsoft/microsoft-graph-client, since the
 * authorization-code + refresh-token flow used here is a handful of plain
 * REST calls per Microsoft's own documented OAuth2 v2.0 endpoint.
 */
@Injectable()
export class OutlookService {
  private getClientCredentials() {
    const clientId = process.env.MICROSOFT_OAUTH_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.MICROSOFT_OAUTH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error(
        "MICROSOFT_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI must be set to use Outlook integration"
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  getAuthUrl(state: string): string {
    const { clientId, redirectUri } = this.getClientCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: SCOPES,
      state,
    });
    return `${AUTHORITY}/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string) {
    const { clientId, clientSecret, redirectUri } = this.getClientCredentials();
    const tokens = await this.requestToken({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code,
      scope: SCOPES,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    };
  }

  private async refreshAccessToken(refreshToken: string) {
    const { clientId, clientSecret } = this.getClientCredentials();
    return this.requestToken({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: SCOPES,
    });
  }

  private async requestToken(body: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    if (!response.ok) {
      throw new Error(`Microsoft token request failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as TokenResponse;
  }

  /** Refreshes if a refresh token is available, otherwise uses the access token as-is. */
  private async getValidAccessToken(accessToken: string, refreshToken: string | null): Promise<string> {
    if (!refreshToken) return accessToken;
    const refreshed = await this.refreshAccessToken(refreshToken);
    return refreshed.access_token;
  }

  private async graphFetch(accessToken: string, path: string, init?: RequestInit) {
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`Microsoft Graph request to ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  async getUserEmail(accessToken: string, refreshToken: string | null): Promise<string> {
    const token = await this.getValidAccessToken(accessToken, refreshToken);
    const response = await this.graphFetch(token, "/me?$select=mail,userPrincipalName");
    const data = (await response.json()) as { mail?: string; userPrincipalName?: string };
    const email = data.mail ?? data.userPrincipalName;
    if (!email) throw new Error("Graph /me did not return an email address");
    return email;
  }

  /**
   * Graph's `/sendMail` shortcut returns no body, so there's no way to learn
   * the sent message's id/conversationId for reply correlation. Instead:
   * create a draft, capture its id + conversationId, then send that draft.
   */
  async sendEmail(
    accessToken: string,
    refreshToken: string | null,
    input: SendEmailInput
  ): Promise<SendEmailResult> {
    const token = await this.getValidAccessToken(accessToken, refreshToken);

    const draftBody: Record<string, unknown> = {
      subject: input.subject,
      body: { contentType: "HTML", content: input.bodyHtml },
      toRecipients: [{ emailAddress: { address: input.to } }],
    };

    const createResponse = await this.graphFetch(token, "/me/messages", {
      method: "POST",
      body: JSON.stringify(draftBody),
    });
    const draft = (await createResponse.json()) as { id: string; conversationId: string };

    await this.graphFetch(token, `/me/messages/${draft.id}/send`, { method: "POST" });

    return { providerMessageId: draft.id, providerThreadId: draft.conversationId };
  }

  /**
   * Change notifications expire after ~3 days (Graph's max for mail
   * resources) — a scheduled job must call `renewSubscription` before then.
   * `clientState` should be a random secret checked on each incoming
   * notification to reject spoofed webhook calls.
   */
  async createSubscription(accessToken: string, refreshToken: string | null, clientState: string) {
    const token = await this.getValidAccessToken(accessToken, refreshToken);
    const notificationUrl = process.env.MICROSOFT_GRAPH_WEBHOOK_URL;
    if (!notificationUrl) throw new Error("MICROSOFT_GRAPH_WEBHOOK_URL must be set to enable Outlook reply tracking");

    const expirationDateTime = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();
    const response = await this.graphFetch(token, "/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource: "me/mailFolders('Inbox')/messages",
        expirationDateTime,
        clientState,
      }),
    });

    return (await response.json()) as { id: string; expirationDateTime: string };
  }

  async renewSubscription(accessToken: string, refreshToken: string | null, subscriptionId: string) {
    const token = await this.getValidAccessToken(accessToken, refreshToken);
    const expirationDateTime = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();
    await this.graphFetch(token, `/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime }),
    });
    return expirationDateTime;
  }

  async getMessage(accessToken: string, refreshToken: string | null, messageId: string) {
    const token = await this.getValidAccessToken(accessToken, refreshToken);
    const response = await this.graphFetch(
      token,
      `/me/messages/${messageId}?$select=conversationId,from,bodyPreview,receivedDateTime`
    );
    return (await response.json()) as {
      conversationId: string;
      from?: { emailAddress?: { address?: string } };
      bodyPreview: string;
      receivedDateTime: string;
    };
  }
}
