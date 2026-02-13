const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const appleSignin = require("apple-signin-auth");
const { normalizeGender } = require("../utils/gender");
const { JWT_SECRET, NODE_ENV } = require("../config/env");
const presenceService = require("../services/presenceService");
const SystemSettings = require("../models/SystemSettings");
const Transaction = require("../models/Transaction");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const resolveGender = (gender) => {
  const normalized = normalizeGender(gender);
  // Eğer gender belirtilmemişse (null/undefined/boş), varsayılan olarak female ata
  // Ama kullanıcı açıkça "other" seçtiyse, bunu kabul et
  if (!normalized || normalized === "other") {
    // Eğer input "other" olarak açıkça belirtilmişse, kabul et
    const rawGender = String(gender || "").trim().toLowerCase();
    if (rawGender === "other" || rawGender === "diğer" || rawGender === "diger") {
      return "other"; // Kullanıcının tercihi
    }
    // Aksi halde varsayılan
    return "female";
  }
  return normalized;
};

const createToken = (user, expiresIn = "90d") =>
  jwt.sign(
    { id: user._id, email: user.email, username: user.username },
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
  profileImage: user.profileImage,
  coins: user.coins,
  level: user.level,
  isGuest: user.isGuest,
  isOnline: user.isOnline,
  lastSeen: user.lastSeen,
  lastOnlineAt: user.lastOnlineAt,
  role: user.role,
  permissions: user.permissions || [],
});

// Günlük giriş bonusu kontrolü ve verme
const checkDailyLoginBonus = async (user) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Bugün zaten bonus aldıysa atla
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

    // Streak bonusu: her 7 günde ekstra %50
    const streakMultiplier = Math.floor(newStreak / 7) > 0 ? 1.5 : 1;
    const totalBonus = Math.floor(bonusAmount * streakMultiplier);

    user.coins = (user.coins || 0) + totalBonus;
    user.dailyLoginAt = now;
    user.loginStreak = newStreak;
    await user.save();

    // Transaction kaydı
    try {
      await Transaction.create({
        user: user._id,
        type: "daily_bonus",
        amount: totalBonus,
        balanceAfter: user.coins,
        description: `Günlük giriş bonusu (${newStreak}. gün seri)`,
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
        error: "Email ve şifre gerekli",
      });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Email veya şifre hatalı",
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: "Email veya şifre hatalı",
      });
    }

    // ✅ Upgrade legacy plaintext passwords to bcrypt on successful login
    // This keeps existing users working while making the system secure going forward.
    if (typeof user.isPasswordHashed === "function" && !user.isPasswordHashed()) {
      try {
        user.password = String(password);
        await user.save();
      } catch (e) {
        // Non-fatal: don't block login if migration fails
        console.warn("⚠️ Password upgrade failed:", e.message);
      }
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        error: "Hesabınız askıya alınmış",
      });
    }

    // NOT: isOnline durumu socket bağlantısında güncellenecek
    // Login sadece lastSeen'i günceller
    try {
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            lastSeen: new Date(),
          }
        }
      );
    } catch (e) {
      console.warn("⚠️ Login: lastSeen update başarısız:", e.message);
      // Non-fatal: devam et
    }

    const token = createToken(user);

    res.cookie("auth_token", token, getAuthCookieOptions());

    // Günlük giriş bonusu
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
      error: "Sunucu hatası",
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
        error: "Gerekli alanları doldurun",
      });
    }

    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) {
      return res.status(400).json({
        success: false,
        error: "Bu email zaten kayıtlı",
      });
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({
        success: false,
        error: "Bu kullanıcı adı alınmış",
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
      location: location || "Türkiye",
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
      error: "Kayıt başarısız",
    });
  }
};

