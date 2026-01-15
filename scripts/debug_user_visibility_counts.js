// scripts/debug_user_visibility_counts.js
// Prints DB counts to diagnose why user lists might be empty.

require("dotenv").config();

const connectDB = require("../src/config/db");
const User = require("../src/models/User");
const { genderVisibilityQueryForViewer } = require("../src/utils/gender");

async function main() {
  await connectDB();

  const total = await User.countDocuments({});
  const notBanned = await User.countDocuments({ isBanned: { $ne: true } });

  // What an unauthenticated viewer would see (safe default -> female only)
  const visibleForGuest = await User.countDocuments({
    isBanned: { $ne: true },
    gender: genderVisibilityQueryForViewer(null),
  });

  // What a female viewer would see (male + female)
  const visibleForFemaleViewer = await User.countDocuments({
    isBanned: { $ne: true },
    gender: genderVisibilityQueryForViewer("female"),
  });

  const genderAgg = await User.aggregate([
    { $group: { _id: "$gender", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  console.log(
    JSON.stringify(
      {
        total,
        notBanned,
        visibleForGuest,
        visibleForFemaleViewer,
        topGenders: genderAgg.slice(0, 30),
      },
      null,
      2
    )
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ debug_user_visibility_counts failed:", err);
  process.exit(1);
});
