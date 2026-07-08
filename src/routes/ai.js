import { Router } from "express";
import { requireSession } from "../middleware/session.js";
import { suggestReply, polishEmail, generateTemplate, improveTemplate } from "../services/ai.js";

const router = Router();

router.post("/suggest-reply", requireSession, async (req, res, next) => {
  try {
    const hasConversation = Array.isArray(req.body?.conversation) && req.body.conversation.length > 0;
    if (!req.body?.brokerEmailBody && !hasConversation) {
      return res.status(400).json({ message: "brokerEmailBody or conversation is required" });
    }
    const suggestion = await suggestReply(req.body);
    res.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

router.post("/polish-email", requireSession, async (req, res, next) => {
  try {
    if (!req.body?.draftBody) {
      return res.status(400).json({ message: "draftBody is required" });
    }
    const suggestion = await polishEmail(req.body);
    res.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

router.post("/generate-template", requireSession, async (req, res, next) => {
  try {
    const template = await generateTemplate(req.body ?? {});
    res.json(template);
  } catch (error) {
    next(error);
  }
});

router.post("/improve-template", requireSession, async (req, res, next) => {
  try {
    if (!req.body?.subject && !req.body?.body) {
      return res.status(400).json({ message: "subject or body is required" });
    }
    const template = await improveTemplate(req.body);
    res.json(template);
  } catch (error) {
    next(error);
  }
});

export default router;
