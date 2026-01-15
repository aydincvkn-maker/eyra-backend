// scripts/normalize_user_genders.js
// One-time migration: normalizes all User.gender values to "male" | "female" | "other".

require("dotenv").config();
const mongoose = require("mongoose");

const connectDB = require("../src/config/db");
const User = require("../src/models/User");
const { normalizeGender } = require("../src/utils/gender");

async function main() {
  await connectDB();

  const cursor = User.find({}, { _id: 1, gender: 1 }).cursor();

  let scanned = 0;
  let updated = 0;
  const counts = {
    before: { male: 0, female: 0, other: 0, unknown: 0 },
    after: { male: 0, female: 0, other: 0 },
  };

  for await (const user of cursor) {
    scanned += 1;
    const raw = user.gender;

    const before = raw === "male" || raw === "female" || raw === "other" ? raw : "unknown";
    counts.before[before] += 1;

    const normalized = normalizeGender(raw);
    counts.after[normalized] += 1;

    if (raw !== normalized) {
      await User.updateOne({ _id: user._id }, { $set: { gender: normalized } }, { runValidators: false });
      updated += 1;
    }
  }

  console.log("✅ Gender normalize migration finished");
  console.log({ scanned, updated, counts });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
