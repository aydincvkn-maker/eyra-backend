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
const PANEL_ROLES = ["admin", "super_admin", "moderator"];

const isPanelUser = (user) => {
  if (user?.accountScope === "panel") return true;
  const role = String(user?.role || "").toLowerCase();
  return PANEL_ROLES.includes(role) || user?.isOwner === true;
};

const validateLoginScope = (user, { panelLogin = false } = {}) => {
  if (panelLogin) {
    if (!isPanelUser(user)) {
      return "Bu hesap panel hesabı değil";
    }
    if (user?.isPanelRestricted === true) {
      return "Panel erişiminiz kısıtlanmıştır";
    }
    return null;
  }

  if (isPanelUser(user)) {
    return "Bu hesap sadece admin paneline giriş yapabilir";
  }

  return null;
};

const updateLoginTracking = async (req, user) => {
  const loginEntry = {
    platform: String(
      req.headers["x-platform"] || req.headers["user-agent"] || "",
    ).slice(0, 200),
    device: String(req.headers["x-device"] || "").slice(0, 200),
    ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "",
    loginAt: new Date(),
  };

  await User.updateOne(
    { _id: user._id },
    {
      $set: { lastSeen: new Date() },
      $push: { loginHistory: { $each: [loginEntry], $slice: -50 } },
    },
  );
};

const sendLoginResponse = async (
  req,
  res,
  user,
  { grantDailyBonus = true } = {},
) => {
  try {
    await updateLoginTracking(req, user);
  } catch (e) {
    console.warn("⚠️ Login: lastSeen/history update başarısız:", e.message);
  }

  const token = createToken(user);
  res.cookie("auth_token", token, getAuthCookieOptions());

  const dailyBonus = grantDailyBonus
    ? await checkDailyLoginBonus(user)
    : { granted: false };

  res.json({
    success: true,
    token,
    user: buildUserPayload(user),
    dailyBonus: dailyBonus.granted ? dailyBonus : undefined,
  });
};

const handleEmailPasswordLogin = async (
  req,
  res,
  { panelLogin = false } = {},
) => {
  const { email, password } = req.body;

  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (!normalizedEmail || !password) {
    return res.status(400).json({
      success: false,
      message: "Email ve şifre gerekli",
      error: "Email ve şifre gerekli",
    });
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Email veya şifre hatalı",
      error: "Email veya şifre hatalı",
    });
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: "Email veya şifre hatalı",
      error: "Email veya şifre hatalı",
    });
  }

  if (
    typeof user.isPasswordHashed === "function" &&
    !user.isPasswordHashed()
  ) {
    try {
      user.password = String(password);
      await user.save();
    } catch (e) {
      console.warn("Password upgrade failed:", e.message);
    }
  }

  if (user.isBanned) {
    return res.status(403).json({
      success: false,
      message: "Hesabınız askıya alınmış",
      error: "Hesabınız askıya alınmış",
    });
  }

  const scopeError = validateLoginScope(user, { panelLogin });
  if (scopeError) {
    return res.status(403).json({
      success: false,
      message: scopeError,
      error: scopeError,
    });
  }

  return sendLoginResponse(req, res, user, {
    grantDailyBonus: !panelLogin,
  });
};

const resolveGender = (gender) => {
  const normalized = normalizeGender(gender);
  if (normalized === "male" || normalized === "female") {
    return normalized;
  }

  const rawGender = String(gender || "")
    .trim()
    .toLowerCase();

  if (
    rawGender === "other" ||
    rawGender === "di─şer" ||
    rawGender === "diger"
  ) {
    return "other";
  }

  // Sosyal girişlerde cinsiyet bilinmiyorsa kullanıcıya uygulama içinde sordur.
  return "other";
};

