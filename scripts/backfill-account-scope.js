/* eslint-disable no-console */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const connectDB = require("../src/config/db");
const User = require("../src/models/User");

const PANEL_ROLES = ["admin", "super_admin", "moderator"];

(async () => {
  try {
    await connectDB();

    const panelResult = await User.updateMany(
      {
        $or: [{ role: { $in: PANEL_ROLES } }, { isOwner: true }],
      },
      { $set: { accountScope: "panel" } },
    );

    const appResult = await User.updateMany(
      {
        $and: [
          { accountScope: { $exists: false } },
          { role: { $nin: PANEL_ROLES } },
          { isOwner: { $ne: true } },
        ],
      },
      { $set: { accountScope: "app" } },
    );

    const summary = await User.aggregate([
      {
        $group: {
          _id: "$accountScope",
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    console.log("✅ Account scope backfill tamamlandı");
    console.log(`   Panel hesap güncelleme: ${panelResult.modifiedCount}`);
    console.log(`   App hesap güncelleme: ${appResult.modifiedCount}`);
    console.log("   Scope dağılımı:", JSON.stringify(summary));
    process.exit(0);
  } catch (err) {
    console.error("❌ Account scope backfill hatası:", err.message);
    process.exit(1);
  }
})();
