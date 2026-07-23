import { getDb } from "../db/mongo.js";
import { lookupDomain } from "./domainIntel.js";
import { fetchCarrierByMc, fetchCarrierByName, getFmcsaWebKey } from "./fmcsa.js";

const FMCSA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emailDomain(email) {
  if (!email || !email.includes("@")) return null;
  return email.split("@")[1]?.toLowerCase() ?? null;
}

const CREDIT_GRADE_RISK = { A: -10, B: 0, C: 10, D: 25, F: 40 };
const POOR_CREDIT_GRADES = new Set(["D", "F"]);

function computeRisk(fmcsa, credit, phone = null, domain = null) {
  if (!fmcsa && !credit && !phone && !domain) return null;

  let score = 20;
  const factors = [];

  if (fmcsa) {
    switch (fmcsa.authorityStatus) {
      case "revoked":
        score += 50;
        factors.push({
          label: "Authority revoked",
          severity: "danger",
          detail: "FMCSA does not list this broker's operating authority as active.",
        });
        break;
      case "unknown":
        score += 15;
        factors.push({
          label: "Authority status unclear",
          severity: "warning",
          detail: "FMCSA did not return a clear authority status for this broker.",
        });
        break;
      case "reinstated":
        score += 10;
        factors.push({
          label: "Recently reinstated authority",
          severity: "warning",
          detail: "This broker's authority was reinstated after a prior lapse.",
        });
        break;
      case "granted":
        factors.push({
          label: "Authority active",
          severity: "info",
          detail: "FMCSA lists this broker's operating authority as active.",
        });
        break;
    }
  }

  if (credit?.grade) {
    const gradeAdjustment = CREDIT_GRADE_RISK[credit.grade.toUpperCase()] ?? 0;
    score += gradeAdjustment;
    if (gradeAdjustment > 0) {
      factors.push({
        label: `${credit.gradeSource} rating: ${credit.grade}`,
        severity: gradeAdjustment >= 25 ? "danger" : "warning",
        detail: "This payment-risk grade suggests elevated risk of slow or missed payment.",
      });
    }
  }

  if (phone?.riskLevel === "high") {
    score += 15;
    factors.push({
      label: "High-risk phone number",
      severity: "warning",
      detail: "This contact number is flagged as high-risk by phone reputation lookup.",
    });
  }

  if (domain?.riskLevel === "high") {
    score += 20;
    factors.push({
      label: "New or risky email domain",
      severity: "danger",
      detail: `Domain ${domain.domain} was registered recently or shows weak DNS signals.`,
    });
  } else if (domain?.riskLevel === "medium") {
    score += 10;
    factors.push({
      label: "Young email domain",
      severity: "warning",
      detail: `Domain ${domain.domain} is less than 6 months old.`,
    });
  } else if (domain) {
    factors.push({
      label: "Email domain looks established",
      severity: "info",
      detail: `Domain ${domain.domain} has DNS records on file.`,
    });
  }

  score = Math.max(0, Math.min(100, score));
  const band = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  const authorityRevoked = fmcsa?.authorityStatus === "revoked";
  const poorCredit = Boolean(credit?.grade && POOR_CREDIT_GRADES.has(credit.grade.toUpperCase()));
  const riskyPhone = phone?.riskLevel === "high";
  const riskyDomain = domain?.riskLevel === "high";
  const scamLikely = authorityRevoked && (poorCredit || riskyPhone || riskyDomain);

  return { score, band, factors, scamLikely };
}

async function fetchFmcsaAuthority(identifier) {
  const webKey = getFmcsaWebKey();
  if (!webKey) {
    return { data: null, note: "FMCSA_WEBKEY is not configured in apps/api/.env" };
  }

  try {
    if (identifier.mc) {
      const data = await fetchCarrierByMc(identifier.mc, webKey);
      return { data, note: data ? null : "No FMCSA record found for this MC number." };
    }
    const data = await fetchCarrierByName(identifier.name, webKey);
    return { data, note: data ? null : `No FMCSA record found for "${identifier.name}".` };
  } catch (error) {
    const detail = error?.cause?.code || error?.cause?.message || error.message;
    const message =
      error?.code === "FMCSA_FORBIDDEN"
        ? "FMCSA blocked this server's region. Add working HTTP_PROXY_* settings to apps/api/.env."
        : /407|PROXY_AUTHENTICATION|Proxy .* failed/i.test(String(detail))
          ? `FMCSA lookup failed: US proxy auth/connection error (${detail}). Update HTTP_PROXY_* in apps/api/.env.`
          : `FMCSA lookup failed: ${detail}`;
    console.warn(`[broker-insights] FMCSA lookup failed for ${identifier.mc ?? identifier.name}`, error);
    return { data: null, note: message };
  }
}

