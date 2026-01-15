// src/services/presenceService.js
// 🔥 SOCKET-DRIVEN PRESENCE (IN-MEMORY)
// Source of truth = active Socket.io connection + heartbeat
// Presence is EPHEMERAL: it is NOT written to DB.

const { EventEmitter } = require('events');
const { logger } = require('../utils/logger');

const ALLOWED_STATUS = new Set(['online', 'offline', 'live', 'in_call']);

const normalizeStatus = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'incall' || s === 'in-call' || s === 'in call') return 'in_call';
  if (s === 'busy') return 'in_call';
  if (s === 'call') return 'in_call';
  if (ALLOWED_STATUS.has(s)) return s;
  return null;
};

const statusToFlags = (status) => {
  const normalized = normalizeStatus(status) || 'offline';
  const online = normalized !== 'offline';
  const live = normalized === 'live';
  const inCall = normalized === 'in_call';
  const busy = inCall;
  return { status: normalized, online, live, inCall, busy };
};

class PresenceService extends EventEmitter {
  constructor() {
    super();
    this._onlineUsers = new Map(); // userId -> { userId, socketId, gender, status, lastPing }
    this._heartbeatTimeoutMs = 15_000; // ✅ 15 saniye (client 5 saniyede bir heartbeat gönderir)
    this._sweepIntervalMs = 3_000; // ✅ 3 saniye - daha hızlı stale temizliği
    this._sweepTimer = null;
    
    // ✅ PROFESSIONAL: Metrics for monitoring
    this._metrics = {
      totalConnections: 0,
      totalDisconnections: 0,
      totalSweeps: 0,
      totalSweptUsers: 0,
      lastSweepAt: null,
      startedAt: Date.now(),
      lastOnlineCount: 0,
      peakOnlineCount: 0,
    };
    
    // ✅ PROFESSIONAL: Offline users lastSeen cache (prevents null)
    this._lastSeenCache = new Map(); // userId -> timestamp
  }
  
  // ✅ Get metrics for monitoring/debugging
  getMetrics() {
    return {
      ...this._metrics,
      currentOnlineCount: this._onlineUsers.size,
      uptimeMs: Date.now() - this._metrics.startedAt,
    };
  }

  initialize(options = {}) {
    const heartbeatTimeoutMs = Number(options.heartbeatTimeoutMs ?? 15_000);
    const sweepIntervalMs = Number(options.sweepIntervalMs ?? 3_000);

    this._heartbeatTimeoutMs = Number.isFinite(heartbeatTimeoutMs) ? heartbeatTimeoutMs : 15_000;
    this._sweepIntervalMs = Number.isFinite(sweepIntervalMs) ? sweepIntervalMs : 3_000;

    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }

    this._sweepTimer = setInterval(() => {
      try {
        this._sweepStale();
      } catch (e) {
        logger.error('❌ Presence sweep error:', e);
      }
    }, this._sweepIntervalMs);

    // Don't keep the process alive just for the sweeper
    if (typeof this._sweepTimer.unref === 'function') {
      this._sweepTimer.unref();
    }

