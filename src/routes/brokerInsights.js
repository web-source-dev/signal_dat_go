import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { getInsight } from "../services/brokerInsights.js";

const router = Router();

router.get("/", requireSession, async (req, res, next) => {
  try {
    const { mc, name, phone, email } = req.query;
    console.log("[broker-insights] request", { mc, name, phone: phone ? "(set)" : null, email: email ? "(set)" : null });
    if (!mc && !name && !email) {
      return res.status(400).json({ message: "mc, name, or email query param is required" });
    }
    const insight = await getInsight({ mc, name }, phone, email);
    console.log("[broker-insights] response", {
      mc: insight?.mcNumber ?? null,
      hasCompany: Boolean(insight?.company),
      fmcsaNote: insight?.meta?.fmcsaNote ?? null,
    });
    res.json(insight);
  } catch (error) {
    console.error("[broker-insights] failed", { message: error.message, code: error.code, stack: error.stack });
    next(error);
  }
});

export default router;
