export interface CompanyIntelResult {
  relatedCompanies: string[];
  domains: string[];
}

/**
 * Related-entity/domain lookups (e.g. an OpenCorporates- or Clearbit-style
 * business intelligence API) — no vendor contracted yet, see SETUP.md. This
 * interface lets one be dropped in later via `COMPANY_INTEL_PROVIDER` in
 * broker-insights.module.ts without touching BrokerInsightsService.
 */
export interface CompanyIntelProvider {
  readonly sourceName: string;
  lookup(mcNumber: string): Promise<CompanyIntelResult | null>;
}

export const COMPANY_INTEL_PROVIDER = Symbol("COMPANY_INTEL_PROVIDER");

/** Default: no vendor contracted yet. Always returns empty lists — never fabricates related entities. */
export class NullCompanyIntelProvider implements CompanyIntelProvider {
  readonly sourceName = "none";

  async lookup(_mcNumber: string): Promise<CompanyIntelResult | null> {
    return { relatedCompanies: [], domains: [] };
  }
}
