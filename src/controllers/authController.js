const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const appleSignin = require("apple-signin-auth");
const { normalizeGender } = require("../utils/gender");
const { JWT_SECRET, NODE_ENV, JWT_EXPIRES_IN } = require("../config/env");
const presenceService = require("../services/presenceService");
const SystemSettings = require("../models/SystemSettings");
const Transaction = require("../models/Transaction");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const resolveGender = (gender) => {
  const normalized = normalizeGender(gender);
  // E─şer gender belirtilmemi┼şse (null/undefined/bo┼ş), varsay─▒lan olarak female ata
  // Ama kullan─▒c─▒ a├ğ─▒k├ğa "other" se├ğtiyse, bunu kabul et
  if (!normalized || normalized === "other") {
    // E─şer input "other" olarak a├ğ─▒k├ğa belirtilmi┼şse, kabul et
    const rawGender = String(gender || "").trim().toLowerCase();
    if (rawGender === "other" || rawGender === "di─şer" || rawGender === "diger") {
      return "other"; // Kullan─▒c─▒n─▒n tercihi
    }
    // Aksi halde varsay─▒lan
    return "female";
  }
  return normalized;
};

const createToken = (user, expiresIn = JWT_EXPIRES_IN || "30d") =>
  jwt.sign(
    { id: user._id, email: user.email, username: user.username, role: user.role || "user" },
    JWT_SECRET,
    { expiresIn }
  );

const getAuthCookieOptions = () => {
  const isProd = NODE_ENV === "production";
  const sameSite = process.env.COOKIE_SAMESITE || (isProd ? "none" : "lax");
  const secure = sameSite === "none" ? true : isProd;

  return {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: 1000 * 60 * 60 * 24 * 90,
  };
};

const buildUserPayload = (user) => ({
  _id: user._id,
  username: user.username,
  name: user.name,
  email: user.email,
  gender: user.gender,
  age: user.age,
  location: user.location,
  country: user.country,
  bio: user.bio || "",
  profileImage: user.profileImage,
  coins: user.coins,
  level: user.level,
  followers: user.followers || 0,
  following: user.following || 0,
  gifts: user.gifts || 0,
  settings: user.settings || {},
  isGuest: user.isGuest,
  isOnline: user.isOnline,
  lastSeen: user.lastSeen,
  lastOnlineAt: user.lastOnlineAt,
  role: user.role,
  permissions: user.permissions || [],
  isOwner: user.isOwner || false,
  isPanelRestricted: user.isPanelRestricted || false,
});

