import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { lookupDomain } from "../services/domainIntel.js";
import { fetchCarrierByMc, fetchCarriersByName, getFmcsaWebKey } from "../services/fmcsa.js";

const router = Router();

router.use(requireSession);

router.get("/domains/:domain", async (req, res, next) => {
  try {
    const data = await lookupDomain(req.params.domain);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/carriers/search", async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "").trim();
    if (!query) return res.status(400).json({ message: "q query param is required" });
    const webKey = getFmcsaWebKey();
    if (!webKey) return res.status(503).json({ message: "FMCSA is not configured" });

    if (/^\d+$/.test(query.replace(/\D/g, ""))) {
      const carrier = await fetchCarrierByMc(query, webKey);
      return res.json(carrier ? [carrier] : []);
    }
    const carriers = await fetchCarriersByName(query, webKey);
    res.json(carriers);
  } catch (error) {
    next(error);
  }
});

export default router;
