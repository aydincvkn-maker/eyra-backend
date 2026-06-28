// Tek seferlik: loginHistory'de ülkesi boş ama IP'si olan kayıtları geoip ile doldur
require("dotenv").config();
const mongoose = require("mongoose");
const geoip = require("geoip-lite");
const connectDB = require("../src/config/db");
const User = require("../src/models/User");

const countryFromIp = (ip) => {
  const clean = String(ip || "").trim();
  if (!clean) return "";
  try {
    const geo = geoip.lookup(clean);
    return geo?.country
      ? String(geo.country).trim().toUpperCase().slice(0, 2)
      : "";
  } catch {
    return "";
  }
};

(async () => {
  await connectDB();

  const users = await User.find(
    { "loginHistory.0": { $exists: true } },
    { loginHistory: 1, username: 1 },
  );

  let usersUpdated = 0;
  let entriesFilled = 0;

  for (const user of users) {
    let changed = false;
    for (const entry of user.loginHistory) {
      if (!entry.country && entry.ip) {
        const country = countryFromIp(entry.ip);
        if (country) {
          entry.country = country;
          entriesFilled += 1;
          changed = true;
        }
      }
    }
    if (changed) {
      await User.updateOne(
        { _id: user._id },
        { $set: { loginHistory: user.loginHistory } },
      );
      usersUpdated += 1;
      console.log(`✓ ${user.username}: ülke dolduruldu`);
    }
  }

  console.log(
    `\nTamamlandı. Güncellenen kullanıcı: ${usersUpdated}, doldurulan kayıt: ${entriesFilled}`,
  );
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Backfill hatası:", err.message);
  process.exit(1);
});