// G├╝nl├╝k giri┼ş bonusu kontrol├╝ ve verme
const checkDailyLoginBonus = async (user) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Bug├╝n zaten bonus ald─▒ysa atla
    if (user.dailyLoginAt && user.dailyLoginAt >= todayStart) {
      return { granted: false, reason: "already_claimed" };
    }

    const settings = await SystemSettings.findOne().lean();
    const bonusAmount = settings?.dailyLoginBonus || 50;

    // Login streak hesapla
    const yesterday = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    let newStreak = 1;
    if (user.dailyLoginAt && user.dailyLoginAt >= yesterday) {
      newStreak = (user.loginStreak || 0) + 1;
    }

    // Streak bonusu: her 7 g├╝nde ekstra %50
    const streakMultiplier = Math.floor(newStreak / 7) > 0 ? 1.5 : 1;
    const totalBonus = Math.floor(bonusAmount * streakMultiplier);

    user.coins = (user.coins || 0) + totalBonus;
    user.dailyLoginAt = now;
    user.loginStreak = newStreak;
    await user.save();

    // Transaction kayd─▒
    try {
      await Transaction.create({
        user: user._id,
        type: "daily_bonus",
        amount: totalBonus,
        balanceAfter: user.coins,
        description: `G├╝nl├╝k giri┼ş bonusu (${newStreak}. g├╝n seri)`,
        status: "completed",
      });
    } catch (_) {}

    // Mission tracking
    try {
      const { trackMissionProgress } = require("./missionController");
      await trackMissionProgress(user._id, "daily_login");
    } catch (_) {}

    return {
      granted: true,
      amount: totalBonus,
      streak: newStreak,
      streakBonus: streakMultiplier > 1,
    };
  } catch (err) {
    console.error("Daily login bonus error:", err);
    return { granted: false, reason: "error" };
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: "Email ve ┼şifre gerekli",
        error: "Email ve ┼şifre gerekli",
      });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Email veya ┼şifre hatal─▒",
        error: "Email veya ┼şifre hatal─▒",
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Email veya ┼şifre hatal─▒",
        error: "Email veya ┼şifre hatal─▒",
      });
    }

    // Ô£à Upgrade legacy plaintext passwords to bcrypt on successful login
    // This keeps existing users working while making the system secure going forward.
    if (typeof user.isPasswordHashed === "function" && !user.isPasswordHashed()) {
      try {
        user.password = String(password);
        await user.save();
      } catch (e) {
        // Non-fatal: don't block login if migration fails
        console.warn("ÔÜá´©Å Password upgrade failed:", e.message);
      }
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: "Hesab─▒n─▒z ask─▒ya al─▒nm─▒┼ş",
        error: "Hesab─▒n─▒z ask─▒ya al─▒nm─▒┼ş",
      });
    }

    // NOT: isOnline durumu socket ba─şlant─▒s─▒nda g├╝ncellenecek
    // Login sadece lastSeen'i günceller + login history kaydeder
    try {
      const loginEntry = {
        platform: String(req.headers['x-platform'] || req.headers['user-agent'] || '').slice(0, 200),
        device: String(req.headers['x-device'] || '').slice(0, 200),
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '',
        loginAt: new Date(),
      };
      await User.updateOne(
        { _id: user._id },
        {
          $set: { lastSeen: new Date() },
          $push: { loginHistory: { $each: [loginEntry], $slice: -50 } },
        }
      );
    } catch (e) {
      console.warn("⚠️ Login: lastSeen/history update başarısız:", e.message);
      // Non-fatal: devam et
    }

    const token = createToken(user);

    res.cookie("auth_token", token, getAuthCookieOptions());

    // G├╝nl├╝k giri┼ş bonusu
    const dailyBonus = await checkDailyLoginBonus(user);

    res.json({
      success: true,
      token,
      user: buildUserPayload(user),
      dailyBonus: dailyBonus.granted ? dailyBonus : undefined,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      success: false,
      message: "Sunucu hatas─▒",
      error: "Sunucu hatas─▒",
    });
  }
};

exports.register = async (req, res) => {
  try {
    const { username, name, email, password, gender, age, location, country } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail || !password || !username || !name) {
      return res.status(400).json({
        success: false,
        message: "Gerekli alanlar─▒ doldurun",
        error: "Gerekli alanlar─▒ doldurun",
      });
    }

    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) {
      return res.status(400).json({
        success: false,
        message: "Bu email zaten kay─▒tl─▒",
        error: "Bu email zaten kay─▒tl─▒",
      });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({
        success: false,
        message: "Bu kullan─▒c─▒ ad─▒ al─▒nm─▒┼ş",
        error: "Bu kullan─▒c─▒ ad─▒ al─▒nm─▒┼ş",
      });
    }

    const normalizedGender = resolveGender(gender);

    const user = await User.create({
      username,
      name,
      email: normalizedEmail,
      password,
      gender: normalizedGender,
      age: Number.isFinite(age) ? age : 20,
      location: location || "T├╝rkiye",
      country: country || "TR",
      coins: 1000,
      isGuest: false,
      isOnline: false,
      lastSeen: new Date(),
    });

    const token = createToken(user);

    res.status(201).json({
      success: true,
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({
      success: false,
      message: "Kay─▒t ba┼şar─▒s─▒z",
      error: "Kay─▒t ba┼şar─▒s─▒z",
    });
  }
};

