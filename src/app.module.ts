import { Module } from "@nestjs/common";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { BrokerInsightsModule } from "./broker-insights/broker-insights.module";
import { EmailModule } from "./email/email.module";
import { HealthController } from "./health/health.controller";
import { NotificationsModule } from "./notifications/notifications.module";
import { OutreachModule } from "./outreach/outreach.module";

@Module({
  imports: [AuthModule, BrokerInsightsModule, OutreachModule, EmailModule, AiModule, NotificationsModule],
  controllers: [HealthController],
})
export class AppModule {}
