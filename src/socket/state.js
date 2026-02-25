/**
 * Shared in-memory state for socket management.
 * All Maps are singletons — imported by reference across modules.
 */

// userId -> Set<socketId>
const userSockets = new Map();

// roomName -> { callerId, targetUserId, createdAt }
const activeCalls = new Map();

// userId -> Array<{ callerId, callerName, roomName, createdAt }>
const pendingCalls = new Map();

// socketId -> gender (for efficient presence broadcast filtering)
const socketGenderCache = new Map();

// userId -> lastConnectTime (rate-limiting reconnect loops)
const userConnectionTimestamps = new Map();

// userId -> { update, timeoutId } (debounced DB presence writes)
const pendingDbUpdates = new Map();

module.exports = {
  userSockets,
  activeCalls,
  pendingCalls,
  socketGenderCache,
  userConnectionTimestamps,
  pendingDbUpdates,
};
