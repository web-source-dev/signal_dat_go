import * as connectedAccounts from "./connectedAccounts.js";
import * as outreach from "./outreach.js";
import * as gmail from "./gmail.js";
import * as outlook from "./outlook.js";
import * as smtp from "./smtp.js";
import { getEmailPreferences } from "./emailPreferences.js";

export async function resolveSendAccount(userId, body = {}) {
  const accountId = body.accountId ? String(body.accountId) : null;
  if (accountId) {
    const account = await connectedAccounts.getAccountById(userId, accountId);
    if (!account || account.status === "ERROR") {
      const err = new Error("Selected mailbox is not connected");
      err.status = 400;
      throw err;
    }
    return account;
  }

  const prefs = await getEmailPreferences(userId);
  if (prefs.defaultEmailAccountId) {
    const account = await connectedAccounts.getAccountById(userId, prefs.defaultEmailAccountId);
    if (account && account.status !== "ERROR") return account;
  }

  const preferred =
    body.provider === "SMTP"
      ? "SMTP"
      : body.provider === "OUTLOOK"
        ? "OUTLOOK"
        : body.provider === "GMAIL"
          ? "GMAIL"
          : null;

  const all = await connectedAccounts.listForUser(userId);
  const active = all.filter((row) => row.status !== "ERROR");
  if (preferred) {
    const match = active.find((row) => row.provider === preferred);
    if (match) {
      const account = await connectedAccounts.getAccountById(userId, match.id);
      if (account) return account;
    }
  }
  if (active[0]) {
    const account = await connectedAccounts.getAccountById(userId, active[0].id);
    if (account) return account;
  }

  const err = new Error("No connected mailbox — connect Gmail, Outlook, or SMTP in Account first");
  err.status = 400;
  throw err;
}

/**
 * Send an outbound email for a user and record it on the outreach thread.
 * Shared by the /email/send route and Auto AI Reply.
 */
export async function sendOutboundEmail(userId, body) {
  if (!body?.to || !body?.subject || !body?.bodyHtml) {
    const err = new Error("to, subject, and bodyHtml are required");
    err.status = 400;
    throw err;
  }

  const account = await resolveSendAccount(userId, body);
  const provider = account.provider;
  let result;

  if (provider === "SMTP") {
    const config = await connectedAccounts.getSmtpConfig(userId, String(account._id));
    if (!config) {
      const err = new Error("No SMTP account connected — connect your mailbox in Account first");
      err.status = 400;
      throw err;
    }
    result = await smtp.sendSmtpEmail(config, {
      to: body.to,
      subject: body.subject,
      bodyHtml: body.bodyHtml,
      inReplyToMessageId: body.inReplyToMessageId ?? null,
    });
  } else {
    const tokens =
      provider === "GMAIL"
        ? await connectedAccounts.getValidGmailTokens(userId, null, String(account._id))
        : await connectedAccounts.getDecryptedTokensForAccount(userId, String(account._id));
    if (!tokens) {
      const err = new Error(`No connected ${provider} account — connect Gmail or Outlook in Account first`);
      err.status = 400;
      throw err;
    }

    result =
      provider === "GMAIL"
        ? await gmail.sendGmailEmail(tokens.accessToken, tokens.refreshToken, tokens.providerAccountEmail ?? "", body)
        : await outlook.sendOutlookEmail(tokens.accessToken, tokens.refreshToken, body);
  }

  const thread = await outreach.recordSentEmail(userId, {
    loadRef: body.loadRef ?? null,
    outreachThreadId: body.outreachThreadId ?? null,
    provider,
    connectedAccountId: String(account._id),
    providerThreadId: result.providerThreadId,
    providerMessageId: result.providerMessageId,
    subject: body.subject,
    brokerEmail: body.to,
    bodySnippet: String(body.bodyHtml).replace(/<[^>]+>/g, "").slice(0, 280),
    aiGenerated: body.aiGenerated ?? false,
  });

  return { thread, account, provider, result };
}
