import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import * as userPreferences from "../services/userPreferences.js";

const router = Router();

router.get("/", requireSession, async (req, res, next) => {
  try {
    res.json(await userPreferences.getUserPreferences(req.user.id));
  } catch (error) {
    next(error);
  }
});

router.put("/", requireSession, async (req, res, next) => {
  try {
    res.json(await userPreferences.setUserPreferences(req.user.id, req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

export default router;
