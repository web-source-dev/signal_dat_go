const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const WATCH_URL = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
const SCOPE = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.metadata",
  "email",
].join(" ");

function getCredentials() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    process.env.GMAIL_REDIRECT_URI ??
    "http://localhost:3005/api/auth/gmail/callback";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID/SECRET must be set to use Gmail integration");
  }
  return { clientId, clientSecret, redirectUri };
}

async function tokenRequest(body) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = [data.error, data.error_description].filter(Boolean).join(": ") || response.status;
    throw new Error(`Gmail token request failed: ${detail}`);
  }
  return data;
}

export function getGmailAuthUrl(state) {
  const { clientId, redirectUri } = getCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeGmailCode(code) {
  const { clientId, clientSecret, redirectUri } = getCredentials();
  const data = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

export async function getGmailUserEmail(accessToken) {
  const response = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Gmail profile request failed: ${response.status}`);
  const data = await response.json();
  if (!data.email) throw new Error("Gmail profile did not return an email address");
  return data.email;
}

/** Refresh access token when expired (or within 60s of expiry). */
export async function ensureFreshAccessToken(tokens) {
  const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt) : null;
  const stillValid = expiresAt && expiresAt.getTime() > Date.now() + 60_000;
  if (stillValid || !tokens.refreshToken) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: expiresAt,
    };
  }

  const { clientId, clientSecret } = getCredentials();
  const data = await tokenRequest({
    refresh_token: tokens.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

function headerValue(headers, name) {
  return headers?.find((row) => row.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Returns every broker message in a Gmail thread (not just the latest). */
export async function getBrokerRepliesInThread(accessToken, threadId, brokerEmail) {
  const response = await fetch(
    `${THREADS_URL}/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) return [];

  const data = await response.json();
  const messages = data.messages ?? [];
  if (messages.length < 2) return [];

  const brokerNeedle = brokerEmail.toLowerCase();
  const replies = [];
  for (const message of messages) {
    const from = headerValue(message.payload?.headers, "From");
    if (!from.toLowerCase().includes(brokerNeedle)) continue;
    replies.push({
      providerMessageId: message.id,
      fromAddress: from,
      snippet: message.snippet ?? data.snippet ?? "",
      receivedAt: new Date(Number(message.internalDate) || Date.now()),
    });
  }
  return replies;
}

/** @deprecated use getBrokerRepliesInThread */
export async function getLatestBrokerReply(accessToken, threadId, brokerEmail) {
  const replies = await getBrokerRepliesInThread(accessToken, threadId, brokerEmail);
  return replies[replies.length - 1] ?? null;
}

function buildRawGmailMessage(to, from, input) {
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

export async function sendGmailEmail(accessToken, refreshToken, fromEmail, input) {
  const raw = buildRawGmailMessage(input.to, fromEmail, input);
  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw, threadId: input.threadId }),
  });
  if (!response.ok) {
    throw new Error(`Gmail send failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.id || !data.threadId) throw new Error("Gmail send did not return a message/thread id");
  return { providerMessageId: data.id, providerThreadId: data.threadId };
}

export async function watchGmailMailbox(accessToken) {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topicName) throw new Error("GMAIL_PUBSUB_TOPIC must be set to enable Gmail reply tracking");
  const response = await fetch(WATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topicName, labelIds: ["INBOX"] }),
  });
  if (!response.ok) {
    throw new Error(`Gmail watch failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.historyId) throw new Error("Gmail watch did not return a historyId");
  return data.historyId;
}
