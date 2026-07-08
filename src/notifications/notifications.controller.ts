import { Controller, Get, Query, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "../auth/auth.service";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService
  ) {}

  /**
   * EventSource can't set an Authorization header, so the session token is
   * passed as a query param here instead — validated the same way as the
   * Bearer header in SessionGuard, just a different transport for this one
   * endpoint. Held open by the extension's offscreen document (see
   * apps/extension/entrypoints/offscreen/main.ts) since MV3 service workers
   * can't keep a connection like this alive.
   */
  @Get("sse")
  async stream(@Query("token") token: string | undefined, @Res() res: Response) {
    if (!token) throw new UnauthorizedException("token query param is required");
    const user = await this.auth.validateSession(token);
    if (!user) throw new UnauthorizedException("Invalid or expired session");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":ok\n\n");

    const unsubscribe = this.notifications.subscribe(user.id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 30_000);

    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
