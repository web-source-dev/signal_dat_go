export interface PhoneReputationResult {
  lineType: string | null;
  riskLevel: "low" | "medium" | "high";
  /** Caller-ID style lookup (e.g. Twilio Lookup's caller-name product). */
  callerType: string | null;
  registeredOwner: string | null;
}

/**
 * Phone-reputation lookups (Twilio Lookup, Telesign, etc.) are a standard
 * paid vendor category — this interface lets a real implementation be
 * dropped in via `PHONE_REPUTATION_PROVIDER` in broker-insights.module.ts
 * once a vendor account/API key exists, without touching BrokerInsightsService.
 */
export interface PhoneReputationProvider {
  readonly sourceName: string;
  lookup(phoneNumber: string): Promise<PhoneReputationResult | null>;
}

export const PHONE_REPUTATION_PROVIDER = Symbol("PHONE_REPUTATION_PROVIDER");

/** Default: no vendor configured yet. Always returns null — never fabricates a result. */
export class NullPhoneReputationProvider implements PhoneReputationProvider {
  readonly sourceName = "none";

  async lookup(_phoneNumber: string): Promise<PhoneReputationResult | null> {
    return null;
  }
}
