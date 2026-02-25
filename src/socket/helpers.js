/**
 * Socket helper functions used across multiple handler modules.
 * Call init(io) once before use.
 */

const { userSockets, activeCalls } = require('./state');

let _io = null;

/**
 * Must be called once after Socket.io server is created.
 */
function init(io) {
  _io = io;
}

/**
 * Gender visibility rule:
 *  - male viewers see only female targets
 *  - female/other viewers see everyone
 */
const canSeeTarget = (viewerGender, targetGender) => {
  const viewer = String(viewerGender || '').toLowerCase();
  const target = String(targetGender || '').toLowerCase();
  if (viewer === 'male') return target === 'female';
  return true;
};

/**
 * Emit an event to ALL sockets belonging to a specific user.
 */
const emitToUserSockets = (userId, eventName, payload) => {
  const key = String(userId || '').trim();
  if (!key) return false;

  const targetSockets = userSockets.get(key);
  if (!targetSockets || targetSockets.size === 0) {
    console.log(`⚠️ emitToUserSockets - no sockets for user ${key} (event ${eventName})`);
    return false;
  }

  const enrichedPayload = {
    ...payload,
    event: eventName,
    timestamp: Date.now(),
  };

  targetSockets.forEach((sid) => {
    _io.to(sid).emit(eventName, enrichedPayload);
  });

  return true;
};

/**
 * Parse a call room name: "call_CALLERID_TARGETID_TIMESTAMP"
 */
const parseCallRoomName = (roomName) => {
  if (!roomName) return null;
  const parts = String(roomName).split('_');
  if (parts.length < 4 || parts[0] !== 'call') return null;
  const callerId = parts[1];
  const targetUserId = parts[2];
  if (!callerId || !targetUserId) return null;
  return { callerId, targetUserId };
};

/**
 * Find the counterparty in a call room for the given sender.
 * Checks activeCalls map, global.callRequests (paid calls), and room name parsing.
 */
const getCounterpartyForRoom = (roomName, senderId) => {
  const senderStr = String(senderId || '').trim();
  if (!senderStr) return null;

  // 1) activeCalls map (normal + paid calls)
  const info = activeCalls.get(roomName);
  if (info) {
    if (senderStr === String(info.callerId)) return String(info.targetUserId);
    if (senderStr === String(info.targetUserId)) return String(info.callerId);
  }

  // 2) Paid call requests (global.callRequests set by callRoutes/callController)
  if (global.callRequests) {
    for (const [, req] of global.callRequests) {
      if (req.callRoomName === roomName) {
        const cId = String(req.callerId);
        const hId = String(req.hostId);
        if (senderStr === cId) return hId;
        if (senderStr === hId) return cId;
      }
    }
  }

  // 3) Parse from room name format: call_CALLERID_TARGETID_TIMESTAMP
  const parsed = parseCallRoomName(roomName);
  if (parsed) {
    if (senderStr === String(parsed.callerId)) return String(parsed.targetUserId);
    if (senderStr === String(parsed.targetUserId)) return String(parsed.callerId);
  }

  return null;
};

module.exports = {
  init,
  canSeeTarget,
  emitToUserSockets,
  parseCallRoomName,
  getCounterpartyForRoom,
};
