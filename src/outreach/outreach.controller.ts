import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { SessionGuard } from "../auth/session.guard";
import { OutreachService } from "./outreach.service";

@UseGuards(SessionGuard)
@Controller("outreach")
export class OutreachController {
  constructor(private readonly service: OutreachService) {}

  @Get()
  list(@Req() req: Request) {
    const user = (req as Request & { user: { id: string } }).user;
    return this.service.listForUser(user.id);
  }
}
