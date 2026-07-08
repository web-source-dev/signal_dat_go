import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { getInsight } from "../services/brokerInsights.js";

const router = Router();

router.get("/", requireSession, async (req, res, next) => {
  try {
    const { mc, name, phone, email } = req.query;
    if (!mc && !name && !email) {
      return res.status(400).json({ message: "mc, name, or email query param is required" });
    }
    const insight = await getInsight({ mc, name }, phone, email);
    res.json(insight);
  } catch (error) {
    next(error);
  }
});

export default router;