    logger.info(`✅ PresenceService initialized (memory) timeout=${this._heartbeatTimeoutMs}ms interval=${this._sweepIntervalMs}ms`);
  }

  shutdown() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    this._onlineUsers.clear();
    this._lastSeenCache.clear();
  }

  _emitChanged(userId, presence, meta = {}) {
    this.emit('changed', {
      userId: String(userId),
      presence: { ...presence },
      meta: { ...meta },
      timestamp: Date.now(),
    });
  }

  _snapshotOnline(userId) {
    const key = String(userId || '').trim();
    if (!key) return null;

    const entry = this._onlineUsers.get(key);
    if (!entry) {
      const flags = statusToFlags('offline');
      // ✅ FIX: Use cached lastSeen instead of null
      const cachedLastSeen = this._lastSeenCache.get(key) || Date.now();
      return {
        userId: key,
        socketId: null,
        gender: null,
        lastSeen: cachedLastSeen,
        lastPing: null,
        ...flags,
      };
    }

    const flags = statusToFlags(entry.status);
    return {
      userId: key,
      socketId: entry.socketId,
      gender: entry.gender ?? null,
      lastSeen: entry.lastPing,
      lastPing: entry.lastPing,
      ...flags,
    };
  }

  _sweepStale() {
    const now = Date.now();
    let sweptCount = 0;
    const sweptUsers = [];
    
    for (const [userId, entry] of this._onlineUsers.entries()) {
      if (!entry?.lastPing) continue;

      const staleDuration = now - entry.lastPing;
      if (staleDuration > this._heartbeatTimeoutMs) {
        const snapshot = this._snapshotOnline(userId);
        
        // ✅ FIX: Cache lastSeen before deleting
        this._lastSeenCache.set(userId, now);
        
        this._onlineUsers.delete(userId);
        const offline = {
          ...snapshot,
          ...statusToFlags('offline'),
          socketId: null,
          lastSeen: now,
        };
        this._emitChanged(userId, offline, { reason: 'heartbeat_timeout' });
        sweptCount++;
        sweptUsers.push({ userId, staleDurationMs: staleDuration });
      }
    }
    
    // ✅ Update metrics
    this._metrics.totalSweeps++;
    this._metrics.totalSweptUsers += sweptCount;
    this._metrics.lastSweepAt = now;
    this._metrics.lastOnlineCount = this._onlineUsers.size;
    if (this._onlineUsers.size > this._metrics.peakOnlineCount) {
      this._metrics.peakOnlineCount = this._onlineUsers.size;
    }
    
    // ✅ Cleanup old lastSeen cache entries (older than 24 hours)
    const cacheMaxAge = 24 * 60 * 60 * 1000;
    for (const [uid, ts] of this._lastSeenCache.entries()) {
      if (now - ts > cacheMaxAge) {
        this._lastSeenCache.delete(uid);
      }
    }
    
    // ✅ Log only when users are swept (reduces log spam)
    if (sweptCount > 0) {
      logger.info(`🧹 Presence sweep: ${sweptCount} users marked offline`, {
        users: sweptUsers.map(u => u.userId),
        totalOnline: this._onlineUsers.size,
      });
    }
  }

  /**
   * Set user online
   * @param {string} userId
   * @param {{ socketId?: string, gender?: string }} [meta]
   */
  async setOnline(userId, meta = {}) {
    const key = String(userId || '').trim();
    if (!key) throw new Error('userId is required');

    const now = Date.now();
    const current = this._onlineUsers.get(key);
    
    // ✅ CACHE UPDATE: Store lastSeen for future offline lookups
    this._lastSeenCache.set(key, now);
    
    // ✅ Race condition fix: Eğer mevcut bir socket varsa ve yeni socketId farklıysa,
    // yeni bağlantı eski bağlantıyı override eder (bu normal - yeni tab/cihaz)
    // Ama socketId yoksa (HTTP çağrısı), mevcut socket'i bozmayız
    if (!meta.socketId && current?.socketId) {
      // HTTP'den gelen setOnline çağrısı, mevcut socket var - sadece lastPing güncelle
      current.lastPing = now;
      if (meta.gender) current.gender = meta.gender;
      this._onlineUsers.set(key, current);
      return this._snapshotOnline(key);
    }
    
    const socketId = String(meta.socketId || current?.socketId || '').trim() || null;
    const gender = meta.gender ?? current?.gender ?? null;

    const entry = {
      userId: key,
      socketId,
      gender,
      status: 'online',
      lastPing: now,
    };

    // ✅ Track metrics - new connection
    if (!this._onlineUsers.has(key)) {
      this._metrics.totalConnections++;
    }
    
    this._onlineUsers.set(key, entry);

    const snapshot = this._snapshotOnline(key);
    this._emitChanged(key, snapshot, { reason: 'connected' });
    return snapshot;
  }

  /**
   * Set user offline
   * @param {string} userId
   * @param {{ socketId?: string, reason?: string }} [meta]
   */
  async setOffline(userId, meta = {}) {
    const key = String(userId || '').trim();
    if (!key) throw new Error('userId is required');

    const entry = this._onlineUsers.get(key);
    
    // ✅ RACE CONDITION FIX: Validate socketId properly
    // If entry exists and has a socketId, we MUST verify the disconnect request
    // is from the same socket. This prevents stale disconnects from killing
    // active connections (e.g., user reconnected with new socket).
    if (entry && entry.socketId) {
      // If meta.socketId is provided, it must match
      if (meta.socketId && String(meta.socketId) !== String(entry.socketId)) {
        logger.info(`🔒 Ignoring stale disconnect for ${key}: socket mismatch (active: ${entry.socketId}, request: ${meta.socketId})`);
        return this._snapshotOnline(key);
      }
      // If meta.socketId is NOT provided (e.g., HTTP logout without socket context),
      // we allow the offline transition BUT warn if there's an active socket.
      // ✅ IMPROVEMENT: This is acceptable for logout, but we log for debugging.
      if (!meta.socketId) {
        logger.warn(`⚠️ setOffline for ${key} without socketId (reason: ${meta.reason || 'unknown'}) - has active socket ${entry.socketId} but proceeding`);
      }
    }

    const now = Date.now();
    const snapshot = this._snapshotOnline(key);
    
    // ✅ Track metrics - disconnection
    if (this._onlineUsers.has(key)) {
      this._metrics.totalDisconnections++;
    }
    
    // ✅ FIX: Cache lastSeen before deleting
    this._lastSeenCache.set(key, now);
    
    this._onlineUsers.delete(key);

    const offline = {
      ...snapshot,
      ...statusToFlags('offline'),
      socketId: null,
      lastSeen: now,
    };

    this._emitChanged(key, offline, { reason: meta.reason || 'disconnected' });
    return offline;
  }

  /**
   * Heartbeat - update lastPing
   */
  async heartbeat(userId, meta = {}) {
    const key = String(userId || '').trim();
    if (!key) return;
    const entry = this._onlineUsers.get(key);
    if (!entry) {
      // If we receive a heartbeat tied to a connected socket but we don't have
      // an in-memory record (e.g., sweep happened while socket stayed open),
      // restore online presence.
      if (meta.socketId) {
        logger.info(`🔄 Heartbeat restore: ${key} (socket: ${meta.socketId})`);
        await this.setOnline(key, meta);
      }
      return;
    }
    // Validate socketId if provided (ignore heartbeats from old sockets)
    if (meta.socketId && String(meta.socketId) !== String(entry.socketId)) {
      logger.info(`⚠️ Heartbeat ignored for ${key}: socket mismatch (expected: ${entry.socketId}, got: ${meta.socketId})`);
      return;
    }

    entry.lastPing = Date.now();
    this._onlineUsers.set(key, entry);
  }

  /**
   * Set user status (online/live/in_call). Offline is derived from disconnect/timeout.
   */
  async setStatus(userId, status, meta = {}) {
    const key = String(userId || '').trim();
    if (!key) throw new Error('userId is required');

    const normalized = normalizeStatus(status);
    if (!normalized || normalized === 'offline') {
      throw new Error('Invalid status');
    }

    const entry = this._onlineUsers.get(key);
    if (!entry) {
      // IMPORTANT:
      // Do NOT create an online presence record for users who are actually offline.
      // Some server-side workflows (e.g. call cleanup) may set status for a user
      // without having any active socket. In those cases, keep them offline.
      //
      // We only allow implicit "bring online" when the request is tied to a
      // currently-connected socket.
      if (meta.socketId) {
        await this.setOnline(key, meta);
      } else {
        return this._snapshotOnline(key);
      }
    }

    const current = this._onlineUsers.get(key);
    if (!current) return this._snapshotOnline(key);
    if (meta.socketId && current.socketId && String(meta.socketId) !== String(current.socketId)) {
      return this._snapshotOnline(key);
    }

    current.status = normalized;
    current.lastPing = Date.now();
    this._onlineUsers.set(key, current);

    const snapshot = this._snapshotOnline(key);
    this._emitChanged(key, snapshot, { reason: 'status_changed' });
    return snapshot;
  }

  /**
   * Backward compatible: busy/inCall
   */
  async setBusy(userId, isBusy, callDetails = null) {
    const status = isBusy ? 'in_call' : 'online';
    const meta = callDetails ? { callDetails } : {};
    return this.setStatus(userId, status, meta);
  }

  /**
   * Backward compatible: live
   */
  async setLive(userId, isLive, streamDetails = null) {
    const status = isLive ? 'live' : 'online';
    const meta = streamDetails ? { streamDetails } : {};
    return this.setStatus(userId, status, meta);
  }

  /**
   * Get user presence
   */
  async getPresence(userId) {
    const snapshot = this._snapshotOnline(userId);
    if (!snapshot) {
      const flags = statusToFlags('offline');
      return {
        online: flags.online,
        busy: flags.busy,
        live: flags.live,
        inCall: flags.inCall,
        status: flags.status,
        lastSeen: null,
      };
    }

    return {
      online: snapshot.online,
      busy: snapshot.busy,
      live: snapshot.live,
      inCall: snapshot.inCall,
      status: snapshot.status,
      lastSeen: snapshot.lastSeen,
    };
  }

  /**
   * Get multiple users presence
   * ✅ OPTIMIZED: No async needed, direct map access
   */
  async getMultiplePresence(userIds) {
    const results = {};
    const ids = Array.isArray(userIds) ? userIds : [];
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key) continue;
      // ✅ Direct snapshot (sync operation, no await needed)
      const snapshot = this._snapshotOnline(key);
      results[key] = {
        online: snapshot.online,
        busy: snapshot.busy,
        live: snapshot.live,
        inCall: snapshot.inCall,
        status: snapshot.status,
        lastSeen: snapshot.lastSeen,
      };
    }
    return results;
  }

  /**
   * Get all online users (internal debugging/monitoring)
   */
  async getOnlineUsers() {
    const users = [];
    for (const [userId, entry] of this._onlineUsers.entries()) {
      users.push({
        userId,
        socketId: entry.socketId,
        gender: entry.gender,
        status: entry.status,
        lastSeen: entry.lastPing,
        online: true,
        ...statusToFlags(entry.status),
      });
    }
    return users;
  }

  /**
   * Backward compatible cleanup hook.
   * In the new system, sweep runs on an interval already.
   */
  async cleanup() {
    this._sweepStale();
  }
}

const presenceService = new PresenceService();

module.exports = presenceService;
