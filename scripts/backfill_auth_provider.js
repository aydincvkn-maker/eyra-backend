// scripts/backfill_auth_provider.js
// Mevcut kullanıcıların authProvider alanını email/phone/guest olarak ayarla
// Çalıştır: node scripts/backfill_auth_provider.js

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/User");

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log("DB connected");

  // Guest kullanıcıları
  const guestResult = await User.updateMany(
    {
      isGuest: true,
      $or: [{ authProvider: { $exists: false } }, { authProvider: null }],
    },
    { $set: { authProvider: "guest" } },
  );
  console.log(`Guest: ${guestResult.modifiedCount} updated`);

  // Telefon girişli kullanıcılar (email @phone ile biter veya phone field dolu)
  const phoneResult = await User.updateMany(
    {
      $or: [
        { email: { $regex: /@phone\./i } },
        { phone: { $exists: true, $ne: "", $ne: null } },
      ],
      isGuest: { $ne: true },
      $or: [{ authProvider: { $exists: false } }, { authProvider: null }],
    },
    { $set: { authProvider: "phone" } },
  );
  console.log(`Phone: ${phoneResult.modifiedCount} updated`);

  // Kalanlar email olarak ayarla
  const emailResult = await User.updateMany(
    { $or: [{ authProvider: { $exists: false } }, { authProvider: null }] },
    { $set: { authProvider: "email" } },
  );
  console.log(`Email (default): ${emailResult.modifiedCount} updated`);

  // Sonuç özeti
  const stats = await User.aggregate([
    { $group: { _id: "$authProvider", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log("\nAuthProvider distribution:");
  stats.forEach((s) => console.log(`  ${s._id || "null"}: ${s.count}`));

  await mongoose.disconnect();
  console.log("\nDone");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
