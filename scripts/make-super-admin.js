/* eslint-disable no-console */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const connectDB = require("../src/config/db");
const User = require("../src/models/User");

const TARGET_EMAIL = "0987sashok@gmail.com";
const TARGET_PASSWORD = "555Sasha";

(async () => {
  try {
    await connectDB();

    let user = await User.findOne({ email: TARGET_EMAIL });

    if (user) {
      console.log(
        `📋 Mevcut kullanıcı bulundu: ${user.email}, role: ${user.role}`,
      );
      user.role = "super_admin";
      user.accountScope = "panel";
      user.isActive = true;
      user.isBanned = false;
      user.isFrozen = false;
      await user.save();
      console.log(
        `✅ Kullanıcı super_admin yapıldı: ${user.email}, yeni role: ${user.role}`,
      );
    } else {
      console.log(`📋 Kullanıcı bulunamadı, yeni super_admin oluşturuluyor...`);
      user = await User.create({
        username: "sasha_admin",
        name: "Sasha Admin",
        email: TARGET_EMAIL,
        password: TARGET_PASSWORD,
        role: "super_admin",
        accountScope: "panel",
        gender: "other",
        age: 25,
        location: "Türkiye",
        country: "TR",
        coins: 0,
        isGuest: false,
        isOnline: false,
        isActive: true,
        isBanned: false,
        isFrozen: false,
      });
      console.log(
        `✅ Super admin oluşturuldu: ${user.email} (id=${user._id}), role: ${user.role}`,
      );
    }

    process.exit(0);
  } catch (err) {
    console.error("❌ Hata:", err.message);
    process.exit(1);
  }
})();
