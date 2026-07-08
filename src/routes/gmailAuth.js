import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { completeGmailOAuth, startGmailOAuth } from "../handlers/gmailOAuth.js";

/**
 * Loadline-compatible Gmail OAuth paths — matches the redirect URI already
 * registered in Google Cloud Console:
 *   http://localhost:3005/api/auth/gmail/callback
 */
const router = Router();

router.get("/connect", requireSession, startGmailOAuth);
router.get("/callback", requireSession, completeGmailOAuth);

export default router;
