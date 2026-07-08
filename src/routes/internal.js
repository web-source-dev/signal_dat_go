import { Router } from "express";
import { requireInternalKey } from "../middleware/internal.js";
import { syncUserFromDatGo } from "../services/auth.js";

const router = Router();

router.use(requireInternalKey);

router.post("/users/sync", async (req, res, next) => {
  try {
    const { datGoUserId, email, name, password, signalEnabled, isBanned } = req.body ?? {};

    if (!datGoUserId || !email) {
      return res.status(400).json({ message: "datGoUserId and email are required" });
    }

    const user = await syncUserFromDatGo({
      datGoUserId: String(datGoUserId),
      email: String(email),
      name: name ? String(name) : undefined,
      password: password ? String(password) : undefined,
      signalEnabled: signalEnabled === true,
      isBanned: isBanned === true,
    });

    res.json({ id: user.id, email: user.email, signalEnabled: user.signalEnabled });
  } catch (error) {
    next(error);
  }
});

export default router;