export async function getInsight(identifier, phoneNumber, brokerEmail) {
  const mcNumber = identifier.mc ?? `name:${slugify(identifier.name ?? brokerEmail ?? "unknown")}`;
  const now = new Date();
  const db = getDb();
  const coll = db.collection("brokerProfiles");

  let profile = await coll.findOne({ mcNumber });
  const isStale = (fetchedAt, ttlMs) => !fetchedAt || now.getTime() - new Date(fetchedAt).getTime() > ttlMs;

  let fmcsaNote = null;
  const missTtlMs = 60 * 60 * 1000;
  const fmcsaTtl = profile?.fmcsaMiss ? missTtlMs : FMCSA_TTL_MS;

  if (isStale(profile?.fmcsaFetchedAt, fmcsaTtl)) {
    const { data: fmcsaData, note } = await fetchFmcsaAuthority(identifier);
    fmcsaNote = note;
    await coll.updateOne(
      { mcNumber },
      {
        $set: {
          fmcsaData,
          fmcsaFetchedAt: now,
          fmcsaNote: note,
          fmcsaMiss: !fmcsaData,
        },
        $setOnInsert: { mcNumber, createdAt: now },
      },
      { upsert: true }
    );
    profile = await coll.findOne({ mcNumber });
  } else {
    fmcsaNote = profile?.fmcsaNote ?? null;
  }

  const domainName = emailDomain(brokerEmail);
  let domainIntel = null;
  if (domainName && isStale(profile?.domainFetchedAt, FMCSA_TTL_MS)) {
    try {
      domainIntel = await lookupDomain(domainName);
      await coll.updateOne(
        { mcNumber },
        { $set: { domainIntel, domainFetchedAt: now } },
        { upsert: true }
      );
      profile = await coll.findOne({ mcNumber });
    } catch (error) {
      console.warn(`[broker-insights] domain lookup failed for ${domainName}`, error);
    }
  } else if (profile?.domainIntel) {
    domainIntel = profile.domainIntel;
  }

  const fmcsa = profile?.fmcsaData ?? null;
  const credit = profile?.paymentRiskData ?? null;
  const phone = profile?.phoneReputation ?? null;
  const cachedAt = profile?.fmcsaFetchedAt ?? now;

  const domains = domainName ? [domainName] : [];

  return {
    mcNumber: fmcsa?.mcNumber ?? identifier.mc ?? mcNumber,
    dotNumber: fmcsa?.dotNumber ?? profile?.dotNumber ?? null,
    company: fmcsa
      ? {
          legalName: fmcsa.legalName,
          dba: fmcsa.dba,
          address: fmcsa.address,
          phone: fmcsa.phone ?? phoneNumber ?? null,
          authorityStatus: fmcsa.authorityStatus,
          authorityGrantedDate: fmcsa.authorityGrantedDate,
          relatedCompanies: [],
          domains,
        }
      : domainIntel
        ? {
            legalName: identifier.name ?? domainName,
            dba: null,
            address: null,
            phone: phoneNumber ?? null,
            authorityStatus: "unknown",
            authorityGrantedDate: null,
            relatedCompanies: [],
            domains,
          }
        : null,
    credit: credit
      ? {
          grade: credit.grade,
          gradeSource: credit.gradeSource,
          avgDaysToPay: credit.avgDaysToPay,
          fetchedAt: (profile?.paymentRiskFetchedAt ?? now).toISOString(),
        }
      : null,
    risk: computeRisk(fmcsa, credit, phone, domainIntel),
    reputation:
      phone || domainIntel || brokerEmail
        ? {
            emailRiskLevel: domainIntel?.riskLevel ?? null,
            phoneLineType: phone?.lineType ?? null,
            phoneRiskLevel: phone?.riskLevel ?? null,
            phoneCallerType: phone?.callerType ?? null,
            phoneRegisteredOwner: phone?.registeredOwner ?? null,
          }
        : null,
    meta: {
      cachedAt: new Date(cachedAt).toISOString(),
      staleAfter: new Date(new Date(cachedAt).getTime() + FMCSA_TTL_MS).toISOString(),
      fmcsaNote: fmcsa ? null : fmcsaNote,
      domainNote: domainIntel
        ? `${domainIntel.domain}: ${domainIntel.domainAgeDays ?? "?"} days old, ${domainIntel.mxRecords} MX record(s), SPF ${domainIntel.hasSpf ? "yes" : "no"}`
        : domainName
          ? "Could not verify email domain."
          : null,
    },
  };
}
