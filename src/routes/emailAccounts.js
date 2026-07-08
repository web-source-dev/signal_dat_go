import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import * as connectedAccounts from "../services/connectedAccounts.js";
import * as emailPreferences from "../services/emailPreferences.js";

const router = Router();

router.get("/accounts", requireSession, async (req, res, next) => {
  try {
    const accounts = await connectedAccounts.listForUser(req.user.id);
    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

router.delete("/accounts/:accountId", requireSession, async (req, res, next) => {
  try {
    const disconnected = await connectedAccounts.disconnectAccount(req.user.id, req.params.accountId);
    if (!disconnected) {
      return res.status(404).json({ message: "Connected account not found" });
    }
    res.json({ disconnected: true });
  } catch (error) {
    next(error);
  }
});

router.get("/preferences", requireSession, async (req, res, next) => {
  try {
    res.json(await emailPreferences.getEmailPreferences(req.user.id));
  } catch (error) {
    next(error);
  }
});

router.put("/preferences", requireSession, async (req, res, next) => {
  try {
    const { defaultEmailAccountId } = req.body ?? {};
    if (defaultEmailAccountId) {
      const account = await connectedAccounts.getAccountById(req.user.id, String(defaultEmailAccountId));
      if (!account) {
        return res.status(400).json({ message: "Default account not found for this user" });
      }
    }
    const prefs = await emailPreferences.setEmailPreferences(req.user.id, {
      defaultEmailAccountId: defaultEmailAccountId ? String(defaultEmailAccountId) : null,
    });
    res.json(prefs);
  } catch (error) {
    next(error);
  }
});

export default router;
