import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";

function toThreadResponse(doc) {
  return {
    id: String(doc._id),
    userId: doc.userId,
    loadRef: doc.loadRef ?? null,
    provider: doc.provider,
    connectedAccountId: doc.connectedAccountId ?? null,
    providerThreadId: doc.providerThreadId,
    subject: doc.subject,
    brokerEmail: doc.brokerEmail,
    status: doc.status,
    lastActivityAt: doc.lastActivityAt,
    createdAt: doc.createdAt,
    sentEmails: (doc.sentEmails ?? []).map((row) => ({
      id: row.id,
      outreachThreadId: String(doc._id),
      providerMessageId: row.providerMessageId,
      bodySnippet: row.bodySnippet,
      aiGenerated: row.aiGenerated ?? false,
      sentAt: row.sentAt,
    })),
    replies: (doc.replies ?? []).map((row) => ({
      id: row.id,
      outreachThreadId: String(doc._id),
      providerMessageId: row.providerMessageId,
      fromAddress: row.fromAddress,
      snippet: row.snippet,
      receivedAt: row.receivedAt,
    })),
  };
}

export async function listForUser(userId) {
  const db = getDb();
  const rows = await db
    .collection("outreachThreads")
    .find({ userId })
    .sort({ lastActivityAt: -1 })
    .toArray();
  return rows.map(toThreadResponse);
}

export async function recordSentEmail(userId, input) {
  const db = getDb();
  const now = new Date();
  const coll = db.collection("outreachThreads");

  let existing = null;
  if (input.outreachThreadId) {
    try {
      existing = await coll.findOne({ _id: new ObjectId(input.outreachThreadId), userId });
    } catch {
      existing = null;
    }
  }
  if (!existing && input.providerThreadId) {
    existing = await coll.findOne({
      userId,
      provider: input.provider,
      providerThreadId: input.providerThreadId,
    });
  }

  const sentEmail = {
    id: new ObjectId().toString(),
    providerMessageId: input.providerMessageId,
    bodySnippet: input.bodySnippet,
    aiGenerated: input.aiGenerated ?? false,
    sentAt: now,
  };

  if (existing) {
    await coll.updateOne(
      { _id: existing._id },
      {
        $set: { status: "SENT", lastActivityAt: now },
        $push: { sentEmails: sentEmail },
      }
    );
    const updated = await coll.findOne({ _id: existing._id });
    return toThreadResponse(updated);
  }

  const doc = {
    userId,
    loadRef: input.loadRef ?? null,
    provider: input.provider,
    connectedAccountId: input.connectedAccountId ?? null,
    providerThreadId: input.providerThreadId,
    subject: input.subject,
    brokerEmail: input.brokerEmail,
    status: "SENT",
    lastActivityAt: now,
    createdAt: now,
    sentEmails: [sentEmail],
    replies: [],
  };

  const result = await coll.insertOne(doc);
  return toThreadResponse({ ...doc, _id: result.insertedId });
}

export async function recordReply(outreachThreadId, input) {
  const db = getDb();
  const coll = db.collection("outreachThreads");
  const objectId = new ObjectId(outreachThreadId);
  const existing = await coll.findOne({ _id: objectId });
  if (!existing) return null;

  const alreadyRecorded = (existing.replies ?? []).find(
    (row) => row.providerMessageId === input.providerMessageId
  );
  if (alreadyRecorded) {
    // Self-heal: earlier syncs may have stored a raw/garbled snippet
    if (input.snippet && input.snippet !== alreadyRecorded.snippet) {
      await coll.updateOne(
        { _id: objectId, "replies.id": alreadyRecorded.id },
        { $set: { "replies.$.snippet": input.snippet } }
      );
    }
    return null;
  }

  const reply = {
    id: new ObjectId().toString(),
    providerMessageId: input.providerMessageId,
    fromAddress: input.fromAddress,
    snippet: input.snippet,
    receivedAt: input.receivedAt,
  };

  await coll.updateOne(
    { _id: objectId },
    {
      $set: { status: "REPLIED", lastActivityAt: input.receivedAt },
      $push: { replies: reply },
    }
  );

  return {
    userId: existing.userId,
    loadRef: existing.loadRef ?? null,
    outreachThreadId,
  };
}

export async function listThreadsForProvider(userId, provider) {
  const db = getDb();
  return db.collection("outreachThreads").find({ userId, provider }).toArray();
}

export async function listAwaitingReply(userId, provider = "GMAIL") {
  const db = getDb();
  return db
    .collection("outreachThreads")
    .find({ userId, provider, status: { $in: ["SENT", "NO_RESPONSE", "REPLIED"] } })
    .toArray();
}
