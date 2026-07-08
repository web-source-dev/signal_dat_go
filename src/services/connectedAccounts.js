import { getDb } from "../db/mongo.js";
import { decryptToken, encryptToken } from "../crypto/tokenCipher.js";
import { ensureFreshAccessToken } from "./gmail.js";
import { inferImapFromSmtp } from "./smtpImap.js";
import { verifyImapConnection } from "./smtpImapVerify.js";

export async function upsertTokens(userId, provider, tokens, opts = {}) {
  const db = getDb();
  const data = {
    userId,
    provider,
    status: "ACTIVE",
    accessTokenEncrypted: encryptToken(tokens.accessToken),
    refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresAt,
    providerAccountEmail: opts.providerAccountEmail ?? null,
    providerMetadata: opts.providerMetadata ?? null,
    scope: opts.scope ?? null,
    lastError: null,
    updatedAt: new Date(),
  };

  await db.collection("connectedAccounts").updateOne(
    { userId, provider },
    { $set: data, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}

export async function getDecryptedTokens(userId, provider) {
  const db = getDb();
  const account = await db.collection("connectedAccounts").findOne({ userId, provider });
  if (!account?.accessTokenEncrypted) return null;

  return {
    accessToken: decryptToken(account.accessTokenEncrypted),
    refreshToken: account.refreshTokenEncrypted ? decryptToken(account.refreshTokenEncrypted) : null,
    expiresAt: account.tokenExpiresAt ?? null,
    providerAccountEmail: account.providerAccountEmail ?? null,
    providerMetadata: account.providerMetadata ?? null,
  };
}

export async function ensureSmtpImapConfig(userId) {
  const tokens = await getDecryptedTokens(userId, "SMTP");
  if (!tokens?.accessToken || !tokens.providerAccountEmail) return null;

  const meta = tokens.providerMetadata ?? {};
  if (!meta.smtpHost || !meta.smtpPort) return null;
  if (meta.imapHost) {
    return {
      email: tokens.providerAccountEmail,
      password: tokens.accessToken,
      smtpHost: meta.smtpHost,
      smtpPort: meta.smtpPort,
      smtpSecure: Boolean(meta.smtpSecure),
      imapHost: meta.imapHost,
      imapPort: meta.imapPort ?? 993,
      imapSecure: meta.imapSecure !== false,
    };
  }

  const email = tokens.providerAccountEmail;
  const password = tokens.accessToken;
  const candidates = [
    inferImapFromSmtp(meta.smtpHost, email),
    { imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true },
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await verifyImapConnection({ email, password, ...candidate });
      await setProviderMetadata(userId, "SMTP", {
        ...meta,
        imapHost: candidate.imapHost,
        imapPort: candidate.imapPort,
        imapSecure: candidate.imapSecure !== false,
      });
      return {
        email,
        password,
        smtpHost: meta.smtpHost,
        smtpPort: meta.smtpPort,
        smtpSecure: Boolean(meta.smtpSecure),
        imapHost: candidate.imapHost,
        imapPort: candidate.imapPort,
        imapSecure: candidate.imapSecure !== false,
      };
    } catch {
      // try next candidate
    }
  }

  return {
    email,
    password,
    smtpHost: meta.smtpHost,
    smtpPort: meta.smtpPort,
    smtpSecure: Boolean(meta.smtpSecure),
    imapHost: candidates[0]?.imapHost ?? null,
    imapPort: candidates[0]?.imapPort ?? 993,
    imapSecure: candidates[0]?.imapSecure !== false,
  };
}

export async function getSmtpConfig(userId) {
  return ensureSmtpImapConfig(userId);
}

export async function upsertSmtpAccount(userId, { email, password, smtpHost, smtpPort, smtpSecure, imapHost, imapPort, imapSecure }) {
  await upsertTokens(
    userId,
    "SMTP",
    { accessToken: password, refreshToken: null, expiresAt: null },
    {
      providerAccountEmail: email,
      providerMetadata: {
        smtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure: Boolean(smtpSecure),
        imapHost: imapHost ?? null,
        imapPort: imapPort ?? null,
        imapSecure: imapSecure !== false,
      },
    }
  );
}

export async function disconnectProvider(userId, provider) {
  const db = getDb();
  await db.collection("connectedAccounts").deleteOne({ userId, provider });
}

export async function getValidGmailTokens(userId) {
  const tokens = await getDecryptedTokens(userId, "GMAIL");
  if (!tokens) return null;

  const fresh = await ensureFreshAccessToken(tokens);
  if (fresh.accessToken !== tokens.accessToken || fresh.expiresAt !== tokens.expiresAt) {
    await upsertTokens(userId, "GMAIL", fresh, { providerAccountEmail: tokens.providerAccountEmail ?? undefined });
  }
  return { ...tokens, ...fresh };
}

export async function setProviderMetadata(userId, provider, metadata) {
  const db = getDb();
  await db.collection("connectedAccounts").updateOne(
    { userId, provider },
    { $set: { providerMetadata: metadata, updatedAt: new Date() } }
  );
}

export async function recordError(userId, provider, message) {
  const db = getDb();
  await db.collection("connectedAccounts").updateOne(
    { userId, provider },
    { $set: { status: "ERROR", lastError: message, updatedAt: new Date() } }
  );
}

export async function listForUser(userId) {
  const db = getDb();
  const rows = await db.collection("connectedAccounts").find({ userId }).toArray();
  return rows.map((row) => ({
    provider: row.provider,
    status: row.status ?? "ACTIVE",
    email: row.providerAccountEmail ?? null,
    lastError: row.lastError ?? null,
    updatedAt: row.updatedAt ?? null,
  }));
}
