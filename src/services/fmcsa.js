import { proxyFetch } from "./proxyFetch.js";

const BASE = "https://mobile.fmcsa.dot.gov/qc/services";

const DEFAULT_HEADERS = {
  Accept: "application/json",
  "User-Agent": "CargoSignal/1.0 (FMCSA QCMobile client)",
};

function formatAddress(carrier) {
  const parts = [carrier.phyStreet, carrier.phyCity, carrier.phyState, carrier.phyZipcode].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function resolveAuthorityStatus(carrier) {
  const broker = carrier.brokerAuthorityStatus;
  const common = carrier.commonAuthorityStatus;
  const contract = carrier.contractAuthorityStatus;

  if (broker === "A") return "granted";
  if (broker === "I" || broker === "N") {
    if (common === "A" || contract === "A") return "unknown";
    return "revoked";
  }
  if (common === "A" || contract === "A") return "granted";
  if (carrier.allowedToOperate === "Y") return "unknown";
  return "revoked";
}

function toAuthorityData(carrier) {
  return {
    legalName: carrier.legalName ?? "Unknown",
    dba: carrier.dbaName || null,
    address: formatAddress(carrier),
    phone: carrier.telephone || carrier.phone || null,
    email: carrier.emailAddress || null,
    dotNumber: carrier.dotNumber ? String(carrier.dotNumber) : null,
    mcNumber: carrier.docketNumber ? String(carrier.docketNumber) : null,
    authorityStatus: resolveAuthorityStatus(carrier),
    authorityGrantedDate: carrier.mcs150Date || null,
    raw: carrier,
  };
}

export function getFmcsaWebKey() {
  return process.env.FMCSA_WEB_KEY ?? process.env.FMCSA_WEBKEY ?? null;
}

function apiUrl(path, webKey) {
  const key = webKey ?? getFmcsaWebKey();
  if (!key) throw new Error("FMCSA_WEBKEY is not configured");
  return `${BASE}/${path}${path.includes("?") ? "&" : "?"}webKey=${encodeURIComponent(key)}`;
}

async function fmcsaGet(path, webKey) {
  const url = apiUrl(path, webKey);
  console.log("[fmcsa] GET", path);
  try {
    const response = await proxyFetch(url, { headers: DEFAULT_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`FMCSA API request failed: ${response.status} ${response.statusText}`);
      err.status = response.status;
      err.code = response.status === 403 ? "FMCSA_FORBIDDEN" : "FMCSA_UPSTREAM";
      console.error("[fmcsa] upstream HTTP error", {
        path,
        status: response.status,
        statusText: response.statusText,
        bodyPreview: text.slice(0, 180).replace(/\s+/g, " "),
      });
      throw err;
    }
    return parseFmcsaJson(text, path);
  } catch (error) {
    console.error("[fmcsa] request failed", {
      path,
      message: error.message,
      code: error.code,
      cause: error.cause?.code || error.cause?.message || null,
    });
    throw error;
  }
}

function parseFmcsaJson(text, path) {
  const raw = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) {
    const err = new Error("FMCSA returned an empty response");
    err.code = "FMCSA_BAD_JSON";
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (firstError) {
    // Some proxies/WAF wrappers leave junk around a JSON object.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        console.warn("[fmcsa] recovered JSON payload from noisy body", { path });
        return parsed;
      } catch {
        /* fall through */
      }
    }
    console.error("[fmcsa] JSON parse failed", {
      path,
      message: firstError.message,
      bodyPreview: raw.slice(0, 220).replace(/\s+/g, " "),
    });
    const err = new Error(`FMCSA returned invalid JSON (${firstError.message})`);
    err.code = "FMCSA_BAD_JSON";
    err.cause = firstError;
    throw err;
  }
}

function extractCarriers(data) {
  const entries = Array.isArray(data?.content) ? data.content : data?.content ? [data.content] : [];
  return entries.map((entry) => entry?.carrier).filter(Boolean);
}

/**
 * Normalize user/board MC input to digits only.
 * Accepts: "123456", "MC123456", "MC 123456", "mc-#123456".
 * Returns null when the string is not an MC-style query (so names with digits stay name searches).
 */
export function normalizeMcNumber(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const prefixed = trimmed.match(/^MC[\s#.\-]*(\d{4,8})$/i);
  if (prefixed?.[1]) return prefixed[1];

  // Digits only (optional leading zeros). Reject if any letters remain.
  if (/^\d{4,8}$/.test(trimmed)) return trimmed.replace(/^0+/, "") || trimmed;

  return null;
}

/** Build search variants from a messy DAT company cell (slashes, emails, suffixes). */
export function buildNameSearchCandidates(companyName) {
  const cleaned = String(companyName || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const candidates = new Set();
  if (!cleaned) return [];

  candidates.add(cleaned);
  for (const part of cleaned.split(/\s*\/\s*/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    candidates.add(trimmed);
    candidates.add(trimmed.replace(/\b(inc|llc|ltd|corp|co|logistics)\.?$/i, "").trim());
  }

  return [...candidates].filter((value) => value.length >= 3);
}

export async function fetchCarrierByMc(mcNumber, webKey) {
  const docketDigits = normalizeMcNumber(mcNumber);
  if (!docketDigits) return null;
  const data = await fmcsaGet(`carriers/docket-number/${encodeURIComponent(docketDigits)}`, webKey);
  const carrier = extractCarriers(data)[0];
  return carrier ? toAuthorityData(carrier) : null;
}

export async function fetchCarriersByName(companyName, webKey, limit = 10) {
  const data = await fmcsaGet(`carriers/name/${encodeURIComponent(companyName)}`, webKey);
  return extractCarriers(data)
    .slice(0, limit)
    .map((carrier) => toAuthorityData(carrier));
}

export async function fetchCarrierByName(companyName, webKey) {
  const candidates = buildNameSearchCandidates(companyName);
  if (candidates.length === 0) return null;

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const matches = await fetchCarriersByName(candidate, webKey, 5);
      if (matches.length > 0) {
        const normalizedTarget = candidate.toLowerCase();
        const best =
          matches.find((row) => row.legalName?.toLowerCase().includes(normalizedTarget)) ??
          matches.find((row) => row.dba?.toLowerCase().includes(normalizedTarget)) ??
          matches[0];
        return best ?? null;
      }
    } catch (error) {
      lastError = error;
      console.warn(`[fmcsa] name lookup failed for "${candidate}"`, error.message);
    }
  }

  if (lastError) throw lastError;
  return null;
}
