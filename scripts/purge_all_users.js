/*
  DANGEROUS: Purge ALL users.

  This deletes ALL documents from MongoDB User collection.
  Best-effort cleanup:
    - Firebase RTDB /presence
    - Redis keys presence:*

  Usage:
    node scripts/purge_all_users.js --dry-run
    node scripts/purge_all_users.js --yes

  Optional:
    --keep-admins   Keep users with role in [super_admin, admin, moderator]
*/

require("../src/config/env");

const connectDB = require("../src/config/db");
const User = require("../src/models/User");
const { getFirebaseDatabase, initializeFirebase } = require("../src/config/firebase");
const { getRedisClient, connectRedis } = require("../src/config/redis");

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

async function deleteRedisPresenceKeys(redis) {
  // Safe, iterative scan to avoid blocking Redis.
  let cursor = "0";
  let deleted = 0;

  do {
    // ioredis: scan(cursor, 'MATCH', pattern, 'COUNT', n)
    // node-redis v5: scan(cursor, { MATCH, COUNT }) -> but we use ioredis in this repo.
    // We'll detect by checking function arity and fallback.
    let res;
    try {
      res = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", "1000");
    } catch (e) {
      // Fallback for node-redis style
      res = await redis.scan(cursor, { MATCH: "presence:*", COUNT: 1000 });
    }

    const nextCursor = Array.isArray(res) ? String(res[0]) : String(res.cursor || "0");
    const keys = Array.isArray(res) ? res[1] : res.keys || [];

    if (keys.length > 0) {
      try {
        // ioredis supports unlink; fall back to del
        if (typeof redis.unlink === "function") {
          deleted += await redis.unlink(...keys);
        } else {
          deleted += await redis.del(...keys);
        }
      } catch (_) {
        // ignore
      }
    }

    cursor = nextCursor;
  } while (cursor !== "0");

  return deleted;
}

async function main() {
  const dryRun = hasArg("dry-run");
  const yes = hasArg("yes");
  const keepAdmins = hasArg("keep-admins");

  if (!dryRun && !yes) {
    console.log("Refusing to run without --dry-run or --yes");
    process.exit(2);
  }

  await connectDB();

  const query = keepAdmins
    ? { role: { $nin: ["super_admin", "admin", "moderator"] } }
    : {};

  const totalUsers = await User.countDocuments({});
  const toDelete = await User.countDocuments(query);

  console.log(`Total users in DB: ${totalUsers}`);
  console.log(`Users to delete:   ${toDelete}${keepAdmins ? " (keeping admin roles)" : ""}`);

  if (dryRun) {
    console.log("--dry-run enabled, not deleting.");
    process.exit(0);
  }

  const result = await User.deleteMany(query);
  console.log(`Deleted users: ${result.deletedCount}`);

  // Best-effort: Firebase presence wipe
  try {
    initializeFirebase();
    const db = getFirebaseDatabase();
    if (db) {
      await db.ref("presence").remove();
      console.log("Cleared Firebase RTDB /presence");
    } else {
      console.log("Firebase not initialized; skipped RTDB presence cleanup");
    }
  } catch (e) {
    console.log(`Firebase presence cleanup skipped: ${e.message}`);
  }

  // Best-effort: Redis presence cache wipe
  try {
    await connectRedis();
    const redis = getRedisClient();
    if (redis) {
      const deleted = await deleteRedisPresenceKeys(redis);
      console.log(`Cleared Redis presence cache keys: ${deleted}`);
    } else {
      console.log("Redis client not available; skipped Redis cleanup");
    }
  } catch (e) {
    console.log(`Redis cleanup skipped: ${e.message}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Purge failed:", err);
  process.exit(1);
});