exports.guestLogin = async (req, res) => {
  try {
    const { name, gender, age, country, location } = req.body;

    if (!gender) {
      return res.status(400).json({
        success: false,
        error: "Cinsiyet seçmek zorunlu",
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
      location: location || country || "Türkiye",
      country: country || "TR",
      coins: 0,
      isGuest: true,
      isOnline: false,  // Socket bağlantısında true yapılacak
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
      error: "Misafir girişi başarısız",
    });
  }
};

exports.googleLogin = async (req, res) => {
  try {
    const { email, name, googleId, photoUrl, gender } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        error: "Email gerekli",
      });
    }

    const normalizedGender = resolveGender(gender);

    let user = await User.findOne({ email: normalizedEmail });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const username = `${normalizedEmail.split("@")[0]}${Math.floor(Math.random() * 1000)}`;

      user = await User.create({
        username,
        name: name || "Google User",
        email: normalizedEmail,
        password: googleId || Math.random().toString(36),
        gender: normalizedGender,
        profileImage: photoUrl || "",
        coins: 1000,
        isGuest: false,
        isOnline: false,  // Socket bağlantısında true yapılacak
        lastSeen: new Date(),
        lastOnlineAt: new Date(),
        isBusy: false,
        busyUntil: null,
      });
    } else {
      // Var olan user - online durumunu socket yönetecek, burada değiştirmiyoruz
      user.lastSeen = new Date();
      user.lastOnlineAt = new Date();
      user.isBusy = false;
      user.busyUntil = null;
      if (photoUrl && !user.profileImage) {
        user.profileImage = photoUrl;
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

    // Günlük giriş bonusu
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
    console.error("Google login error:", err);
    res.status(500).json({
      success: false,
      error: "Google girişi başarısız",
    });
  }
};

exports.googleLoginWithToken = async (req, res) => {
  try {
    const { idToken, email, name, photoUrl, gender } = req.body;

    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!idToken || !normalizedEmail) {
      return res.status(400).json({
        success: false,
        error: "ID token ve email gerekli",
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
      googleId = payload?.sub || null;
      payloadGender = payload?.gender || null;
      payloadName = payload?.name || null;
      payloadPhoto = payload?.picture || null;
    } catch (verifyErr) {
      console.error("Google token doğrulama hatası:", verifyErr);
      googleId = (normalizedEmail.split("@")[0] || "google") + Date.now();
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
        isOnline: false,  // Socket bağlantısında true yapılacak
        lastSeen: new Date(),
        lastOnlineAt: new Date(),
        isBusy: false,
        busyUntil: null,
      });
    } else {
      // Var olan user - online durumunu socket yönetecek, burada değiştirmiyoruz
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

    // Günlük giriş bonusu
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
      error: "Google girişi başarısız",
    });
  }
};

exports.appleLogin = async (req, res) => {
  try {
    const { identityToken, authorizationCode, email, familyName, givenName, gender } = req.body;

    if (!identityToken) {
      return res.status(400).json({
        success: false,
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
      console.error("Apple token doğrulama hatası:", verifyErr);
      appleId = authorizationCode || Math.random().toString(36);
      appleEmail = appleEmail || `${appleId}@privaterelay.appleid.com`;
    }

    if (!appleEmail) {
      return res.status(400).json({
        success: false,
        error: "Apple email bilgisi alınamadı",
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
        isOnline: false,  // Socket bağlantısında true yapılacak
        lastSeen: new Date(),
        lastOnlineAt: new Date(),
        isBusy: false,
        busyUntil: null,
      });
    } else {
      // Var olan user - online durumunu socket yönetecek, burada değiştirmiyoruz
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

    res.json({
      success: true,
      token,
      isNewUser,
      needsProfileSetup,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("Apple login error:", err);
    res.status(500).json({
      success: false,
      error: "Apple girişi başarısız",
    });
  }
};

exports.logout = async (req, res) => {
  try {
    const userId = req.user.id;

    // ✅ Veritabanında offline olarak işaretle
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
      console.warn("⚠️ Logout: isOnline update başarısız:", e.message);
      // Non-fatal: devam et
    }

    // ✅ CORRECT ORDER: First mark offline in presence, then disconnect socket
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
      console.warn(`⚠️ Logout presence update failed: ${e.message}`);
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
      message: "Çıkış yapıldı",
    });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({
      success: false,
      error: "Çıkış başarısız",
    });
  }
};

exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "Kullanıcı bulunamadı",
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
      error: "Sunucu hatası",
    });
  }
};

// ✅ Token Refresh - Generate new token for authenticated user
exports.refreshToken = async (req, res) => {
  try {
    // req.user is already populated by auth middleware
    const user = await User.findById(req.user.id).select("-password");
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "Kullanıcı bulunamadı",
      });
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        error: "Hesabınız askıya alınmış",
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
      error: "Sunucu hatası",
    });
  }
};

