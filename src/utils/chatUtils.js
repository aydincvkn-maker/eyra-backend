// src/utils/chatUtils.js

const normalizeId = (value) => String(value || "").trim();

/**
 * Deterministic private chat room id for two users.
 * Must be stable across devices and independent of sender/receiver.
 */
const getChatRoomId = (userIdA, userIdB) => {
  const a = normalizeId(userIdA);
  const b = normalizeId(userIdB);

  if (!a || !b) {
    throw new Error("INVALID_USER_ID");
  }

  return [a, b].sort().join("_");
};

module.exports = {
  getChatRoomId,
};
