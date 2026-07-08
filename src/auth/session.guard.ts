import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";

export const SESSION_COOKIE_NAME = "cs_session";

/**
 * Accepts the session token via either the first-party cookie (web
 * dashboard, same-site requests) or an `Authorization: Bearer` header (the
 * extension — no reliable shared cookie jar with the backend across content
 * scripts, background, and side panel contexts). Same token value, same
 * validation, just two transports.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer ?? (request.cookies?.[SESSION_COOKIE_NAME] as string | undefined);

    if (!token) throw new UnauthorizedException("No session credential");

    const user = await this.authService.validateSession(token);
    if (!user) throw new UnauthorizedException("Invalid or expired session");

    (request as Request & { user: typeof user }).user = user;
    return true;
  }
}
