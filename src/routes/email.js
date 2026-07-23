import { randomBytes } from "node:crypto";
import { Router } from "express";
import { requireSession, rememberOAuthSession } from "../middleware/session.js";
import * as connectedAccounts from "../services/connectedAccounts.js";
import * as outreach from "../services/outreach.js";
import * as gmail from "../services/gmail.js";
import * as outlook from "../services/outlook.js";
import * as smtp from "../services/smtp.js";
import { inferImapFromSmtp } from "../services/smtpImap.js";
import { verifyImapConnection } from "../services/smtpImapVerify.js";
import { completeGmailOAuth, startGmailOAuth } from "../handlers/gmailOAuth.js";

const router = Router();
const OAUTH_STATE_COOKIE = "cs_oauth_state";

function verifyState(req, state) {
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
  if (!state || !cookieState || state !== cookieState) {
    const err = new Error("Invalid or expired OAuth state");
    err.status = 400;
    throw err;
  }
}

function successPage(provider, email) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px">
    <h2>${provider} connected</h2><p>${email} is now connected to CargoSignal. You can close this tab.</p>
  </body></html>`;
}

router.get("/oauth/google/start", requireSession, startGmailOAuth);
router.get("/oauth/google/callback", requireSession, completeGmailOAuth);

router.get("/oauth/outlook/start", requireSession, (req, res, next) => {
  try {
    rememberOAuthSession(res, req.sessionToken);
    const state = randomBytes(16).toString("hex");
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 5 * 60 * 1000 });
    res.redirect(outlook.getOutlookAuthUrl(state));
  } catch (error) {
    next(error);
  }
});

router.get("/oauth/outlook/callback", requireSession, async (req, res, next) => {
  try {
    verifyState(req, req.query.state);
    const tokens = await outlook.exchangeOutlookCode(req.query.code);
    const email = await outlook.getOutlookUserEmail(tokens.accessToken, tokens.refreshToken);

    await connectedAccounts.upsertTokens(req.user.id, "OUTLOOK", tokens, { providerAccountEmail: email });

    try {
      const clientState = randomBytes(16).toString("hex");
      const subscription = await outlook.createOutlookSubscription(
        tokens.accessToken,
        tokens.refreshToken,
        clientState
      );
      await connectedAccounts.setProviderMetadata(req.user.id, "OUTLOOK", {
        graphSubscriptionId: subscription.id,
        graphSubscriptionExpiresAt: subscription.expirationDateTime,
        graphClientState: clientState,
      }, email);
    } catch (error) {
      await connectedAccounts.recordError(req.user.id, "OUTLOOK", error.message, email);
    }

    res.type("html").send(successPage("Outlook", email));
  } catch (error) {
    next(error);
  }
});

router.post("/smtp/connect", requireSession, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    const smtpHost = String(body.smtpHost ?? "").trim();
    const smtpPort = Number(body.smtpPort ?? 587);
    const smtpSecure = Boolean(body.smtpSecure);

    if (!email || !password || !smtpHost || !smtpPort) {
      return res.status(400).json({ message: "email, password, smtpHost, and smtpPort are required" });
    }

    const config = { email, password, smtpHost, smtpPort, smtpSecure };
    await smtp.verifySmtpConnection(config);

    let imapSettings = inferImapFromSmtp(smtpHost, email);
    let imapVerified = false;
    const imapCandidates = [
      imapSettings,
      imapSettings?.imapHost !== "imap.gmail.com" ? { imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true } : null,
    ].filter(Boolean);

    for (const candidate of imapCandidates) {
      try {
        await verifyImapConnection({ email, password, ...candidate });
        imapSettings = candidate;
        imapVerified = true;
        break;
      } catch {
        // try next candidate
      }
    }

    await connectedAccounts.upsertSmtpAccount(req.user.id, {
      ...config,
      imapHost: imapSettings?.imapHost ?? null,
      imapPort: imapSettings?.imapPort ?? null,
      imapSecure: imapSettings?.imapSecure !== false,
    });

    const accounts = await connectedAccounts.listForUser(req.user.id);
    const account = accounts.find(
      (row) => row.provider === "SMTP" && row.email?.toLowerCase() === email.toLowerCase()
    );

    res.json({
      provider: "SMTP",
      id: account?.id,
      email,
      status: "ACTIVE",
      imapVerified,
      imapHost: imapSettings?.imapHost ?? null,
      imapWarning: imapVerified
        ? null
        : "SMTP send works but IMAP could not be verified — inbox reply sync may not work until IMAP is enabled for this mailbox.",
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/smtp/disconnect", requireSession, async (req, res, next) => {
  try {
    const accountId = req.body?.accountId ? String(req.body.accountId) : null;
    if (accountId) {
      const disconnected = await connectedAccounts.disconnectAccount(req.user.id, accountId);
      if (!disconnected) {
        return res.status(404).json({ message: "Connected account not found" });
      }
      return res.json({ disconnected: true });
    }

    await connectedAccounts.disconnectProvider(req.user.id, "SMTP");
    res.json({ disconnected: true });
  } catch (error) {
    next(error);
  }
});

async function resolveSendAccount(userId, body) {
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

  const { getEmailPreferences } = await import("../services/emailPreferences.js");
  const prefs = await getEmailPreferences(userId);
  if (prefs.defaultEmailAccountId) {
    const account = await connectedAccounts.getAccountById(userId, prefs.defaultEmailAccountId);
    if (account && account.status !== "ERROR") return account;
  }

  const preferred =
    body.provider === "SMTP" ? "SMTP" : body.provider === "OUTLOOK" ? "OUTLOOK" : body.provider === "GMAIL" ? "GMAIL" : null;

  // Prefer an account matching the requested provider, then any active mailbox
  // (SMTP users were failing when the client still defaulted to GMAIL).
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

router.post("/send", requireSession, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!body.to || !body.subject || !body.bodyHtml) {
      return res.status(400).json({ message: "to, subject, and bodyHtml are required" });
    }

    const account = await resolveSendAccount(req.user.id, body);
    const provider = account.provider;
    let result;

    if (provider === "SMTP") {
      const config = await connectedAccounts.getSmtpConfig(req.user.id, String(account._id));
      if (!config) {
        return res.status(400).json({
          message: "No SMTP account connected — connect your mailbox manually in Account first",
        });
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
          ? await connectedAccounts.getValidGmailTokens(req.user.id, null, String(account._id))
          : await connectedAccounts.getDecryptedTokensForAccount(req.user.id, String(account._id));
      if (!tokens) {
        return res.status(400).json({
          message: `No connected ${provider} account — connect Gmail or Outlook in Account first`,
        });
      }

      result =
        provider === "GMAIL"
          ? await gmail.sendGmailEmail(tokens.accessToken, tokens.refreshToken, tokens.providerAccountEmail ?? "", body)
          : await outlook.sendOutlookEmail(tokens.accessToken, tokens.refreshToken, body);
    }

    const thread = await outreach.recordSentEmail(req.user.id, {
      loadRef: body.loadRef ?? null,
      outreachThreadId: body.outreachThreadId ?? null,
      provider,
      connectedAccountId: String(account._id),
      providerThreadId: result.providerThreadId,
      providerMessageId: result.providerMessageId,
      subject: body.subject,
      brokerEmail: body.to,
      bodySnippet: body.bodyHtml.replace(/<[^>]+>/g, "").slice(0, 280),
      aiGenerated: body.aiGenerated ?? false,
    });

    res.json(thread);
  } catch (error) {
    next(error);
  }
});

export default router;
