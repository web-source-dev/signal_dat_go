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
    // Accept { filters: [...] } or a raw array.
    const body = req.body;
    const filters = Array.isArray(body) ? body : body?.filters;
    if (!Array.isArray(filters)) {
      console.warn("[filters] PUT rejected — body is not an array", typeof body, body && Object.keys(body));
      return res.status(400).json({ message: "filters must be an array" });
    }
    const saved = await savedFilters.replaceFiltersForUser(req.user.id, filters);
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

/** Explicit create/replace alias used by the extension for clearer logging. */
router.post("/", requireSession, async (req, res, next) => {
  try {
    const body = req.body;
    const filters = Array.isArray(body) ? body : body?.filters;
    if (!Array.isArray(filters)) {
      return res.status(400).json({ message: "filters must be an array" });
    }
    const saved = await savedFilters.replaceFiltersForUser(req.user.id, filters);
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

export default router;
