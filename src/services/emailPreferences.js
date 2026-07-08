import { ObjectId } from "mongodb";
import { getDb } from "../db/mongo.js";

export async function getEmailPreferences(userId) {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
  return {
    defaultEmailAccountId: user?.defaultEmailAccountId ?? null,
  };
}

export async function setEmailPreferences(userId, { defaultEmailAccountId }) {
  const db = getDb();
  await db.collection("users").updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        defaultEmailAccountId: defaultEmailAccountId ?? null,
        updatedAt: new Date(),
      },
    }
  );
  return getEmailPreferences(userId);
}
