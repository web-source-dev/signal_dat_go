import { promisify } from "node:util";
import dns from "node:dns/promises";
import { lookup as whoisLookupCallback } from "whois";

const whoisLookupRaw = promisify(whoisLookupCallback);

const CREATION_PATTERNS = [
  /Creation Date:\s*(.+)/i,
  /Created (?:On|Date):\s*(.+)/i,
  /Domain Registration Date:\s*(.+)/i,
  /Registered on:\s*(.+)/i,
];

const REGISTRAR_PATTERNS = [/Registrar:\s*(.+)/i, /Registrar Name:\s*(.+)/i];

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

async function whoisLookup(domain) {
  try {
    const text = await Promise.race([
      whoisLookupRaw(domain, { follow: 1, timeout: 5000 }),
      new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    if (!text) return null;
    const raw = Array.isArray(text) ? text.map((t) => t.data).join("\n") : text;
    const creationRaw = firstMatch(raw, CREATION_PATTERNS);
    const creationDate = creationRaw ? new Date(creationRaw) : null;
    return {
      registrar: firstMatch(raw, REGISTRAR_PATTERNS),
      registeredAt:
        creationDate && !Number.isNaN(creationDate.getTime()) ? creationDate.toISOString() : null,
    };
  } catch {
    return null;
  }
}

export async function lookupDomain(domain) {
  const normalized = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  if (!normalized.includes(".")) {
    throw new Error("Invalid domain");
  }

  const [whois, mx, txt] = await Promise.all([
    whoisLookup(normalized),
    dns.resolveMx(normalized).catch(() => []),
    dns.resolveTxt(normalized).catch(() => []),
  ]);

  const flatTxt = txt.flat();
  const hasSpf = flatTxt.some((row) => row.toLowerCase().startsWith("v=spf1"));
  const domainAgeDays = whois?.registeredAt
    ? Math.round((Date.now() - new Date(whois.registeredAt).getTime()) / 86_400_000)
    : null;

  let riskLevel = "unknown";
  if (domainAgeDays != null && domainAgeDays < 30) riskLevel = "high";
  else if (domainAgeDays != null && domainAgeDays < 180) riskLevel = "medium";
  else if (domainAgeDays != null) riskLevel = "low";

  return {
    domain: normalized,
    registrar: whois?.registrar ?? null,
    registeredAt: whois?.registeredAt ?? null,
    domainAgeDays,
    mxRecords: mx.length,
    hasSpf,
    riskLevel,
  };
}
