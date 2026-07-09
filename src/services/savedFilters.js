import { getDb } from "../db/mongo.js";

const COLLECTION = "savedFilters";
const DEFAULT_COLOR = "#f7a84b";

function normalizeFilter(raw, userId) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const label = String(raw.label ?? "").trim();
  if (!id || !label) return null;

  const color =
    typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : DEFAULT_COLOR;

  return {
    userId: String(userId),
    filterId: id,
    id,
    boardId: String(raw.boardId ?? "dat-one"),
    tabId: String(raw.tabId ?? "*"),
    label,
    minDistanceMiles: raw.minDistanceMiles == null ? null : Number(raw.minDistanceMiles),
    maxDistanceMiles: raw.maxDistanceMiles == null ? null : Number(raw.maxDistanceMiles),
    minRateTotal: raw.minRateTotal == null ? null : Number(raw.minRateTotal),
    minRatePerMile: raw.minRatePerMile == null ? null : Number(raw.minRatePerMile),
    originLocations: Array.isArray(raw.originLocations) ? raw.originLocations.map(String) : [],
    destLocations: Array.isArray(raw.destLocations) ? raw.destLocations.map(String) : [],
    excludedStates: Array.isArray(raw.excludedStates) ? raw.excludedStates.map(String) : [],
    notifyOn: raw.notifyOn === "rate-increase" ? "rate-increase" : "any",
    color,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: new Date(),
  };
}

function toClientFilter(doc) {
  return {
    id: doc.filterId ?? doc.id,
    boardId: doc.boardId,
    tabId: doc.tabId,
    label: doc.label,
    minDistanceMiles: doc.minDistanceMiles ?? null,
    maxDistanceMiles: doc.maxDistanceMiles ?? null,
    minRateTotal: doc.minRateTotal ?? null,
    minRatePerMile: doc.minRatePerMile ?? null,
    originLocations: doc.originLocations ?? [],
    destLocations: doc.destLocations ?? [],
    excludedStates: doc.excludedStates ?? [],
    notifyOn: doc.notifyOn === "rate-increase" ? "rate-increase" : "any",
    color: doc.color ?? DEFAULT_COLOR,
    createdAt: doc.createdAt,
  };
}

export async function ensureFilterIndexes() {
  const db = getDb();
  await db.collection(COLLECTION).createIndex({ userId: 1, filterId: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ userId: 1 });
}

export async function listFiltersForUser(userId) {
  const db = getDb();
  const rows = await db
    .collection(COLLECTION)
    .find({ userId: String(userId) })
    .sort({ createdAt: 1 })
    .toArray();
  return rows.map(toClientFilter);
}

/** Replace the user's entire filter set (source of truth for multi-device sync). */
export async function replaceFiltersForUser(userId, filters) {
  const db = getDb();
  const uid = String(userId);
  const normalized = (Array.isArray(filters) ? filters : [])
    .map((row) => normalizeFilter(row, uid))
    .filter(Boolean);

  const col = db.collection(COLLECTION);
  await col.deleteMany({ userId: uid });

  if (normalized.length > 0) {
    await col.insertMany(normalized);
  }

  return normalized.map(toClientFilter);
}
