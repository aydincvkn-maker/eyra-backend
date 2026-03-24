/* eslint-disable no-console */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const connectDB = require("../src/config/db");
const User = require("../src/models/User");

const [emailArg, usernameArg, nameArg, passwordArg] = process.argv.slice(2);

const email = String(emailArg || process.env.OWNER_EMAIL || "")
  .trim()
  .toLowerCase();
const usernameInput = String(usernameArg || process.env.OWNER_USERNAME || "")
  .trim();
const displayName = String(nameArg || process.env.OWNER_NAME || "Patron")
  .trim();
const password = String(passwordArg || process.env.OWNER_PASSWORD || "").trim();

const ensureUniqueUsername = async (baseUsername, currentUserId = null) => {
  let candidate = baseUsername;
  let suffix = 1;

  while (true) {
    const existing = await User.findOne({ username: candidate })
      .select("_id")
      .lean();
    if (!existing || String(existing._id) === String(currentUserId || "")) {
      return candidate;
    }
    candidate = `${baseUsername}${suffix}`;
    suffix += 1;
  }
};

(async () => {
  if (!email || !usernameInput || !password) {
    console.error(
      "❌ Kullanım: node scripts/restore-owner-account.js <email> <username> <name> <password>",
    );
    process.exit(1);
  }

  try {
    await connectDB();

    let user = await User.findOne({ email });
    const username = await ensureUniqueUsername(usernameInput, user?._id);

    if (!user) {
      user = await User.create({
        username,
        name: displayName,
        email,
        password,
        role: "super_admin",
        authProvider: "email",
        gender: "other",
        country: "TR",
        location: "Türkiye",
        coins: 0,
        isGuest: false,
        isOnline: false,
        isActive: true,
        isBanned: false,
        isFrozen: false,
        isPanelRestricted: false,
        isOwner: true,
      });
      console.log(`✅ Owner hesabı oluşturuldu: ${user.email} (${user.username})`);
    } else {
      user.username = username;
      user.name = displayName;
      user.password = password;
      user.role = "super_admin";
      user.authProvider = "email";
      user.isGuest = false;
      user.isActive = true;
      user.isBanned = false;
      user.isFrozen = false;
      user.isPanelRestricted = false;
      user.isOwner = true;
      await user.save();
      console.log(`✅ Owner hesabı güncellendi: ${user.email} (${user.username})`);
    }

    await User.updateMany(
      {
        _id: { $ne: user._id },
        role: "super_admin",
        isOwner: true,
      },
      { $set: { isOwner: false } },
    );

    console.log("✅ Patron hesabı panel için hazır.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Owner restore hatası:", err.message);
    process.exit(1);
  }
})();