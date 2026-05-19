/* eslint-disable no-console */
// Tek seferlik bakım scripti.
// aydincvkn@icloud.com hesabını panelden çıkarıp normal mobil kullanıcı yapar.
// Kullanım: node scripts/demote-icloud-account.js
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const connectDB = require("../src/config/db");
const User = require("../src/models/User");

const TARGET_EMAIL = "aydincvkn@icloud.com";

(async () => {
  try {
    await connectDB();

    const user = await User.findOne({
      email: { $regex: `^${TARGET_EMAIL}$`, $options: "i" },
    });

    if (!user) {
      console.log(`Kullanici bulunamadi: ${TARGET_EMAIL}`);
      process.exit(0);
    }

    console.log("Mevcut durum:", {
      _id: user._id.toString(),
      email: user.email,
      role: user.role,
      accountScope: user.accountScope,
      isOwner: user.isOwner,
      isPanelRestricted: user.isPanelRestricted,
    });

    user.role = "viewer";
    user.isOwner = false;
    user.isPanelRestricted = false;
    user.accountScope = "app";
    // pre-save hook accountScope'u tekrar hesaplar; role=viewer + isOwner=false => 'app'.

    await user.save();

    console.log("Yeni durum:", {
      role: user.role,
      accountScope: user.accountScope,
      isOwner: user.isOwner,
    });
    console.log("Tamam. Bu hesap artik mobil uygulamaya giris yapabilir.");
    process.exit(0);
  } catch (err) {
    console.error("Hata:", err && err.message ? err.message : err);
    process.exit(1);
  }
})();
