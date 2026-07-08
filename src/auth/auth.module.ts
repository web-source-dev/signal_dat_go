import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionGuard } from "./session.guard";

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, PrismaService],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
