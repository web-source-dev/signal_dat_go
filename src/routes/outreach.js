import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { listForUser } from "../services/outreach.js";
import { syncAllRepliesForUser } from "../services/replySync.js";

const router = Router();

router.get("/", requireSession, async (req, res, next) => {
  try {
    const threads = await listForUser(req.user.id);
    res.json(threads);
  } catch (error) {
    next(error);
  }
});

router.post("/sync", requireSession, async (req, res, next) => {
  try {
    const syncResult = await syncAllRepliesForUser(req.user.id);
    const threads = await listForUser(req.user.id);
    res.json({ threads, sync: syncResult });
  } catch (error) {
    next(error);
  }
});

export default router;
