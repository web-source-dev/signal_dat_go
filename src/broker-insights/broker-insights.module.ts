import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../prisma.service";
import { BrokerInsightsController } from "./broker-insights.controller";
import { BrokerInsightsService } from "./broker-insights.service";
import { COMPANY_INTEL_PROVIDER, NullCompanyIntelProvider } from "./providers/company-intel-provider";
import { CREDIT_RISK_PROVIDER, NullCreditRiskProvider } from "./providers/credit-risk-provider";
import { NullPhoneReputationProvider, PHONE_REPUTATION_PROVIDER } from "./providers/phone-reputation-provider";

/**
 * Swap `NullCreditRiskProvider`/`NullPhoneReputationProvider`/
 * `NullCompanyIntelProvider` for a real vendor implementation here once a
 * contract is in place — nothing in BrokerInsightsService needs to change.
 */
@Module({
  imports: [AuthModule],
  controllers: [BrokerInsightsController],
  providers: [
    BrokerInsightsService,
    PrismaService,
    { provide: CREDIT_RISK_PROVIDER, useClass: NullCreditRiskProvider },
    { provide: PHONE_REPUTATION_PROVIDER, useClass: NullPhoneReputationProvider },
    { provide: COMPANY_INTEL_PROVIDER, useClass: NullCompanyIntelProvider },
  ],
})
export class BrokerInsightsModule {}
