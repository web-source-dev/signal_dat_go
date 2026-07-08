import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check() {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("config")
  config() {
    const has = (key: string) => Boolean(process.env[key]?.trim());
    const hasAny = (...keys: string[]) => keys.some((key) => has(key));
    return {
      status: "ok",
      nodeEnv: process.env.NODE_ENV ?? "development",
      features: {
        database: has("DATABASE_URL"),
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
    };
  }
}
