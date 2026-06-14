// src/utils/livekitToken.js
// Ortak LiveKit access token üreticisi (PK ortak odası ve diğer paylaşımlı
// odalar için). liveController kendi token üreticilerini korur; bu yardımcı
// yeni özellikler (PK eşleşmesi) tarafından kullanılır.

const { AccessToken } = require("livekit-server-sdk");
const { logger } = require("./logger");

/**
 * Belirli bir oda için LiveKit JWT üretir.
 * @param {Object} opts
 * @param {string} opts.userId      - Token sahibinin kimliği (identity)
 * @param {string} opts.roomId      - Katılınacak LiveKit oda adı
 * @param {boolean} [opts.canPublish=false] - Yayın (kamera/mic) izni
 * @returns {Promise<string>} JWT string
 */
async function createLiveKitToken({ userId, roomId, canPublish = false }) {
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    throw new Error("LIVEKIT credentials missing");
  }
  if (!roomId || String(roomId).trim().length === 0) {
    throw new Error("LIVEKIT roomId missing/empty");
  }

  const identity =
    userId && userId.toString ? userId.toString() : String(userId);

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity },
  );

  at.addGrant({
    roomJoin: true,
    room: String(roomId),
    canPublish: !!canPublish,
    canSubscribe: true,
    canPublishData: true,
  });

  let token = await at.toJwt();
  if (typeof token !== "string") {
    token = token == null ? "" : token.toString();
  }

  if (!token || token === "undefined" || token === "[object Object]") {
    logger.error("❌ createLiveKitToken produced invalid token");
    throw new Error("token_generation_failed");
  }

  return token;
}

function livekitUrl() {
  return process.env.LIVEKIT_URL || "";
}

module.exports = { createLiveKitToken, livekitUrl };