exports.guestLogin = async (req, res) => {
  try {
    const { name, gender, age, country, location } = req.body;

    if (!gender) {
      return res.status(400).json({
        success: false,
        message: "Cinsiyet se├ğmek zorunlu",
        error: "Cinsiyet se├ğmek zorunlu",
      });
    }

    const normalizedGender = resolveGender(gender);
    const timestamp = Date.now();
    const username = `guest_${timestamp}`;
    const email = `${username}@guest.local`;

    const user = await User.create({
      username,
      name: name || `Guest ${timestamp}`,
      email,
      password: Math.random().toString(36).slice(-8),
      gender: normalizedGender,
      age: Number.isFinite(age) && age > 0 ? age : 20,
      location: location || country || "T├╝rkiye",
      country: country || "TR",
      coins: 0,
      isGuest: true,
      isOnline: false,  // Socket ba─şlant─▒s─▒nda true yap─▒lacak
      lastSeen: new Date(),
      lastOnlineAt: new Date(),
      isBusy: false,
      busyUntil: null,
    });

    const token = createToken(user, "7d");

    res.json({
      success: true,
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("Guest login error:", err);
    res.status(500).json({
      success: false,
      message: "Misafir giri┼şi ba┼şar─▒s─▒z",
      error: "Misafir giri┼şi ba┼şar─▒s─▒z",
    });
  }
};

// ­şöÆ DEPRECATED: Token do─şrulamas─▒ olmayan Google login g├╝venlik a├ğ─▒─ş─▒ olu┼şturur.
// T├╝m istemciler /google-login-token endpoint'ini kullanmal─▒d─▒r.
exports.googleLogin = async (req, res) => {
  console.warn("ÔÜá´©Å DEPRECATED: /google-login ├ğa─şr─▒ld─▒ (token do─şrulamas─▒ yok). ─░stemci g├╝ncellenmeli.");
  return res.status(403).json({
    success: false,
    message: "Bu giri┼ş y├Ântemi art─▒k desteklenmiyor. L├╝tfen uygulamay─▒ g├╝ncelleyin.",
    error: "Bu giri┼ş y├Ântemi art─▒k desteklenmiyor. L├╝tfen uygulamay─▒ g├╝ncelleyin.",
    code: "GOOGLE_LOGIN_DEPRECATED",
  });
};

exports.googleLoginWithToken = async (req, res) => {
  try {
    const { idToken, email, name, photoUrl, gender } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!idToken || !normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "ID token ve email gerekli",
        error: "ID token ve email gerekli",
      });
    }

    // ­şöÆ GOOGLE_CLIENT_ID kontrol ÔÇö ayarlanmam─▒┼şsa token do─şrulama imkans─▒z
    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error("ÔØî GOOGLE_CLIENT_ID tan─▒ml─▒ de─şil ÔÇö Google login kullan─▒lamaz");
      return res.status(500).json({
        success: false,
        message: "Sunucu yap─▒land─▒rma hatas─▒. L├╝tfen y├Âneticiyle ileti┼şime ge├ğin.",
        error: "Sunucu yap─▒land─▒rma hatas─▒. L├╝tfen y├Âneticiyle ileti┼şime ge├ğin.",
      });
    }

    let googleId = null;
    let payloadGender = null;
    let payloadName = null;
    let payloadPhoto = null;

    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();

      // ­şöÆ Token'daki email ile g├Ânderilen email e┼şle┼şmeli
      const tokenEmail = (payload?.email || "").trim().toLowerCase();
      if (tokenEmail && tokenEmail !== normalizedEmail) {
        console.warn(`ÔÜá´©Å Google token email uyu┼şmazl─▒─ş─▒: token=${tokenEmail}, istek=${normalizedEmail}`);
        return res.status(401).json({
          success: false,
          message: "Google hesap bilgileri uyu┼şmuyor",
          error: "Google hesap bilgileri uyu┼şmuyor",
        });
      }

      googleId = payload?.sub || null;
      payloadGender = payload?.gender || null;
      payloadName = payload?.name || null;
      payloadPhoto = payload?.picture || null;
    } catch (verifyErr) {
      // ­şöÆ Token do─şrulama ba┼şar─▒s─▒zsa G─░R─░┼Ş REDDED─░L─░R ÔÇö fallback yok
      console.error("ÔØî Google token do─şrulama ba┼şar─▒s─▒z:", verifyErr.message || verifyErr);
      return res.status(401).json({
        success: false,
        message: "Google token do─şrulanamad─▒. L├╝tfen tekrar deneyin.",
        error: "Google token do─şrulanamad─▒. L├╝tfen tekrar deneyin.",
      });
    }

    const normalizedGender = resolveGender(payloadGender || gender);

    let user = await User.findOne({ email: normalizedEmail });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const username = `${normalizedEmail.split("@")[0]}${Math.floor(Math.random() * 1000)}`;

      user = await User.create({
        username,
        name: name || payloadName || "Google User",
        email: normalizedEmail,
        password: googleId || Math.random().toString(36),
        gender: normalizedGender,
        profileImage: photoUrl || payloadPhoto || "",
        coins: 1000,
        isGuest: false,
        isOnline: false,  // Socket ba─şlant─▒s─▒nda true yap─▒lacak
        lastSeen: new Date(),
        lastOnlineAt: new Date(),
        isBusy: false,
        busyUntil: null,
      });
    } else {
      // Var olan user - online durumunu socket y├Ânetecek, burada de─şi┼ştirmiyoruz
      user.lastSeen = new Date();
      user.lastOnlineAt = new Date();
      user.isBusy = false;
      user.busyUntil = null;

      const resolvedPhoto = photoUrl || payloadPhoto;
      if (resolvedPhoto && !user.profileImage) {
        user.profileImage = resolvedPhoto;
      }

      if (normalizedGender !== "other" && user.gender === "other") {
        user.gender = normalizedGender;
      }

      if (user.isGuest) {
        user.isGuest = false;
      }

      await user.save();
    }

    const token = createToken(user);
    const needsProfileSetup = !user.gender || user.gender === "other";

    // G├╝nl├╝k giri┼ş bonusu
    const dailyBonus = await checkDailyLoginBonus(user);

    res.json({
      success: true,
      token,
      isNewUser,
      needsProfileSetup,
      user: buildUserPayload(user),
      dailyBonus: dailyBonus.granted ? dailyBonus : undefined,
    });
  } catch (err) {
    console.error("Google token login error:", err);
    res.status(500).json({
      success: false,
      message: "Google giri┼şi ba┼şar─▒s─▒z",
      error: "Google giri┼şi ba┼şar─▒s─▒z",
    });
  }
};

