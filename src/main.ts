import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  // Most extension calls use a Bearer token (see SessionGuard), which isn't
  // subject to CORS credential rules — but the one-off dev-login call uses
  // `credentials: "include"` (so its Set-Cookie also lands, letting a
  // window.open()'d OAuth start URL authenticate via the cookie fallback).
  // Its request Origin is `chrome-extension://<id>`, an unpredictable
  // per-install value, so it can't go in a static ALLOWED_ORIGINS list —
  // allow any chrome-extension:// origin alongside the configured web
  // origins (credentialed CORS still can't use a bare wildcard).
  const allowedWebOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",");
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("chrome-extension://") || allowedWebOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed`), false);
      }
    },
    credentials: true,
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[cargosignal-api] listening on :${port}`);
}

bootstrap();
