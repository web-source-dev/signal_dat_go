import { MongoClient } from "mongodb";
import { ensureIndexes } from "../services/connectedAccounts.js";
import { ensureFilterIndexes } from "../services/savedFilters.js";
import { ensureSessionIndexes } from "../services/auth.js";

let client = null;
let db = null;

export async function connectDb() {
  if (db) return db;

  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/cargosignal";
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  await ensureIndexes();
  await ensureFilterIndexes();
  await ensureSessionIndexes();
  console.log("[cargosignal-api] connected to MongoDB");
  return db;
}

export function getDb() {
  if (!db) throw new Error("MongoDB not connected — call connectDb() first");
  return db;
}
