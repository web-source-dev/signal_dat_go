import { Router } from "express";
import {
  SESSION_COOKIE_NAME,
  createSession,
  findOrCreateUserByEmail,
  loginWithPassword,
  revokeAllSessionsForUser,
  revokeSession,
  validateSession,
} from "../services/auth.js";
import { requireSession } from "../middleware/session.js";

const router = Router();

function setSessionCookie(res, token, expiresAt) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    expires: expiresAt,
  });
}

router.post("/login", async (req, res, next) => {
  try {
    const email = req.body?.email;
    const password = req.body?.password;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await loginWithPassword(email, password);
    const { token, expiresAt } = await createSession(user.id, req.headers["user-agent"]);
    setSessionCookie(res, token, expiresAt);

    res.json({ ...user, token });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.[SESSION_COOKIE_NAME];

    // Logout everywhere: revoke every session for this user so other devices
    // are signed out within the next session-refresh / API call.
    const user = token ? await validateSession(token) : null;
    if (user) {
      await revokeAllSessionsForUser(user.id);
    } else {
      await revokeSession(token);
    }

    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/dev-login", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(400).json({ message: "dev-login is disabled in production" });
    }
    const email = req.body?.email;
    if (!email) return res.status(400).json({ message: "email is required" });

    const user = await findOrCreateUserByEmail(email);
    const { token, expiresAt } = await createSession(user.id, req.headers["user-agent"]);
    setSessionCookie(res, token, expiresAt);

    res.json({ id: user.id, email: user.email, token });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireSession, (req, res) => {
  res.json(req.user);
});

export default router;
