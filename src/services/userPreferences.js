import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";

const ALL_FILTERS = "__all__";

const DEFAULTS = {
  autoReachEnabled: false,
  autoAiReplyEnabled: false,
  matchDisplayMode: "highlight",
  hideCanceledLoads: true,
  selectedFilterIds: [],
  selectedFilterId: ALL_FILTERS,
  themePreference: "light",
  emailTemplates: null,
  defaultSignature: null,
  defaultTemplateId: null,
  defaultTemplatePerTab: null,
};

function normalizeMatchDisplayMode(value) {
  return value === "dim" || value === "hide" ? value : "highlight";
}

function normalizeTheme(value) {
  return value === "dark" || value === "system" ? value : "light";
}

function sanitizeTemplates(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      id: String(row.id ?? "").trim(),
      name: String(row.name ?? "").trim() || "Untitled",
      subject: String(row.subject ?? ""),
      body: String(row.body ?? ""),
    }))
    .filter((row) => row.id);
}

function normalizeSelectedFilterIds(value, legacyId) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((id) => typeof id === "string")
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0 && id !== ALL_FILTERS)
      ),
    ];
  }
  if (typeof legacyId === "string" && legacyId && legacyId !== ALL_FILTERS) {
    return [legacyId];
  }
  return [];
}

function selectedFilterIdFromIds(ids) {
  if (!ids.length) return ALL_FILTERS;
  if (ids.length === 1) return ids[0];
  return ALL_FILTERS;
}

export async function getUserPreferences(userId) {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
  const prefs = user?.preferences ?? {};

  const selectedFilterIds = normalizeSelectedFilterIds(prefs.selectedFilterIds, prefs.selectedFilterId);

  return {
    autoReachEnabled: Boolean(prefs.autoReachEnabled ?? DEFAULTS.autoReachEnabled),
    autoAiReplyEnabled: Boolean(prefs.autoAiReplyEnabled ?? DEFAULTS.autoAiReplyEnabled),
    matchDisplayMode: normalizeMatchDisplayMode(prefs.matchDisplayMode ?? DEFAULTS.matchDisplayMode),
    hideCanceledLoads:
      prefs.hideCanceledLoads === undefined ? DEFAULTS.hideCanceledLoads : Boolean(prefs.hideCanceledLoads),
    selectedFilterIds,
    selectedFilterId: selectedFilterIdFromIds(selectedFilterIds),
    themePreference: normalizeTheme(prefs.themePreference ?? DEFAULTS.themePreference),
    emailTemplates: Array.isArray(prefs.emailTemplates) ? sanitizeTemplates(prefs.emailTemplates) : null,
    defaultSignature: typeof prefs.defaultSignature === "string" ? prefs.defaultSignature : null,
    defaultTemplateId: typeof prefs.defaultTemplateId === "string" ? prefs.defaultTemplateId : null,
    defaultTemplatePerTab:
      prefs.defaultTemplatePerTab && typeof prefs.defaultTemplatePerTab === "object"
        ? prefs.defaultTemplatePerTab
        : null,
    preferencesUpdatedAt: user?.preferencesUpdatedAt
      ? new Date(user.preferencesUpdatedAt).toISOString()
      : null,
    filtersUpdatedAt: user?.filtersUpdatedAt ? new Date(user.filtersUpdatedAt).toISOString() : null,
  };
}

export async function setUserPreferences(userId, patch = {}) {
  const current = await getUserPreferences(userId);

  let selectedFilterIds = current.selectedFilterIds;
  if (patch.selectedFilterIds !== undefined) {
    selectedFilterIds = normalizeSelectedFilterIds(patch.selectedFilterIds, null);
  } else if (patch.selectedFilterId !== undefined) {
    const legacy = String(patch.selectedFilterId || ALL_FILTERS);
    selectedFilterIds = legacy === ALL_FILTERS ? [] : normalizeSelectedFilterIds([legacy], null);
  }

  const next = {
    autoReachEnabled:
      patch.autoReachEnabled === undefined ? current.autoReachEnabled : Boolean(patch.autoReachEnabled),
    autoAiReplyEnabled:
      patch.autoAiReplyEnabled === undefined ? current.autoAiReplyEnabled : Boolean(patch.autoAiReplyEnabled),
    matchDisplayMode:
      patch.matchDisplayMode === undefined
        ? current.matchDisplayMode
        : normalizeMatchDisplayMode(patch.matchDisplayMode),
    hideCanceledLoads:
      patch.hideCanceledLoads === undefined ? current.hideCanceledLoads : Boolean(patch.hideCanceledLoads),
    selectedFilterIds,
    selectedFilterId: selectedFilterIdFromIds(selectedFilterIds),
    themePreference:
      patch.themePreference === undefined ? current.themePreference : normalizeTheme(patch.themePreference),
    emailTemplates:
      patch.emailTemplates === undefined ? current.emailTemplates : sanitizeTemplates(patch.emailTemplates),
    defaultSignature:
      patch.defaultSignature === undefined
        ? current.defaultSignature
        : typeof patch.defaultSignature === "string"
          ? patch.defaultSignature
          : null,
    defaultTemplateId:
      patch.defaultTemplateId === undefined
        ? current.defaultTemplateId
        : typeof patch.defaultTemplateId === "string"
          ? patch.defaultTemplateId
          : null,
    defaultTemplatePerTab:
      patch.defaultTemplatePerTab === undefined
        ? current.defaultTemplatePerTab
        : patch.defaultTemplatePerTab && typeof patch.defaultTemplatePerTab === "object"
          ? patch.defaultTemplatePerTab
          : null,
  };

  const now = new Date();
  const db = getDb();
  await db.collection("users").updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        preferences: next,
        preferencesUpdatedAt: now,
        updatedAt: now,
      },
    }
  );

  return {
    ...next,
    preferencesUpdatedAt: now.toISOString(),
    filtersUpdatedAt: current.filtersUpdatedAt,
  };
}
