/**
 * CargoSignal API — simple Express + MongoDB server.
 *
 *   npm install
 *   npm start
 *
 * No Docker, no PostgreSQL, no build step.
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { connectDb } from "./src/db/mongo.js";
import { startReplySync } from "./src/services/replySync.js";

import healthRoutes from "./src/routes/health.js";
import authRoutes from "./src/routes/auth.js";
import emailRoutes from "./src/routes/email.js";
import outreachRoutes from "./src/routes/outreach.js";
import brokerInsightsRoutes from "./src/routes/brokerInsights.js";
import aiRoutes from "./src/routes/ai.js";
import notificationsRoutes from "./src/routes/notifications.js";
import lookupsRoutes from "./src/routes/lookups.js";
import gmailAuthRoutes from "./src/routes/gmailAuth.js";
import emailAccountsRoutes from "./src/routes/emailAccounts.js";
import filtersRoutes from "./src/routes/filters.js";
import preferencesRoutes from "./src/routes/preferences.js";
import internalRoutes from "./src/routes/internal.js";

const app = express();
const allowedWebOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",");

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Private-Network", "true");
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin.startsWith("chrome-extension://") || allowedWebOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

app.use("/health", healthRoutes);
app.use("/auth", authRoutes);
app.use("/email", emailRoutes);
app.use("/email", emailAccountsRoutes);
app.use("/api/auth/gmail", gmailAuthRoutes);
app.use("/outreach", outreachRoutes);
app.use("/broker-insights", brokerInsightsRoutes);
app.use("/ai", aiRoutes);
app.use("/notifications", notificationsRoutes);
app.use("/lookups", lookupsRoutes);
app.use("/filters", filtersRoutes);
app.use("/preferences", preferencesRoutes);
app.use("/internal", internalRoutes);

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  console.error("[cargosignal-api]", err);
  res.status(status).json({ message: err.message ?? "Internal server error" });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3005;

await connectDb();
startReplySync();
app.listen(port, () => {
  console.log(`[cargosignal-api] listening on :${port}`);
});
