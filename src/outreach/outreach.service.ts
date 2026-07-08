import { Injectable } from "@nestjs/common";
import type { Provider } from "@prisma/client";
import { PrismaService } from "../prisma.service";

export interface RecordSentEmailInput {
  loadRef: string | null;
  provider: Provider;
  providerThreadId: string;
  providerMessageId: string;
  subject: string;
  brokerEmail: string;
  bodySnippet: string;
  aiGenerated: boolean;
}

@Injectable()
export class OutreachService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    return this.prisma.outreachThread.findMany({
      where: { userId },
      orderBy: { lastActivityAt: "desc" },
      include: { sentEmails: true, replies: true },
    });
  }

  /** Upserts the thread (keyed by userId+provider+providerThreadId) and appends a SentEmail row. */
  async recordSentEmail(userId: string, input: RecordSentEmailInput) {
    const now = new Date();

    const thread = await this.prisma.outreachThread.upsert({
      where: {
        userId_provider_providerThreadId: {
          userId,
          provider: input.provider,
          providerThreadId: input.providerThreadId,
        },
      },
      update: { status: "SENT", lastActivityAt: now },
      create: {
        userId,
        loadRef: input.loadRef,
        provider: input.provider,
        providerThreadId: input.providerThreadId,
        subject: input.subject,
        brokerEmail: input.brokerEmail,
        status: "SENT",
        lastActivityAt: now,
      },
    });

    await this.prisma.sentEmail.create({
      data: {
        outreachThreadId: thread.id,
        providerMessageId: input.providerMessageId,
        bodySnippet: input.bodySnippet,
        aiGenerated: input.aiGenerated,
        sentAt: now,
      },
    });

    return thread;
  }

  async findThreadByProviderThread(userId: string, provider: Provider, providerThreadId: string) {
    return this.prisma.outreachThread.findUnique({
      where: { userId_provider_providerThreadId: { userId, provider, providerThreadId } },
    });
  }

  async recordReply(
    outreachThreadId: string,
    input: { providerMessageId: string; fromAddress: string; snippet: string; receivedAt: Date }
  ) {
    await this.prisma.$transaction([
      this.prisma.emailReply.create({
        data: {
          outreachThreadId,
          providerMessageId: input.providerMessageId,
          fromAddress: input.fromAddress,
          snippet: input.snippet,
          receivedAt: input.receivedAt,
        },
      }),
      this.prisma.outreachThread.update({
        where: { id: outreachThreadId },
        data: { status: "REPLIED", lastActivityAt: input.receivedAt },
      }),
    ]);
  }
}
