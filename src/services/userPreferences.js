import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";

const DEFAULTS = {
  autoReachEnabled: false,
  matchDisplayMode: "highlight",
  hideCanceledLoads: true,
  selectedFilterId: "__all__",
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

export async function getUserPreferences(userId) {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
  const prefs = user?.preferences ?? {};

  return {
    autoReachEnabled: Boolean(prefs.autoReachEnabled ?? DEFAULTS.autoReachEnabled),
    matchDisplayMode: normalizeMatchDisplayMode(prefs.matchDisplayMode ?? DEFAULTS.matchDisplayMode),
    hideCanceledLoads:
      prefs.hideCanceledLoads === undefined ? DEFAULTS.hideCanceledLoads : Boolean(prefs.hideCanceledLoads),
    selectedFilterId:
      typeof prefs.selectedFilterId === "string" && prefs.selectedFilterId
        ? prefs.selectedFilterId
        : DEFAULTS.selectedFilterId,
    themePreference: normalizeTheme(prefs.themePreference ?? DEFAULTS.themePreference),
    emailTemplates: Array.isArray(prefs.emailTemplates) ? prefs.emailTemplates : null,
    defaultSignature: typeof prefs.defaultSignature === "string" ? prefs.defaultSignature : null,
    defaultTemplateId: typeof prefs.defaultTemplateId === "string" ? prefs.defaultTemplateId : null,
    defaultTemplatePerTab:
      prefs.defaultTemplatePerTab && typeof prefs.defaultTemplatePerTab === "object"
        ? prefs.defaultTemplatePerTab
        : null,
  };
}

export async function setUserPreferences(userId, patch = {}) {
  const current = await getUserPreferences(userId);
  const next = {
    autoReachEnabled:
      patch.autoReachEnabled === undefined ? current.autoReachEnabled : Boolean(patch.autoReachEnabled),
    matchDisplayMode:
      patch.matchDisplayMode === undefined
        ? current.matchDisplayMode
        : normalizeMatchDisplayMode(patch.matchDisplayMode),
    hideCanceledLoads:
      patch.hideCanceledLoads === undefined ? current.hideCanceledLoads : Boolean(patch.hideCanceledLoads),
    selectedFilterId:
      patch.selectedFilterId === undefined
        ? current.selectedFilterId
        : String(patch.selectedFilterId || "__all__"),
    themePreference:
      patch.themePreference === undefined ? current.themePreference : normalizeTheme(patch.themePreference),
    emailTemplates:
      patch.emailTemplates === undefined
        ? current.emailTemplates
        : Array.isArray(patch.emailTemplates)
          ? patch.emailTemplates
          : null,
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

  const db = getDb();
  await db.collection("users").updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        preferences: next,
        updatedAt: new Date(),
      },
    }
  );

  return next;
}
