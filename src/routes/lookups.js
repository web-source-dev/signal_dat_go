import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { lookupDomain } from "../services/domainIntel.js";
import { fetchCarrierByMc, fetchCarriersByName, getFmcsaWebKey } from "../services/fmcsa.js";

const router = Router();

router.use(requireSession);

function fmcsaErrorPayload(error) {
  const detail = error?.cause?.code || error?.cause?.message || error.message;
  const status =
    error?.code === "FMCSA_FORBIDDEN" || error?.status === 403
      ? 503
      : error?.code === "PROXY_AUTH_REQUIRED" || error?.status === 407
        ? 503
        : 502;
  return {
    status,
    body: {
      message: detail || "FMCSA lookup failed",
      code: error?.code || "FMCSA_LOOKUP_FAILED",
    },
  };
}

router.get("/domains/:domain", async (req, res, next) => {
  try {
    console.log("[lookups] domain", req.params.domain);
    const data = await lookupDomain(req.params.domain);
    res.json(data);
  } catch (error) {
    console.error("[lookups] domain failed", req.params.domain, error);
    next(error);
  }
});

router.get("/carriers/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  console.log("[lookups] carriers/search", { query });

  try {
    if (!query) return res.status(400).json({ message: "q query param is required" });
    const webKey = getFmcsaWebKey();
    if (!webKey) return res.status(503).json({ message: "FMCSA is not configured" });

    if (/^\d+$/.test(query.replace(/\D/g, ""))) {
      const carrier = await fetchCarrierByMc(query, webKey);
      console.log("[lookups] MC result", { query, found: Boolean(carrier), name: carrier?.legalName ?? null });
      return res.json(carrier ? [carrier] : []);
    }

    const carriers = await fetchCarriersByName(query, webKey);
    console.log("[lookups] name result", { query, count: carriers.length });
    res.json(carriers);
  } catch (error) {
    console.error("[lookups] carriers/search failed", { query, message: error.message, code: error.code, cause: error.cause });
    const { status, body } = fmcsaErrorPayload(error);
    res.status(status).json(body);
  }
});

export default router;