exports.appleLogin = async (req, res) => {
  try {
    const { identityToken, authorizationCode, email, familyName, givenName, gender } = req.body;

    if (!identityToken) {
      return res.status(400).json({
        success: false,
        message: "Identity token gerekli",
        error: "Identity token gerekli",
      });
    }

    let appleId = null;
    let appleEmail = email ? String(email).trim().toLowerCase() : null;

    try {
      const appleIdToken = await appleSignin.verifyIdToken(identityToken, {
        audience: process.env.APPLE_CLIENT_ID || "com.eyra.app",
        ignoreExpiration: false,
      });

      appleId = appleIdToken?.sub || null;
      appleEmail = (appleIdToken?.email ? String(appleIdToken.email).trim().toLowerCase() : null) || appleEmail;
    } catch (verifyErr) {
      // 🛡️ Token doğrulama başarısızsa GİRİŞ REDDEDİLİR — fallback yok
      console.error("❌ Apple token doğrulama başarısız:", verifyErr.message || verifyErr);
      return res.status(401).json({
        success: false,
        message: "Apple token doğrulanamadı. Lütfen tekrar deneyin.",
        error: "Apple token doğrulanamadı. Lütfen tekrar deneyin.",
      });
    }

    if (!appleEmail) {
      return res.status(400).json({
        success: false,
        message: "Apple email bilgisi al─▒namad─▒",
        error: "Apple email bilgisi al─▒namad─▒",
      });
    }

    const normalizedGender = resolveGender(gender);

    let user = await User.findOne({ email: appleEmail });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const baseUsername = appleEmail.split("@")[0];
      const username = `${baseUsername}${Math.floor(Math.random() * 1000)}`;
      const displayName = givenName && familyName ? `${givenName} ${familyName}` : givenName || familyName || "Apple User";

      user = await User.create({
        username,
        name: displayName,
        email: appleEmail,
        password: appleId || Math.random().toString(36),
        gender: normalizedGender,
        coins: 1000,
        isGuest: false,
        isOnline: false,  // Socket ba─şlant─▒s─▒nda true yap─▒lacak
        lastSeen: new Date(),
        lastOnlineAt: new Date(),
        isBusy: false,
        busyUntil: null,
      });
    } else {
      // Var olan user - online durumunu socket y├Ânetecek, burada de─şi┼ştirmiyoruz
      user.lastSeen = new Date();
      user.lastOnlineAt = new Date();
      user.isBusy = false;
      user.busyUntil = null;

      if (normalizedGender !== "other" && user.gender === "other") {
        user.gender = normalizedGender;
      }

      if (user.isGuest) {
        user.isGuest = false;
      }

      await user.save();
    }

    const token = createToken(user);
    const needsProfileSetup = !user.gender || user.gender === "other";

    // G├╝nl├╝k giri┼ş bonusu
    const dailyBonus = await checkDailyLoginBonus(user);

    res.json({
      success: true,
      token,
      isNewUser,
      needsProfileSetup,
      user: buildUserPayload(user),
      dailyBonus: dailyBonus.granted ? dailyBonus : undefined,
    });
  } catch (err) {
    console.error("Apple login error:", err);
    res.status(500).json({
      success: false,
      message: "Apple giri┼şi ba┼şar─▒s─▒z",
      error: "Apple giri┼şi ba┼şar─▒s─▒z",
    });
  }
};

