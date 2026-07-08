import { Router } from "express";

const router = Router();

function has(key) {
  return Boolean(process.env[key]?.trim());
}

function hasAny(...keys) {
  return keys.some((key) => has(key));
}

router.get("/", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.get("/config", (_req, res) => {
  res.json({
    status: "ok",
    nodeEnv: process.env.NODE_ENV ?? "development",
    features: {
      database: has("MONGODB_URI") || true,
      tokenEncryption: hasAny("TOKEN_ENCRYPTION_KEY", "EMAIL_ENCRYPTION_KEY"),
      fmcsa: hasAny("FMCSA_WEB_KEY", "FMCSA_WEBKEY"),
      anthropic: hasAny("ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"),
      googleOAuth:
        hasAny("GOOGLE_OAUTH_CLIENT_ID", "GMAIL_CLIENT_ID") &&
        hasAny("GOOGLE_OAUTH_CLIENT_SECRET", "GMAIL_CLIENT_SECRET") &&
        hasAny("GOOGLE_OAUTH_REDIRECT_URI", "GMAIL_REDIRECT_URI"),
      outlookOAuth:
        has("MICROSOFT_OAUTH_CLIENT_ID") &&
        has("MICROSOFT_OAUTH_CLIENT_SECRET") &&
        has("MICROSOFT_OAUTH_REDIRECT_URI"),
      gmailWebhooks: has("GMAIL_PUBSUB_TOPIC"),
      outlookWebhooks: has("MICROSOFT_GRAPH_WEBHOOK_URL"),
    },
  });
});

export default router;
