import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { BrokerInsight } from "@cargosignal/shared";
import { PrismaService } from "../prisma.service";
import { fetchCarrierByMc, fetchCarrierByName, type FmcsaAuthorityData } from "./fmcsa.client";
import { COMPANY_INTEL_PROVIDER, type CompanyIntelProvider } from "./providers/company-intel-provider";
import { CREDIT_RISK_PROVIDER, type CreditRiskProvider, type CreditRiskResult } from "./providers/credit-risk-provider";
import {
  PHONE_REPUTATION_PROVIDER,
  type PhoneReputationProvider,
  type PhoneReputationResult,
} from "./providers/phone-reputation-provider";

const FMCSA_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — authority status changes rarely
const CREDIT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — payment risk shifts faster than authority status
const PHONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — line type/ownership rarely changes

@Injectable()
export class BrokerInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDIT_RISK_PROVIDER) private readonly creditRiskProvider: CreditRiskProvider,
    @Inject(PHONE_REPUTATION_PROVIDER) private readonly phoneReputationProvider: PhoneReputationProvider,
    @Inject(COMPANY_INTEL_PROVIDER) private readonly companyIntelProvider: CompanyIntelProvider
  ) {}

  /**
   * `identifier.mc` is preferred; `identifier.name` is a best-effort fallback
   * (see fmcsa.client.ts's fetchCarrierByName) for the common case where no
   * board adapter can extract an MC number from a listing row. Whichever is
   * given becomes the cache key — `mcNumber` on `BrokerProfile` doubles as a
   * generic lookup key (`"MC-123456"` or `"name:acme-logistics"`) rather
   * than strictly a real MC number, to avoid a schema migration for what's
   * still an early-stage cache. `phoneNumber` is optional and only used for
   * the reputation lookup — broker phone numbers come from the load posting
   * itself (DAT/TQL/etc.), not from FMCSA (its carrier record has no phone
   * field, see fmcsa.client.ts). `credit`/`reputation` stay null ("not
   * enough data yet") whenever no provider is configured — never a
   * false-safe default.
   */
  async getInsight(identifier: { mc?: string; name?: string }, phoneNumber?: string): Promise<BrokerInsight> {
    const mcNumber = identifier.mc ?? `name:${slugify(identifier.name!)}`;
    const now = new Date();
    let profile = await this.prisma.brokerProfile.findUnique({ where: { mcNumber } });

    const isStale = (fetchedAt: Date | null | undefined, ttlMs: number) =>
      !fetchedAt || now.getTime() - fetchedAt.getTime() > ttlMs;

    if (isStale(profile?.fmcsaFetchedAt, FMCSA_TTL_MS)) {
      const fmcsaData = await this.fetchFmcsaAuthority(identifier);
      profile = await this.prisma.brokerProfile.upsert({
        where: { mcNumber },
        update: { fmcsaData: toJsonInput(fmcsaData), fmcsaFetchedAt: now },
        create: { mcNumber, fmcsaData: toJsonInput(fmcsaData), fmcsaFetchedAt: now },
      });
    }

    if (isStale(profile?.paymentRiskFetchedAt, CREDIT_TTL_MS)) {
      const credit = await this.creditRiskProvider.lookup(mcNumber);
      profile = await this.prisma.brokerProfile.upsert({
        where: { mcNumber },
        update: {
          paymentRiskGrade: credit?.grade ?? null,
          paymentRiskData: toJsonInput(credit),
          paymentRiskFetchedAt: now,
        },
        create: {
          mcNumber,
          paymentRiskGrade: credit?.grade ?? null,
          paymentRiskData: toJsonInput(credit),
          paymentRiskFetchedAt: now,
        },
      });
    }

    if (phoneNumber && isStale(profile?.phoneFetchedAt, PHONE_TTL_MS)) {
      const phone = await this.phoneReputationProvider.lookup(phoneNumber);
      profile = await this.prisma.brokerProfile.upsert({
        where: { mcNumber },
        update: { phoneReputation: toJsonInput(phone), phoneFetchedAt: now },
        create: { mcNumber, phoneReputation: toJsonInput(phone), phoneFetchedAt: now },
      });
    }

    // Not cached (nothing to cache yet — NullCompanyIntelProvider is a
    // constant-time no-op); revisit once a real vendor is wired in, at which
    // point this should follow the same upsert+TTL pattern as the others.
    const companyIntel = await this.companyIntelProvider.lookup(mcNumber);

    const fmcsa = profile?.fmcsaData as unknown as FmcsaAuthorityData | null;
    const credit = profile?.paymentRiskData as unknown as CreditRiskResult | null;
    const phone = profile?.phoneReputation as unknown as PhoneReputationResult | null;
    const cachedAt = profile?.fmcsaFetchedAt ?? now;

    return {
      mcNumber,
      dotNumber: profile?.dotNumber ?? null,
      company: fmcsa
        ? {
            legalName: fmcsa.legalName,
            dba: fmcsa.dba,
            address: fmcsa.address,
            phone: fmcsa.phone,
            authorityStatus: fmcsa.authorityStatus,
            authorityGrantedDate: fmcsa.authorityGrantedDate,
            relatedCompanies: companyIntel?.relatedCompanies ?? [],
            domains: companyIntel?.domains ?? [],
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
      risk: computeRisk(fmcsa, credit, phone),
      reputation: phone
        ? {
            emailRiskLevel: null, // TODO: no email-verification provider wired yet
            phoneLineType: phone.lineType,
            phoneRiskLevel: phone.riskLevel,
            phoneCallerType: phone.callerType,
            phoneRegisteredOwner: phone.registeredOwner,
          }
        : null,
      meta: {
        cachedAt: cachedAt.toISOString(),
        staleAfter: new Date(cachedAt.getTime() + FMCSA_TTL_MS).toISOString(),
      },
    };
  }

  /**
   * Real FMCSA SAFER/QC Mobile API call, gated on FMCSA_WEB_KEY. Returns
   * null (never fabricated data) when no key is configured or FMCSA has no
   * record — see fmcsa.client.ts for endpoint/field confirmation.
   */
  private async fetchFmcsaAuthority(identifier: { mc?: string; name?: string }): Promise<FmcsaAuthorityData | null> {
    const webKey = process.env.FMCSA_WEB_KEY ?? process.env.FMCSA_WEBKEY;
    if (!webKey) return null;

    try {
      if (identifier.mc) return await fetchCarrierByMc(identifier.mc, webKey);
      return await fetchCarrierByName(identifier.name!, webKey);
    } catch (error) {
      console.warn(`[broker-insights] FMCSA lookup failed for ${identifier.mc ?? identifier.name}`, error);
      return null;
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Prisma's JSON columns need `Prisma.JsonNull` rather than a bare `null` to mean "store SQL NULL". */
function toJsonInput(value: object | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

const CREDIT_GRADE_RISK: Record<string, number> = { A: -10, B: 0, C: 10, D: 25, F: 40 };
const POOR_CREDIT_GRADES = new Set(["D", "F"]);

/**
 * Score is a RISK score (higher = riskier), 0-100. Only computed once at
 * least one real signal (FMCSA or credit) exists — otherwise null, per the
 * "never a false-safe default" rule from the plan.
 */
export function computeRisk(
  fmcsa: FmcsaAuthorityData | null,
  credit: CreditRiskResult | null,
  phone: PhoneReputationResult | null = null
): BrokerInsight["risk"] {
  if (!fmcsa && !credit) return null;

  let score = 20;
  const factors: Array<{ label: string; severity: "info" | "warning" | "danger"; detail: string }> = [];

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

  score = Math.max(0, Math.min(100, score));
  const band = score >= 60 ? "high" : score >= 30 ? "medium" : "low";

  // Deliberately conservative: requires the authority signal AND at least
  // one other independent bad signal to agree, so a single weak factor
  // (e.g. just an unclear FMCSA status) never trips it on its own.
  const authorityRevoked = fmcsa?.authorityStatus === "revoked";
  const poorCredit = Boolean(credit?.grade && POOR_CREDIT_GRADES.has(credit.grade.toUpperCase()));
  const riskyPhone = phone?.riskLevel === "high";
  const scamLikely = authorityRevoked && (poorCredit || riskyPhone);

  return { score, band, factors, scamLikely };
}
