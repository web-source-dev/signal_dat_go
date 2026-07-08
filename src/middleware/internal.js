export function requireInternalKey(req, res, next) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return res.status(503).json({ message: "Internal API is not configured" });
  }

  const provided = req.headers["x-internal-key"];
  if (!provided || provided !== expected) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  next();
}
