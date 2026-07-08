const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = ["Mail.Send", "Mail.ReadBasic", "offline_access", "User.Read"].join(" ");

function getClientCredentials() {
  const clientId = process.env.MICROSOFT_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("MICROSOFT_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI must be set to use Outlook integration");
  }
  return { clientId, clientSecret, redirectUri };
}

export function getOutlookAuthUrl(state) {
  const { clientId, redirectUri } = getClientCredentials();
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

async function requestToken(body) {
  const response = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function exchangeOutlookCode(code) {
  const { clientId, clientSecret, redirectUri } = getClientCredentials();
  const tokens = await requestToken({
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

async function getValidAccessToken(accessToken, refreshToken) {
  if (!refreshToken) return accessToken;
  const { clientId, clientSecret } = getClientCredentials();
  const refreshed = await requestToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });
  return refreshed.access_token;
}

async function graphFetch(accessToken, path, init) {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Microsoft Graph request to ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

export async function getOutlookUserEmail(accessToken, refreshToken) {
  const token = await getValidAccessToken(accessToken, refreshToken);
  const response = await graphFetch(token, "/me?$select=mail,userPrincipalName");
  const data = await response.json();
  const email = data.mail ?? data.userPrincipalName;
  if (!email) throw new Error("Graph /me did not return an email address");
  return email;
}

export async function sendOutlookEmail(accessToken, refreshToken, input) {
  const token = await getValidAccessToken(accessToken, refreshToken);
  const draftBody = {
    subject: input.subject,
    body: { contentType: "HTML", content: input.bodyHtml },
    toRecipients: [{ emailAddress: { address: input.to } }],
  };
  const createResponse = await graphFetch(token, "/me/messages", {
    method: "POST",
    body: JSON.stringify(draftBody),
  });
  const draft = await createResponse.json();
  await graphFetch(token, `/me/messages/${draft.id}/send`, { method: "POST" });
  return { providerMessageId: draft.id, providerThreadId: draft.conversationId };
}

export async function getBrokerRepliesInConversation(accessToken, refreshToken, conversationId, brokerEmail) {
  const token = await getValidAccessToken(accessToken, refreshToken);
  const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
  const response = await graphFetch(
    token,
    `/me/messages?$filter=${filter}&$select=from,bodyPreview,receivedDateTime,id&$orderby=receivedDateTime asc&$top=50`
  );
  const data = await response.json();
  const brokerNeedle = brokerEmail.toLowerCase();
  return (data.value ?? [])
    .filter((msg) => (msg.from?.emailAddress?.address ?? "").toLowerCase().includes(brokerNeedle))
    .map((msg) => ({
      providerMessageId: msg.id,
      fromAddress: msg.from?.emailAddress?.address ?? brokerEmail,
      snippet: msg.bodyPreview ?? "",
      receivedAt: new Date(msg.receivedDateTime ?? Date.now()),
    }));
}

export async function createOutlookSubscription(accessToken, refreshToken, clientState) {
  const token = await getValidAccessToken(accessToken, refreshToken);
  const notificationUrl = process.env.MICROSOFT_GRAPH_WEBHOOK_URL;
  if (!notificationUrl) throw new Error("MICROSOFT_GRAPH_WEBHOOK_URL must be set to enable Outlook reply tracking");
  const expirationDateTime = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();
  const response = await graphFetch(token, "/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource: "me/mailFolders('Inbox')/messages",
      expirationDateTime,
      clientState,
    }),
  });
  return response.json();
}
