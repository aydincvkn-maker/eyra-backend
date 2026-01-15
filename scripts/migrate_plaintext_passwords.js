/*
  One-time migration helper.

  The app used to store passwords in plaintext. The backend now hashes passwords
  on save and auto-upgrades a user's password on successful login.

  This script proactively migrates remaining plaintext passwords to bcrypt.

  Usage:
    node scripts/migrate_plaintext_passwords.js --dry-run
    node scripts/migrate_plaintext_passwords.js --yes
    node scripts/migrate_plaintext_passwords.js --yes --limit=500
*/

const bcrypt = require("bcryptjs");
const connectDB = require("../src/config/db");
require("../src/config/env");
const User = require("../src/models/User");

const BCRYPT_ROUNDS = 10;

function getArgValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return null;
  return hit.slice(prefix.length);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const yes = process.argv.includes("--yes");
  const limitRaw = getArgValue("limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : null;

  if (!dryRun && !yes) {
    console.log("Refusing to run without --dry-run or --yes");
    process.exit(2);
  }

  await connectDB();

  // bcrypt hashes start with $2a$, $2b$, or $2y$
  const bcryptPrefixRegex = /^\$2[aby]\$/;

  const query = {
    password: {
      $exists: true,
      $type: "string",
      $not: bcryptPrefixRegex,
      $ne: "",
    },
  };

  const cursor = User.find(query).select("_id email username password");
  if (limit) cursor.limit(limit);

  const users = await cursor.lean();

  console.log(`Found ${users.length} user(s) with plaintext passwords`);

  if (dryRun) {
    console.log("--dry-run enabled, not writing changes.");
    process.exit(0);
  }

  let migrated = 0;

  for (const u of users) {
    const raw = String(u.password || "");
    if (!raw) continue;
    if (bcryptPrefixRegex.test(raw)) continue;

    const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
    const hashed = await bcrypt.hash(raw, salt);

    await User.updateOne({ _id: u._id }, { $set: { password: hashed } });
    migrated++;
  }

  console.log(`Migrated ${migrated} user(s) to bcrypt.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
