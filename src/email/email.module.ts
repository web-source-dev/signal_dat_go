import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ConnectedAccountsService } from "../connected-accounts/connected-accounts.service";
import { TokenCipherService } from "../crypto/token-cipher";
import { NotificationsModule } from "../notifications/notifications.module";
import { OutreachModule } from "../outreach/outreach.module";
import { PrismaService } from "../prisma.service";
import { EmailController } from "./email.controller";
import { GmailService } from "./gmail.service";
import { OutlookService } from "./outlook.service";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [AuthModule, OutreachModule, NotificationsModule],
  controllers: [EmailController, WebhooksController],
  providers: [GmailService, OutlookService, ConnectedAccountsService, TokenCipherService, PrismaService],
})
export class EmailModule {}
