import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = "cs_session";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function toPublicUser(user) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name ?? null,
    signalEnabled: user.signalEnabled === true,
    isBanned: user.isBanned === true,
  };
}

export async function findUserByEmail(email) {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const user = await db.collection("users").findOne({ email: normalized });
  return user ?? null;
}

/** @deprecated Dev-only helper — do not use for production login */
export async function findOrCreateUserByEmail(email) {
  const db = getDb();
  const users = db.collection("users");
  const normalized = normalizeEmail(email);
  const existing = await users.findOne({ email: normalized });
  if (existing) return { id: String(existing._id), email: existing.email };

  const now = new Date();
  const result = await users.insertOne({ email: normalized, createdAt: now, updatedAt: now });
  return { id: String(result.insertedId), email: normalized };
}

export async function syncUserFromDatGo({
  datGoUserId,
  email,
  name,
  password,
  signalEnabled,
  isBanned,
}) {
  const db = getDb();
  const users = db.collection("users");
  const normalized = normalizeEmail(email);
  const now = new Date();

  const update = {
    email: normalized,
    name: name?.trim() || undefined,
    datGoUserId,
    signalEnabled: signalEnabled === true,
    isBanned: isBanned === true,
    updatedAt: now,
  };

  if (password) {
    update.passwordHash = await hashPassword(password);
  }

  const existing =
    (await users.findOne({ datGoUserId })) ??
    (await users.findOne({ email: normalized }));

  if (existing) {
    await users.updateOne({ _id: existing._id }, { $set: update });
    const updated = await users.findOne({ _id: existing._id });
    return toPublicUser(updated);
  }

  if (!password) {
    throw Object.assign(new Error("password is required when creating a new Signal user"), { status: 400 });
  }

  const result = await users.insertOne({
    ...update,
    passwordHash: update.passwordHash,
    createdAt: now,
  });

  const created = await users.findOne({ _id: result.insertedId });
  return toPublicUser(created);
}

export async function loginWithPassword(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    throw Object.assign(new Error("Invalid email or password"), { status: 401 });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error("Invalid email or password"), { status: 401 });
  }

  if (user.isBanned) {
    throw Object.assign(new Error("Your account has been suspended. Contact Dat Go support."), { status: 403 });
  }

  if (!user.signalEnabled) {
    throw Object.assign(
      new Error("Signal access is not enabled for your account. Ask your administrator to enable it."),
      { status: 403 }
    );
  }

  return toPublicUser(user);
}

export async function createSession(userId, userAgent) {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.collection("sessions").insertOne({
    tokenHash,
    userId,
    userAgent: userAgent ?? null,
    expiresAt,
    createdAt: new Date(),
  });

  return { token, expiresAt };
}

export async function revokeSession(token) {
  if (!token) return;
  const db = getDb();
  await db.collection("sessions").deleteOne({ tokenHash: hashToken(token) });
}

export async function validateSession(token) {
  if (!token) return null;
  const db = getDb();
  const session = await db.collection("sessions").findOne({ tokenHash: hashToken(token) });
  if (!session || session.expiresAt < new Date()) return null;

  const user = await db.collection("users").findOne({ _id: new ObjectId(session.userId) });
  if (!user) return null;

  if (user.isBanned || !user.signalEnabled) return null;

  return toPublicUser(user);
}
