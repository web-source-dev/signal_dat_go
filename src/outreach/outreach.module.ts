import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../prisma.service";
import { OutreachController } from "./outreach.controller";
import { OutreachService } from "./outreach.service";

@Module({
  imports: [AuthModule],
  controllers: [OutreachController],
  providers: [OutreachService, PrismaService],
  exports: [OutreachService],
})
export class OutreachModule {}