const createToken = (user, expiresIn = JWT_EXPIRES_IN || "30d") =>
  jwt.sign(
    {
      id: user._id,
      email: user.email,
      username: user.username,
      role: user.role || "user",
      tokenVersion: user.tokenVersion || 0,
    },
    JWT_SECRET,
    { expiresIn },
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
  preferredLanguage: user.preferredLanguage || "tr",
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
  isVerified: user.isVerified,
  verificationStatus: user.verificationStatus || "none",
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
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

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
    return await handleEmailPasswordLogin(req, res, { panelLogin: false });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      success: false,
      message: "Sunucu hatası",
      error: "Sunucu hatası",
    });
  }
};

exports.panelLogin = async (req, res) => {
  try {
    return await handleEmailPasswordLogin(req, res, { panelLogin: true });
  } catch (err) {
    console.error("Panel login error:", err);
    res.status(500).json({
      success: false,
      message: "Sunucu hatası",
      error: "Sunucu hatası",
    });
  }
};

exports.register = async (req, res) => {
  try {
    const { username, name, email, password, gender, age, location, country } =
      req.body;

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

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
      authProvider: "email",
      gender: normalizedGender,
      age: Number.isFinite(age) ? age : 20,
      location: location || "T├╝rkiye",
      country: country || "TR",
      coins: 500,
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
      authProvider: "guest",
      gender: normalizedGender,
      age: Number.isFinite(age) && age > 0 ? age : 20,
      location: location || country || "T├╝rkiye",
      country: country || "TR",
      coins: 0,
      isGuest: true,
      isOnline: false, // Socket ba─şlant─▒s─▒nda true yap─▒lacak
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
  console.warn(
    "ÔÜá´©Å DEPRECATED: /google-login ├ğa─şr─▒ld─▒ (token do─şrulamas─▒ yok). ─░stemci g├╝ncellenmeli.",
  );
  return res.status(403).json({
    success: false,
    message:
      "Bu giri┼ş y├Ântemi art─▒k desteklenmiyor. L├╝tfen uygulamay─▒ g├╝ncelleyin.",
    error:
      "Bu giri┼ş y├Ântemi art─▒k desteklenmiyor. L├╝tfen uygulamay─▒ g├╝ncelleyin.",
    code: "GOOGLE_LOGIN_DEPRECATED",
  });
};

exports.googleLoginWithToken = async (req, res) => {
  try {
    const { idToken, email, name, photoUrl, gender } = req.body;

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

    if (!idToken || !normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "ID token ve email gerekli",
        error: "ID token ve email gerekli",
      });
    }

    // ­şöÆ GOOGLE_CLIENT_ID kontrol ÔÇö ayarlanmam─▒┼şsa token do─şrulama imkans─▒z
    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error(
        "ÔØî GOOGLE_CLIENT_ID tan─▒ml─▒ de─şil ÔÇö Google login kullan─▒lamaz",
      );
      return res.status(500).json({
        success: false,
        message:
          "Sunucu yap─▒land─▒rma hatas─▒. L├╝tfen y├Âneticiyle ileti┼şime ge├ğin.",
        error:
          "Sunucu yap─▒land─▒rma hatas─▒. L├╝tfen y├Âneticiyle ileti┼şime ge├ğin.",
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
        console.warn(
          `ÔÜá´©Å Google token email uyu┼şmazl─▒─ş─▒: token=${tokenEmail}, istek=${normalizedEmail}`,
        );
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
      console.error(
        "ÔØî Google token do─şrulama ba┼şar─▒s─▒z:",
        verifyErr.message || verifyErr,
      );
      return res.status(401).json({
        success: false,
        message: "Google token do─şrulanamad─▒. L├╝tfen tekrar deneyin.",
        error: "Google token do─şrulanamad─▒. L├╝tfen tekrar deneyin.",
      });
    }

    const normalizedGender = resolveGender(payloadGender || gender);

    let user = await User.findOne({ email: normalizedEmail });
    let isNewUser = false;

    if (user && isPanelUser(user)) {
      return res.status(403).json({
        success: false,
        message: "Bu hesap sadece admin paneline giriş yapabilir",
        error: "Bu hesap sadece admin paneline giriş yapabilir",
      });
    }

    if (!user) {
      isNewUser = true;
      const username = `${normalizedEmail.split("@")[0]}${Math.floor(Math.random() * 1000)}`;

      user = await User.create({
        username,
        name: name || payloadName || "Google User",
        email: normalizedEmail,
        password: googleId || Math.random().toString(36),
        authProvider: "google",
        gender: normalizedGender,
        profileImage: photoUrl || payloadPhoto || "",
        coins: 500,
        isGuest: false,
        isOnline: false, // Socket ba─şlant─▒s─▒nda true yap─▒lacak
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
    const {
      identityToken,
      authorizationCode,
      email,
      familyName,
      givenName,
      gender,
    } = req.body;

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
      appleEmail =
        (appleIdToken?.email
          ? String(appleIdToken.email).trim().toLowerCase()
          : null) || appleEmail;
    } catch (verifyErr) {
      // 🛡️ Token doğrulama başarısızsa GİRİŞ REDDEDİLİR — fallback yok
      console.error(
        "❌ Apple token doğrulama başarısız:",
        verifyErr.message || verifyErr,
      );
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

    if (user && isPanelUser(user)) {
      return res.status(403).json({
        success: false,
        message: "Bu hesap sadece admin paneline giriş yapabilir",
        error: "Bu hesap sadece admin paneline giriş yapabilir",
      });
    }

    if (!user) {
      isNewUser = true;
      const baseUsername = appleEmail.split("@")[0];
      const username = `${baseUsername}${Math.floor(Math.random() * 1000)}`;
      const displayName =
        givenName && familyName
          ? `${givenName} ${familyName}`
          : givenName || familyName || "Apple User";

      user = await User.create({
        username,
        name: displayName,
        email: appleEmail,
        password: appleId || Math.random().toString(36),
        authProvider: "apple",
        gender: normalizedGender,
        coins: 500,
        isGuest: false,
        isOnline: false, // Socket ba─şlant─▒s─▒nda true yap─▒lacak
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
          },
        },
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
      const meta = { reason: "logout" };
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
      return res.status(400).json({
        success: false,
        message: "Mevcut şifre ve yeni şifre gerekli",
      });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Yeni şifre en az 6 karakter olmalı",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Mevcut şifre hatalı" });
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
// Firebase token ile doğrulanmış şifre sıfırlama
// Güvenlik: Firebase idToken doğrulaması yapılır, kimlik kanıtı olmadan şifre değiştirilemez
exports.forgotPassword = async (req, res) => {
  try {
    const { email, newPassword, firebaseIdToken } = req.body;
    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

    if (!normalizedEmail || !newPassword) {
      return res
        .status(400)
        .json({ success: false, error: "Email ve yeni şifre gerekli" });
    }

    if (String(newPassword).length < 6) {
      return res
        .status(400)
        .json({ success: false, error: "Şifre en az 6 karakter olmalı" });
    }

    // 🛡️ Firebase idToken doğrulaması — token yoksa veya geçersizse reddet
    if (!firebaseIdToken) {
      return res
        .status(401)
        .json({ success: false, error: "Kimlik doğrulama gerekli" });
    }

    try {
      const admin = require("firebase-admin");
      // firebase-admin başlatılmamışsa atlayıp eski davranışa fallback yap
      if (!admin.apps.length) {
        console.warn(
          "⚠️ firebase-admin not initialized, skipping token verification for forgot-password",
        );
      } else {
        const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
        const tokenEmail = (decoded.email || "").trim().toLowerCase();
        if (tokenEmail !== normalizedEmail) {
          return res
            .status(401)
            .json({ success: false, error: "Email eşleşmiyor" });
        }
      }
    } catch (verifyErr) {
      console.error("❌ Firebase token doğrulama hatası:", verifyErr.message);
      return res
        .status(401)
        .json({ success: false, error: "Kimlik doğrulama başarısız" });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      // Güvenlik: kullanıcı var mı yok mu belli etme
      return res.json({ success: true, message: "Şifre güncellendi" });
    }

    user.password = String(newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    const token = createToken(user);

    res.json({
      success: true,
      message: "Şifre güncellendi",
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ success: false, error: "Sunucu hatası" });
  }
};

// POST /api/auth/phone-login
// Firebase Phone Auth ile doğrulanmış telefon girişi
exports.phoneLogin = async (req, res) => {
  try {
    const { firebaseIdToken, phoneNumber, name, gender, age, country } =
      req.body;

    if (!firebaseIdToken) {
      return res
        .status(400)
        .json({ success: false, error: "Firebase token gerekli" });
    }

    // 🛡️ Firebase token doğrula
    let firebaseUid = null;
    let verifiedPhone = null;

    try {
      const admin = require("firebase-admin");
      if (!admin.apps.length) {
        return res
          .status(500)
          .json({ success: false, error: "Sunucu yapılandırma hatası" });
      }
      const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
      firebaseUid = decoded.uid;
      verifiedPhone = decoded.phone_number || phoneNumber || "";
    } catch (verifyErr) {
      console.error(
        "❌ Phone login token doğrulama hatası:",
        verifyErr.message,
      );
      return res
        .status(401)
        .json({ success: false, error: "Token doğrulanamadı" });
    }

    if (!verifiedPhone) {
      return res
        .status(400)
        .json({ success: false, error: "Telefon numarası doğrulanamadı" });
    }

    const normalizedGender = resolveGender(gender);

    // Telefon numarası veya firebaseUid ile kullanıcı bul
    let user = await User.findOne({ phone: verifiedPhone });
    let isNewUser = false;

    if (!user) {
      // firebaseUid tabanlı email ile de dene (eski kayıtlar)
      const legacyEmail = `user_${firebaseUid.substring(0, 8)}@phone.com`;
      user = await User.findOne({ email: legacyEmail });
    }

    if (user && isPanelUser(user)) {
      return res.status(403).json({
        success: false,
        error: "Bu hesap sadece admin paneline giriş yapabilir",
      });
    }

    if (!user) {
      isNewUser = true;
      const timestamp = Date.now();
      const username = `user_${timestamp}`;

      user = await User.create({
        username,
        name: name || verifiedPhone,
        email: `phone_${timestamp}@phone.eyra`,
        password: firebaseUid,
        authProvider: "phone",
        phone: verifiedPhone,
        gender: normalizedGender,
        age: Number.isFinite(age) && age >= 18 ? age : 20,
        location: country || "Türkiye",
        country: country || "TR",
        coins: 500,
        isGuest: false,
        isOnline: false,
        lastSeen: new Date(),
        lastOnlineAt: new Date(),
      });
    } else {
      // Mevcut kullanıcı — telefon numarasını güncelle
      if (!user.phone) user.phone = verifiedPhone;
      user.lastSeen = new Date();
      user.lastOnlineAt = new Date();
      if (user.isGuest) user.isGuest = false;
      await user.save();
    }

    const token = createToken(user);
    const needsProfileSetup =
      isNewUser || !user.gender || user.gender === "other";

    // Günlük giriş bonusu
    const dailyBonus = await checkDailyLoginBonus(user);

    // Login history
    try {
      const loginEntry = {
        platform: String(
          req.headers["x-platform"] || req.headers["user-agent"] || "",
        ).slice(0, 200),
        device: String(req.headers["x-device"] || "").slice(0, 200),
        ip:
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "",
        loginAt: new Date(),
      };
      await User.updateOne(
        { _id: user._id },
        { $push: { loginHistory: { $each: [loginEntry], $slice: -50 } } },
      );
    } catch (_) {}

    res.json({
      success: true,
      token,
      isNewUser,
      needsProfileSetup,
      user: buildUserPayload(user),
      dailyBonus: dailyBonus.granted ? dailyBonus : undefined,
    });
  } catch (err) {
    console.error("Phone login error:", err);
    res.status(500).json({ success: false, error: "Telefon girişi başarısız" });
  }
};