exports.logout = async (req, res) => {
  try {
    const userId = req.user.id;

    // Ô£à Veritaban─▒nda offline olarak i┼şaretle
    try {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            isOnline: false,
            isBusy: false,
            isLive: false,
            lastOfflineAt: new Date(),
            lastSeen: new Date(),
          }
        }
      );
    } catch (e) {
      console.warn("ÔÜá´©Å Logout: isOnline update ba┼şar─▒s─▒z:", e.message);
      // Non-fatal: devam et
    }

    // Ô£à CORRECT ORDER: First mark offline in presence, then disconnect socket
    // This prevents race condition where socket disconnect triggers presence offline
    // with different socketId
    
    // 1. Get socket info before disconnecting
    const socketSet = global.userSockets?.get(String(userId));
    const socketIds = socketSet ? Array.from(socketSet) : [];
    
    // 2. Mark user offline in presence service FIRST
    try {
      const meta = { reason: 'logout' };
      // Include socketId for validation
      if (socketIds.length > 0 && socketIds[0]) {
        meta.socketId = socketIds[0];
      }
      await presenceService.setOffline(String(userId), meta);
    } catch (e) {
      console.warn(`ÔÜá´©Å Logout presence update failed: ${e.message}`);
    }
    
    // 3. Disconnect sockets
    if (socketIds.length && global.io?.sockets?.sockets) {
      for (const socketId of socketIds) {
        const socketInstance = global.io.sockets.sockets.get(socketId);
        if (socketInstance) socketInstance.disconnect(true);
      }
    }
    
    // 4. Clean up userSockets map
    if (global.userSockets) {
      global.userSockets.delete(String(userId));
    }

    res.clearCookie("auth_token", getAuthCookieOptions());

    res.json({
      success: true,
      message: "├ç─▒k─▒┼ş yap─▒ld─▒",
    });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({
      success: false,
      message: "├ç─▒k─▒┼ş ba┼şar─▒s─▒z",
      error: "├ç─▒k─▒┼ş ba┼şar─▒s─▒z",
    });
  }
};

exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Kullan─▒c─▒ bulunamad─▒",
        error: "Kullan─▒c─▒ bulunamad─▒",
      });
    }

    res.json({
      success: true,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({
      success: false,
      message: "Sunucu hatas─▒",
      error: "Sunucu hatas─▒",
    });
  }
};

// Ô£à Token Refresh - Generate new token for authenticated user
exports.refreshToken = async (req, res) => {
  try {
    // req.user is already populated by auth middleware
    const user = await User.findById(req.user.id).select("-password");
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Kullan─▒c─▒ bulunamad─▒",
        error: "Kullan─▒c─▒ bulunamad─▒",
      });
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: "Hesab─▒n─▒z ask─▒ya al─▒nm─▒┼ş",
        error: "Hesab─▒n─▒z ask─▒ya al─▒nm─▒┼ş",
      });
    }

    // Generate new token with extended expiration
    const token = createToken(user);

    res.cookie("auth_token", token, getAuthCookieOptions());

    res.json({
      success: true,
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("Refresh token error:", err);
    res.status(500).json({
      success: false,
      message: "Sunucu hatas─▒",
      error: "Sunucu hatas─▒",
    });
  }
};
// PUT /api/auth/change-password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Mevcut şifre ve yeni şifre gerekli" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: "Yeni şifre en az 6 karakter olmalı" });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Mevcut şifre hatalı" });
    }

    user.password = String(newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Yeni token oluştur (eski tokenlar artık geçersiz)
    const token = createToken(user);
    res.cookie("auth_token", token, getAuthCookieOptions());

    res.json({ success: true, message: "Şifre başarıyla değiştirildi", token });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/auth/forgot-password
// Kullanıcının şifresini sıfırlar ve yeni şifre ile günceller
exports.forgotPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail || !newPassword) {
      return res.status(400).json({ success: false, error: "Email ve yeni şifre gerekli" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, error: "Şifre en az 6 karakter olmalı" });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      // Güvenlik: kullanıcı var mı yok mu belli etme
      return res.json({ success: true, message: "Şifre güncellendi" });
    }

    user.password = String(newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    res.json({ success: true, message: "Şifre güncellendi" });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ success: false, error: "Sunucu hatası" });
  }
};
