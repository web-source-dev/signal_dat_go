import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import * as connectedAccounts from "../services/connectedAccounts.js";

const router = Router();

router.get("/accounts", requireSession, async (req, res, next) => {
  try {
    const accounts = await connectedAccounts.listForUser(req.user.id);
    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

export default router;
