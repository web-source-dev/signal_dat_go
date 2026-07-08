import { randomBytes, createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /** Raw token goes in the cookie; only its hash is ever persisted. */
  async createSession(userId: string, userAgent?: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.prisma.session.create({
      data: { userId, tokenHash, userAgent, expiresAt },
    });

    return { token, expiresAt };
  }

  async validateSession(token: string) {
    const tokenHash = hashToken(token);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date() || session.user.deletedAt) {
      return null;
    }

    return session.user;
  }

  async findOrCreateUserByEmail(email: string) {
    return this.prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
