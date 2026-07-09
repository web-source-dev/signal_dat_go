import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import * as savedFilters from "../services/savedFilters.js";
import * as userPreferences from "../services/userPreferences.js";

const router = Router();

/** One round-trip for login / focus / board refresh. */
router.get("/", requireSession, async (req, res, next) => {
  try {
    const [filters, preferences] = await Promise.all([
      savedFilters.listFiltersForUser(req.user.id),
      userPreferences.getUserPreferences(req.user.id),
    ]);
    res.json({
      userId: req.user.id,
      filters,
      preferences,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
