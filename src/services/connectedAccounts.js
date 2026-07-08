import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";
import { decryptToken, encryptToken } from "../crypto/tokenCipher.js";
import { ensureFreshAccessToken } from "./gmail.js";
import { inferImapFromSmtp } from "./smtpImap.js";
import { verifyImapConnection } from "./smtpImapVerify.js";

function normalizeAccountEmail(email) {
  return email?.trim().toLowerCase() ?? null;
}

function toPublicAccount(row) {
  return {
    id: String(row._id),
    provider: row.provider,
    status: row.status ?? "ACTIVE",
    email: row.providerAccountEmail ?? null,
    lastError: row.lastError ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function ensureIndexes() {
  const db = getDb();
  await db.collection("connectedAccounts").createIndex(
    { userId: 1, provider: 1, providerAccountEmail: 1 },
    { unique: true, name: "user_provider_email_unique" }
  );
  await db.collection("connectedAccounts").createIndex({ userId: 1 });
}

export async function upsertTokens(userId, provider, tokens, opts = {}) {
  const email = normalizeAccountEmail(opts.providerAccountEmail);
  if (!email) {
    throw Object.assign(new Error("providerAccountEmail is required"), { status: 400 });
  }

  const db = getDb();
  const data = {
    userId,
    provider,
    status: "ACTIVE",
    accessTokenEncrypted: encryptToken(tokens.accessToken),
    refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresAt,
    providerAccountEmail: email,
    providerMetadata: opts.providerMetadata ?? null,
    scope: opts.scope ?? null,
    lastError: null,
    updatedAt: new Date(),
  };

  await db.collection("connectedAccounts").updateOne(
    { userId, provider, providerAccountEmail: email },
    { $set: data, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}

export async function getAccountById(userId, accountId) {
  const db = getDb();
  try {
    return await db.collection("connectedAccounts").findOne({
      _id: new ObjectId(accountId),
      userId,
    });
  } catch {
    return null;
  }
}

export async function getDecryptedTokens(userId, provider, email = null) {
  const db = getDb();
  const filter = { userId, provider };
  if (email) filter.providerAccountEmail = normalizeAccountEmail(email);

  const account = email
    ? await db.collection("connectedAccounts").findOne(filter)
    : await db.collection("connectedAccounts").findOne(
        { userId, provider, status: { $ne: "ERROR" } },
        { sort: { updatedAt: -1 } }
      );

  if (!account?.accessTokenEncrypted) return null;

  return {
    accountId: String(account._id),
    accessToken: decryptToken(account.accessTokenEncrypted),
    refreshToken: account.refreshTokenEncrypted ? decryptToken(account.refreshTokenEncrypted) : null,
    expiresAt: account.tokenExpiresAt ?? null,
    providerAccountEmail: account.providerAccountEmail ?? null,
    providerMetadata: account.providerMetadata ?? null,
  };
}

export async function getDecryptedTokensForAccount(userId, accountId) {
  const account = await getAccountById(userId, accountId);
  if (!account?.accessTokenEncrypted) return null;

  return {
    accountId: String(account._id),
    provider: account.provider,
    accessToken: decryptToken(account.accessTokenEncrypted),
    refreshToken: account.refreshTokenEncrypted ? decryptToken(account.refreshTokenEncrypted) : null,
    expiresAt: account.tokenExpiresAt ?? null,
    providerAccountEmail: account.providerAccountEmail ?? null,
    providerMetadata: account.providerMetadata ?? null,
  };
}

export async function ensureSmtpImapConfig(userId, accountId = null) {
  const tokens = accountId
    ? await getDecryptedTokensForAccount(userId, accountId)
    : await getDecryptedTokens(userId, "SMTP");
  if (!tokens?.accessToken || !tokens.providerAccountEmail) return null;

  const meta = tokens.providerMetadata ?? {};
  if (!meta.smtpHost || !meta.smtpPort) return null;
  if (meta.imapHost) {
    return {
      accountId: tokens.accountId,
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
      await setProviderMetadata(userId, tokens.provider, {
        ...meta,
        imapHost: candidate.imapHost,
        imapPort: candidate.imapPort,
        imapSecure: candidate.imapSecure !== false,
      }, email);
      return {
        accountId: tokens.accountId,
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
    accountId: tokens.accountId,
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

export async function getSmtpConfig(userId, accountId = null) {
  return ensureSmtpImapConfig(userId, accountId);
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

export async function disconnectAccount(userId, accountId) {
  const db = getDb();
  const result = await db.collection("connectedAccounts").deleteOne({
    _id: new ObjectId(accountId),
    userId,
  });
  return result.deletedCount > 0;
}

/** @deprecated Use disconnectAccount */
export async function disconnectProvider(userId, provider, email = null) {
  const db = getDb();
  const filter = { userId, provider };
  if (email) filter.providerAccountEmail = normalizeAccountEmail(email);
  const result = await db.collection("connectedAccounts").deleteOne(filter);
  return result.deletedCount > 0;
}

export async function getValidGmailTokens(userId, email = null, accountId = null) {
  const tokens = accountId
    ? await getDecryptedTokensForAccount(userId, accountId)
    : await getDecryptedTokens(userId, "GMAIL", email);
  if (!tokens) return null;

  const fresh = await ensureFreshAccessToken(tokens);
  if (fresh.accessToken !== tokens.accessToken || fresh.expiresAt !== tokens.expiresAt) {
    await upsertTokens(userId, "GMAIL", fresh, {
      providerAccountEmail: tokens.providerAccountEmail ?? undefined,
    });
  }
  return { ...tokens, ...fresh };
}

export async function setProviderMetadata(userId, provider, metadata, email = null) {
  const db = getDb();
  const filter = { userId, provider };
  if (email) filter.providerAccountEmail = normalizeAccountEmail(email);

  await db.collection("connectedAccounts").updateOne(filter, {
    $set: { providerMetadata: metadata, updatedAt: new Date() },
  });
}

export async function recordError(userId, provider, message, email = null) {
  const db = getDb();
  const filter = { userId, provider };
  if (email) filter.providerAccountEmail = normalizeAccountEmail(email);

  await db.collection("connectedAccounts").updateOne(filter, {
    $set: { status: "ERROR", lastError: message, updatedAt: new Date() },
  });
}

export async function listForUser(userId) {
  const db = getDb();
  const rows = await db
    .collection("connectedAccounts")
    .find({ userId })
    .sort({ provider: 1, providerAccountEmail: 1 })
    .toArray();
  return rows.map(toPublicAccount);
}

export async function listAccountsByProvider(userId, provider) {
  const db = getDb();
  const rows = await db
    .collection("connectedAccounts")
    .find({ userId, provider, status: { $ne: "ERROR" } })
    .sort({ updatedAt: -1 })
    .toArray();
  return rows;
}
