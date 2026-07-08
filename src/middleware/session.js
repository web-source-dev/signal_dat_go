import { SESSION_COOKIE_NAME, validateSession } from "../services/auth.js";

const OAUTH_SESSION_COOKIE = "cs_oauth_session";

/**
 * Resolve session credential from Authorization header, ?token= query param
 * (extension OAuth tab navigation), or session cookies.
 */
export function extractSessionToken(req) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (bearer) return bearer;

  const queryToken = req.query?.token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();

  if (req.cookies?.[SESSION_COOKIE_NAME]) return req.cookies[SESSION_COOKIE_NAME];
  if (req.cookies?.[OAUTH_SESSION_COOKIE]) return req.cookies[OAUTH_SESSION_COOKIE];

  return null;
}

export function rememberOAuthSession(res, token) {
  res.cookie(OAUTH_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 15 * 60 * 1000,
  });
}

export async function requireSession(req, res, next) {
  try {
    const token = extractSessionToken(req);
    if (!token) return res.status(401).json({ message: "No session credential" });

    const user = await validateSession(token);
    if (!user) return res.status(401).json({ message: "Invalid or expired session" });

    req.user = user;
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}
