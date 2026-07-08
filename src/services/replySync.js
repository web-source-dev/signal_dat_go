import { getDb } from "../db/mongo.js";
import * as connectedAccounts from "./connectedAccounts.js";
import * as gmail from "./gmail.js";
import * as outlook from "./outlook.js";
import { getSmtpBrokerReplies } from "./smtpImap.js";
import { listThreadsForProvider, recordReply } from "./outreach.js";
import { publishNotification } from "./notifications.js";

async function ingestReplies(thread, replies) {
  let recorded = 0;
  let lastResult = null;
  for (const reply of replies) {
    const result = await recordReply(String(thread._id), reply);
    if (!result) continue;
    recorded += 1;
    lastResult = result;
  }
  if (lastResult) {
    publishNotification(lastResult.userId, {
      type: "NEW_REPLY",
      loadRef: lastResult.loadRef,
      outreachThreadId: lastResult.outreachThreadId,
    });
  }
  return recorded;
}

export async function syncGmailRepliesForUser(userId) {
  const accounts = await connectedAccounts.listAccountsByProvider(userId, "GMAIL");
  if (accounts.length === 0) return { recorded: 0, error: null };

  const threads = await listThreadsForProvider(userId, "GMAIL");
  let recorded = 0;
  let lastError = null;

  for (const account of accounts) {
    const accountId = String(account._id);
    const tokens = await connectedAccounts.getValidGmailTokens(userId, null, accountId).catch((error) => {
      lastError = error instanceof Error ? error.message : "Gmail sync failed";
      return null;
    });
    if (!tokens) continue;

    for (const thread of threads) {
      if (!thread.providerThreadId || !thread.brokerEmail) continue;
      if (thread.connectedAccountId && thread.connectedAccountId !== accountId) continue;
      const replies = await gmail.getBrokerRepliesInThread(
        tokens.accessToken,
        thread.providerThreadId,
        thread.brokerEmail
      );
      recorded += await ingestReplies(thread, replies);
    }
  }

  return { recorded, error: lastError };
}

export async function syncOutlookRepliesForUser(userId) {
  const accounts = await connectedAccounts.listAccountsByProvider(userId, "OUTLOOK");
  if (accounts.length === 0) return { recorded: 0, error: null };

  const threads = await listThreadsForProvider(userId, "OUTLOOK");
  let recorded = 0;
  let lastError = null;

  for (const account of accounts) {
    const accountId = String(account._id);
    const tokens = await connectedAccounts.getDecryptedTokensForAccount(userId, accountId);
    if (!tokens) continue;

    for (const thread of threads) {
      if (!thread.providerThreadId || !thread.brokerEmail) continue;
      if (thread.connectedAccountId && thread.connectedAccountId !== accountId) continue;
      const replies = await outlook.getBrokerRepliesInConversation(
        tokens.accessToken,
        tokens.refreshToken,
        thread.providerThreadId,
        thread.brokerEmail
      );
      recorded += await ingestReplies(thread, replies);
    }
  }

  return { recorded, error: lastError };
}

export async function syncSmtpRepliesForUser(userId) {
  const accounts = await connectedAccounts.listAccountsByProvider(userId, "SMTP");
  if (accounts.length === 0) return { recorded: 0, error: null };

  const threads = await listThreadsForProvider(userId, "SMTP");
  let recorded = 0;
  let lastError = null;

  for (const account of accounts) {
    const accountId = String(account._id);
    const config = await connectedAccounts.getSmtpConfig(userId, accountId);
    if (!config) continue;

    try {
      for (const thread of threads) {
        if (!thread.brokerEmail) continue;
        if (thread.connectedAccountId && thread.connectedAccountId !== accountId) continue;
        const sentMessageIds = (thread.sentEmails ?? [])
          .map((row) => row.providerMessageId)
          .filter(Boolean);
        const since = thread.createdAt ? new Date(thread.createdAt) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const replies = await getSmtpBrokerReplies(config, {
          brokerEmail: thread.brokerEmail,
          subject: thread.subject,
          since,
          sentMessageIds,
          mailboxEmail: config.email,
        });
        recorded += await ingestReplies(thread, replies);
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? `SMTP inbox sync failed (${config.imapHost ?? config.smtpHost}): ${error.message}. Enable IMAP in your mailbox settings and reconnect SMTP.`
          : "SMTP inbox sync failed";
    }
  }

  return { recorded, error: lastError };
}

export async function syncAllRepliesForUser(userId) {
  const warnings = [];
  let imported = 0;

  const gmailResult = await syncGmailRepliesForUser(userId).catch((error) => ({
    recorded: 0,
    error: error instanceof Error ? error.message : "Gmail sync failed",
  }));
  imported += gmailResult.recorded;
  if (gmailResult.error) warnings.push(gmailResult.error);

  const outlookResult = await syncOutlookRepliesForUser(userId).catch((error) => ({
    recorded: 0,
    error: error instanceof Error ? error.message : "Outlook sync failed",
  }));
  imported += outlookResult.recorded;
  if (outlookResult.error) warnings.push(outlookResult.error);

  const smtpResult = await syncSmtpRepliesForUser(userId);
  imported += smtpResult.recorded;
  if (smtpResult.error) warnings.push(smtpResult.error);

  return { imported, warnings };
}

export async function syncAllReplies() {
  const db = getDb();
  const accounts = await db.collection("connectedAccounts").find({ status: "ACTIVE" }).toArray();
  const userIds = [...new Set(accounts.map((row) => row.userId))];
  for (const userId of userIds) {
    try {
      await syncAllRepliesForUser(userId);
    } catch (error) {
      console.warn("[cargosignal-api] reply sync failed for", userId, error.message);
    }
  }
}

let syncTimer = null;

export function startReplySync(intervalMs = 90_000) {
  if (syncTimer) return;
  void syncAllReplies();
  syncTimer = setInterval(() => {
    void syncAllReplies();
  }, intervalMs);
}

export const startGmailReplySync = startReplySync;
