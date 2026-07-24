import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";

const COLLECTION = "savedFilters";
const DEFAULT_COLOR = "#f7a84b";

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeFilter(raw, userId) {
  if (!raw || typeof raw !== "object") return null;

  // Accept either `id` or `filterId` from clients.
  const id = String(raw.id ?? raw.filterId ?? "").trim();
  const label = String(raw.label ?? raw.name ?? "").trim();
  if (!id || !label) {
    console.warn("[savedFilters] skipping invalid filter", { id, label: raw.label });
    return null;
  }

  const color =
    typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : DEFAULT_COLOR;

  const nowIso = new Date().toISOString();
  return {
    userId: String(userId),
    filterId: id,
    id,
    boardId: String(raw.boardId ?? "dat-one"),
    tabId: String(raw.tabId ?? "*"),
    label,
    minDistanceMiles: toNumberOrNull(raw.minDistanceMiles),
    maxDistanceMiles: toNumberOrNull(raw.maxDistanceMiles),
    minRateTotal: toNumberOrNull(raw.minRateTotal),
    minRatePerMile: toNumberOrNull(raw.minRatePerMile),
    maxAgeSeconds: toNumberOrNull(raw.maxAgeSeconds),
    originLocations: Array.isArray(raw.originLocations) ? raw.originLocations.map(String).filter(Boolean) : [],
    destLocations: Array.isArray(raw.destLocations) ? raw.destLocations.map(String).filter(Boolean) : [],
    excludedStates: Array.isArray(raw.excludedStates)
      ? raw.excludedStates.map((s) => String(s).toUpperCase()).filter((s) => s.length >= 2).map((s) => s.slice(0, 2))
      : [],
    notifyOn: raw.notifyOn === "rate-increase" ? "rate-increase" : "any",
    color,
    highlightRows: raw.highlightRows === false ? false : true,
    autoReachEnabled: raw.autoReachEnabled === false ? false : true,
    templateId:
      typeof raw.templateId === "string" && raw.templateId.trim() ? String(raw.templateId).trim() : null,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : nowIso,
    updatedAt: new Date(),
  };
}

function toClientFilter(doc) {
  return {
    id: String(doc.filterId ?? doc.id),
    boardId: doc.boardId ?? "dat-one",
    tabId: doc.tabId ?? "*",
    label: doc.label,
    minDistanceMiles: doc.minDistanceMiles ?? null,
    maxDistanceMiles: doc.maxDistanceMiles ?? null,
    minRateTotal: doc.minRateTotal ?? null,
    minRatePerMile: doc.minRatePerMile ?? null,
    maxAgeSeconds: doc.maxAgeSeconds ?? null,
    originLocations: doc.originLocations ?? [],
    destLocations: doc.destLocations ?? [],
    excludedStates: doc.excludedStates ?? [],
    notifyOn: doc.notifyOn === "rate-increase" ? "rate-increase" : "any",
    color: doc.color ?? DEFAULT_COLOR,
    highlightRows: doc.highlightRows === false ? false : true,
    autoReachEnabled: doc.autoReachEnabled === false ? false : true,
    templateId:
      typeof doc.templateId === "string" && doc.templateId.trim() ? String(doc.templateId).trim() : null,
    createdAt: doc.createdAt,
  };
}

async function stampFiltersUpdatedAt(userId) {
  try {
    const db = getDb();
    await db.collection("users").updateOne(
      { _id: new ObjectId(String(userId)) },
      { $set: { filtersUpdatedAt: new Date(), updatedAt: new Date() } }
    );
  } catch (error) {
    console.warn("[savedFilters] failed to stamp filtersUpdatedAt", error);
  }
}

export async function ensureFilterIndexes() {
  const db = getDb();
  await db.collection(COLLECTION).createIndex({ userId: 1, filterId: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ userId: 1 });
}

export async function listFiltersForUser(userId) {
  const db = getDb();
  const uid = String(userId);
  const rows = await db
    .collection(COLLECTION)
    .find({ userId: uid })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`[savedFilters] list user=${uid} count=${rows.length}`);
  return rows.map(toClientFilter);
}

/** Replace the user's entire filter set (source of truth for multi-device sync). */
export async function replaceFiltersForUser(userId, filters) {
  const db = getDb();
  const uid = String(userId);
  const seen = new Set();
  const normalized = [];

  for (const row of Array.isArray(filters) ? filters : []) {
    const item = normalizeFilter(row, uid);
    if (!item || seen.has(item.filterId)) continue;
    seen.add(item.filterId);
    normalized.push(item);
  }

  const col = db.collection(COLLECTION);
  await col.deleteMany({ userId: uid });

  if (normalized.length > 0) {
    await col.insertMany(normalized);
  }

  await stampFiltersUpdatedAt(uid);
  console.log(`[savedFilters] replace user=${uid} count=${normalized.length}`);
  return normalized.map(toClientFilter);
}
