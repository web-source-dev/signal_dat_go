import { BadRequestException, Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { SessionGuard, SESSION_COOKIE_NAME } from "./session.guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Dev-only stand-in for the real Google-OAuth/email+password dashboard
   * login (see plan §4). Never enable this in production — it trades an
   * email address for a valid session with no password/OAuth check at all.
   */
  @Post("dev-login")
  async devLogin(@Body("email") email: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (process.env.NODE_ENV === "production") {
      throw new BadRequestException("dev-login is disabled in production");
    }
    if (!email) throw new BadRequestException("email is required");

    const user = await this.authService.findOrCreateUserByEmail(email);
    const { token, expiresAt } = await this.authService.createSession(user.id, req.headers["user-agent"]);

    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      expires: expiresAt,
    });

    // Also returned in the body (not just the cookie) for the extension,
    // which stores it in chrome.storage.local and sends it as a Bearer
    // token — see apps/extension/utils/backendApi.ts.
    return { id: user.id, email: user.email, token };
  }

  @UseGuards(SessionGuard)
  @Get("me")
  me(@Req() req: Request) {
    return (req as Request & { user: { id: string; email: string } }).user;
  }
}
