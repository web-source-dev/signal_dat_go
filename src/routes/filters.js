import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import * as savedFilters from "../services/savedFilters.js";

const router = Router();

router.get("/", requireSession, async (req, res, next) => {
  try {
    res.json(await savedFilters.listFiltersForUser(req.user.id));
  } catch (error) {
    next(error);
  }
});

router.put("/", requireSession, async (req, res, next) => {
  try {
    const filters = req.body?.filters ?? req.body;
    if (!Array.isArray(filters)) {
      return res.status(400).json({ message: "filters must be an array" });
    }
    res.json(await savedFilters.replaceFiltersForUser(req.user.id, filters));
  } catch (error) {
    next(error);
  }
});

export default router;
