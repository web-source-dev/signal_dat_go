import { Injectable } from "@nestjs/common";
import { Prisma, Provider } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { TokenCipherService } from "../crypto/token-cipher";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface StoredTokens extends OAuthTokens {
  providerAccountEmail: string | null;
}

/**
 * Generic per-(user, provider) OAuth token storage shared by Gmail and
 * Outlook (and, later, any other OAuth-based integration) — tokens are
 * encrypted at rest via TokenCipherService, never stored in plaintext.
 */
@Injectable()
export class ConnectedAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService
  ) {}

  async upsertTokens(
    userId: string,
    provider: Provider,
    tokens: OAuthTokens,
    opts?: { providerAccountEmail?: string; scope?: string }
  ) {
    const data = {
      status: "ACTIVE" as const,
      accessTokenEncrypted: this.cipher.encrypt(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken ? this.cipher.encrypt(tokens.refreshToken) : undefined,
      tokenExpiresAt: tokens.expiresAt,
      providerAccountEmail: opts?.providerAccountEmail,
      scope: opts?.scope,
      lastError: null,
    };

    return this.prisma.connectedAccount.upsert({
      where: { userId_provider: { userId, provider } },
      update: data,
      create: { userId, provider, ...data },
    });
  }

  async getDecryptedTokens(userId: string, provider: Provider): Promise<StoredTokens | null> {
    const account = await this.prisma.connectedAccount.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!account?.accessTokenEncrypted) return null;

    return {
      accessToken: this.cipher.decrypt(account.accessTokenEncrypted),
      refreshToken: account.refreshTokenEncrypted ? this.cipher.decrypt(account.refreshTokenEncrypted) : null,
      expiresAt: account.tokenExpiresAt,
      providerAccountEmail: account.providerAccountEmail,
    };
  }

  async findByProviderAccountEmail(provider: Provider, email: string) {
    return this.prisma.connectedAccount.findFirst({ where: { provider, providerAccountEmail: email } });
  }

  /** Scans providerMetadata (opaque JSON) for a key/value match — see webhooks.controller.ts for why. */
  async findByProviderMetadataField(provider: Provider, key: string, value: string) {
    return this.prisma.connectedAccount.findFirst({
      where: { provider, providerMetadata: { path: [key], equals: value } },
    });
  }

  async setProviderMetadata(userId: string, provider: Provider, metadata: object) {
    await this.prisma.connectedAccount.update({
      where: { userId_provider: { userId, provider } },
      data: { providerMetadata: metadata as Prisma.InputJsonValue },
    });
  }

  async recordError(userId: string, provider: Provider, message: string) {
    await this.prisma.connectedAccount.update({
      where: { userId_provider: { userId, provider } },
      data: { status: "ERROR", lastError: message },
    });
  }
}
