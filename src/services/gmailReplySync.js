import { getDb } from "../db/mongo.js";
import * as connectedAccounts from "./connectedAccounts.js";
import * as gmail from "./gmail.js";
import { listAwaitingReply, recordReply } from "./outreach.js";
import { publishNotification } from "./notifications.js";

let syncTimer = null;

export async function syncGmailRepliesForUser(userId) {
  const tokens = await connectedAccounts.getValidGmailTokens(userId);
  if (!tokens) return;

  const threads = await listAwaitingReply(userId, "GMAIL");
  for (const thread of threads) {
    if (!thread.providerThreadId || !thread.brokerEmail) continue;

    const reply = await gmail.getLatestBrokerReply(
      tokens.accessToken,
      thread.providerThreadId,
      thread.brokerEmail
    );
    if (!reply) continue;

    const result = await recordReply(String(thread._id), reply);
    if (!result) continue;

    publishNotification(userId, {
      type: "NEW_REPLY",
      loadRef: result.loadRef,
      outreachThreadId: result.outreachThreadId,
    });
  }
}

export async function syncAllGmailReplies() {
  const db = getDb();
  const accounts = await db.collection("connectedAccounts").find({ provider: "GMAIL", status: "ACTIVE" }).toArray();
  const userIds = [...new Set(accounts.map((row) => row.userId))];
  for (const userId of userIds) {
    try {
      await syncGmailRepliesForUser(userId);
    } catch (error) {
      console.warn("[cargosignal-api] gmail reply sync failed for", userId, error.message);
    }
  }
}

export function startGmailReplySync(intervalMs = 90_000) {
  if (syncTimer) return;
  void syncAllGmailReplies();
  syncTimer = setInterval(() => {
    void syncAllGmailReplies();
  }, intervalMs);
}
