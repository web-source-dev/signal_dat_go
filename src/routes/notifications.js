import { Router } from "express";
import { validateSession } from "../services/auth.js";
import { subscribeNotifications } from "../services/notifications.js";

const router = Router();

router.get("/sse", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ message: "token query param is required" });

  const user = await validateSession(token);
  if (!user) return res.status(401).json({ message: "Invalid or expired session" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");

  const unsubscribe = subscribeNotifications(user.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
