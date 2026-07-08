import { randomBytes } from "node:crypto";
import { rememberOAuthSession } from "../middleware/session.js";
import * as connectedAccounts from "../services/connectedAccounts.js";
import * as gmail from "../services/gmail.js";

export const OAUTH_STATE_COOKIE = "cs_oauth_state";

function verifyState(req, state) {
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
  if (!state || !cookieState || state !== cookieState) {
    const err = new Error("Invalid or expired OAuth state");
    err.status = 400;
    throw err;
  }
}

function successPage(email) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px">
    <h2>Gmail connected</h2><p>${email} is now connected to CargoSignal. You can close this tab.</p>
  </body></html>`;
}

export function startGmailOAuth(req, res, next) {
  try {
    rememberOAuthSession(res, req.sessionToken);
    const state = randomBytes(16).toString("hex");
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 5 * 60 * 1000 });
    res.redirect(gmail.getGmailAuthUrl(state));
  } catch (error) {
    next(error);
  }
}

export async function completeGmailOAuth(req, res, next) {
  try {
    verifyState(req, req.query.state);
    const tokens = await gmail.exchangeGmailCode(req.query.code);
    const email = await gmail.getGmailUserEmail(tokens.accessToken);

    await connectedAccounts.upsertTokens(req.user.id, "GMAIL", tokens, { providerAccountEmail: email });

    try {
      const historyId = await gmail.watchGmailMailbox(tokens.accessToken);
      await connectedAccounts.setProviderMetadata(req.user.id, "GMAIL", { gmailHistoryId: historyId }, email);
    } catch (error) {
      await connectedAccounts.recordError(req.user.id, "GMAIL", error.message, email);
    }

    res.type("html").send(successPage(email));
  } catch (error) {
    next(error);
  }
}
