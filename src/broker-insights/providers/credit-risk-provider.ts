export interface CreditRiskResult {
  grade: string;
  gradeSource: string;
  avgDaysToPay: number | null;
}

/**
 * Payment/credit-risk data requires a real vendor contract — see the
 * project README's legal framing. This interface exists so a real
 * implementation (Ansonia Credit Data, DAT iQ, a factoring-company
 * partnership, etc.) can be dropped in later via `CREDIT_RISK_PROVIDER`
 * in broker-insights.module.ts without touching BrokerInsightsService.
 */
export interface CreditRiskProvider {
  readonly sourceName: string;
  lookup(mcNumber: string): Promise<CreditRiskResult | null>;
}

export const CREDIT_RISK_PROVIDER = Symbol("CREDIT_RISK_PROVIDER");

/** Default: no vendor contracted yet. Always returns null — never fabricates a grade. */
export class NullCreditRiskProvider implements CreditRiskProvider {
  readonly sourceName = "none";

  async lookup(_mcNumber: string): Promise<CreditRiskResult | null> {
    return null;
  }
}
