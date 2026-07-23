import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";
import { suggestReply } from "./ai.js";
import { getUserPreferences } from "./userPreferences.js";
import { sendOutboundEmail } from "./outboundEmail.js";
import { publishNotification } from "./notifications.js";

function replySubject(subject) {
  const trimmed = String(subject || "").trim();
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed || "your load"}`;
}

function toHtmlBody(text) {
  const plain = String(text || "").trim();
  if (!plain) return "";
  if (plain.includes("<")) return plain;
  return `<p>${plain.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

function buildConversation(thread) {
  const sent = (thread.sentEmails ?? [])
    .filter((email) => email.bodySnippet)
    .map((email) => ({
      role: "you",
      text: email.bodySnippet,
      at: email.sentAt ? new Date(email.sentAt).getTime() : 0,
    }));
  const received = (thread.replies ?? [])
    .filter((reply) => reply.snippet)
    .map((reply) => ({
      role: "broker",
      text: reply.snippet,
      at: reply.receivedAt ? new Date(reply.receivedAt).getTime() : 0,
    }));
  return [...sent, ...received]
    .sort((a, b) => a.at - b.at)
    .map(({ role, text }) => ({ role, text }));
}

function needsHumanReview(suggestion) {
  // Skip auto-send when the model left fill-in brackets.
  return /\[[^\]]{2,}\]/.test(String(suggestion || ""));
}

/**
 * If Auto AI Reply is enabled for this user, draft + send a reply to a newly
 * recorded broker message. Safe to call fire-and-forget.
 */
export async function maybeAutoAiReply({ userId, outreachThreadId, reply }) {
  if (!userId || !outreachThreadId || !reply?.providerMessageId) return { sent: false, reason: "missing-input" };

  try {
    const prefs = await getUserPreferences(userId);
    if (!prefs.autoAiReplyEnabled) return { sent: false, reason: "disabled" };

    const db = getDb();
    const coll = db.collection("outreachThreads");
    const thread = await coll.findOne({ _id: new ObjectId(outreachThreadId), userId });
    if (!thread) return { sent: false, reason: "thread-missing" };
    if (!thread.brokerEmail) return { sent: false, reason: "no-broker-email" };

    const already = (thread.autoAiRepliedTo ?? []).includes(reply.providerMessageId);
    if (already) return { sent: false, reason: "already-replied" };

    // Claim this inbound message before calling the model / sending, to avoid
    // duplicate auto-replies when sync overlaps.
    const claim = await coll.updateOne(
      {
        _id: thread._id,
        autoAiRepliedTo: { $ne: reply.providerMessageId },
      },
      {
        $addToSet: { autoAiRepliedTo: reply.providerMessageId },
        $set: { updatedAt: new Date() },
      }
    );
    if (claim.modifiedCount === 0) return { sent: false, reason: "already-claimed" };

    const conversation = buildConversation({
      ...thread,
      replies: [...(thread.replies ?? []), reply],
    });

    const suggestion = await suggestReply({
      conversation,
      brokerEmailBody: reply.snippet || "",
      subject: thread.subject,
      loadContext: thread.loadRef ? { loadRef: thread.loadRef } : undefined,
      tone: "professional",
      autoSend: true,
    });

    if (!suggestion?.trim()) {
      console.warn("[auto-ai-reply] empty suggestion for", outreachThreadId);
      return { sent: false, reason: "empty-suggestion" };
    }

    if (needsHumanReview(suggestion)) {
      console.warn("[auto-ai-reply] suggestion needs human review — not auto-sending", outreachThreadId);
      publishNotification(userId, {
        type: "NEW_REPLY",
        loadRef: thread.loadRef ?? null,
        outreachThreadId,
        detail: "Auto AI Reply drafted a response that needs your review (missing details).",
      });
      return { sent: false, reason: "needs-review" };
    }

    const bodyHtml = toHtmlBody(suggestion);
    const inReplyToMessageId =
      reply.providerMessageId ||
      thread.sentEmails?.[thread.sentEmails.length - 1]?.providerMessageId ||
      null;

    await sendOutboundEmail(userId, {
      accountId: thread.connectedAccountId ?? undefined,
      provider: thread.provider,
      to: thread.brokerEmail,
      subject: replySubject(thread.subject),
      bodyHtml,
      loadRef: thread.loadRef ?? null,
      outreachThreadId: String(thread._id),
      threadId: thread.providerThreadId ?? undefined,
      inReplyToMessageId,
      aiGenerated: true,
    });

    publishNotification(userId, {
      type: "AUTO_AI_REPLY_SENT",
      loadRef: thread.loadRef ?? null,
      outreachThreadId: String(thread._id),
    });

    console.log("[auto-ai-reply] sent for thread", outreachThreadId, "reply", reply.providerMessageId);
    return { sent: true };
  } catch (error) {
    console.error("[auto-ai-reply] failed", {
      userId,
      outreachThreadId,
      message: error.message,
      code: error.code,
    });
    return { sent: false, reason: error.message };
  }
}
