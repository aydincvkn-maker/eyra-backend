// src/socket/pkHandlers.js
// PK (versus) eşleşme socket olayları.
//
// İstemci → Sunucu olayları:
//   pk:find_opponent { streamRoomId }     - Otomatik kuyruğa gir
//   pk:cancel        {}                    - Kuyruktan çık
//   pk:list_waiting  {}                    - Bekleyen yayıncıları listele (manuel davet için)
//   pk:invite        { targetUserId, streamRoomId }  - Davet gönder
//   pk:accept        { fromUserId, streamRoomId }     - Daveti kabul et
//   pk:reject        { fromUserId }        - Daveti reddet
//   pk:leave         {}                    - PK'dan ayrıl / bitir
//
// Sunucu → İstemci olayları:
//   pk:waiting, pk:waiting_list, pk:matched, pk:cancelled,
//   pk:invite_received, pk:invite_sent, pk:invite_rejected,
//   pk:invite_failed, pk:invite_expired, pk:ended, pk:error

const pkMatch = require("../services/pkMatchService");
const { emitToUserSockets } = require("./helpers");
const { sanitizeSocketPayload } = require("../middleware/validate");
const User = require("../models/User");
const { logger } = require("../utils/logger");

// Bekleyen manuel davetler: `${fromUserId}_${toUserId}` -> { from, toUserId, createdAt }
const invites = new Map();
const INVITE_TTL_MS = 60 * 1000;

function pruneInvites() {
  const now = Date.now();
  for (const [key, inv] of invites.entries()) {
    if (now - inv.createdAt > INVITE_TTL_MS) invites.delete(key);
  }
}

async function profileEntry(userId, streamRoomId) {
  const u = await User.findById(userId)
    .select("name username profileImage")
    .lean();
  return {
    userId: String(userId),
    streamRoomId: String(streamRoomId || ""),
    name: u?.name || u?.username || "Yayıncı",
    image: u?.profileImage || "",
  };
}

function pub(h) {
  return {
    userId: h.userId,
    name: h.name,
    image: h.image,
    streamRoomId: h.streamRoomId,
  };
}

// Basit per-socket cooldown: PK eşleşme/davet spam'ini önler.
function tooSoon(socket, key, ms) {
  if (!socket.data._pkCooldown) socket.data._pkCooldown = {};
  const now = Date.now();
  const last = socket.data._pkCooldown[key] || 0;
  if (now - last < ms) return true;
  socket.data._pkCooldown[key] = now;
  return false;
}

// Eşleşme oluşunca iki host'a kendi yayın token'larını, izleyici odalarına
// ortak PK odasını bildirir.
async function emitMatched(io, match) {
  const sides = [
    { me: match.hostA, opp: match.hostB },
    { me: match.hostB, opp: match.hostA },
  ];

  for (const { me, opp } of sides) {
    const token = await pkMatch.hostToken(match, me.userId);
    emitToUserSockets(me.userId, "pk:matched", {
      pkRoomId: match.pkRoomId,
      token,
      livekitUrl: pkMatch.livekitUrl(),
      durationSec: match.durationSec,
      startedAt: match.startedAt,
      myStreamRoomId: me.streamRoomId,
      opponent: { userId: opp.userId, name: opp.name, image: opp.image },
    });
  }

  // İzleyicilere ortak odaya geçmelerini bildir
  const startedPayload = {
    pkRoomId: match.pkRoomId,
    durationSec: match.durationSec,
    startedAt: match.startedAt,
    hostA: pub(match.hostA),
    hostB: pub(match.hostB),
  };
  io.to(match.hostA.streamRoomId).emit("pk:started", {
    ...startedPayload,
    streamRoomId: match.hostA.streamRoomId,
  });
  io.to(match.hostB.streamRoomId).emit("pk:started", {
    ...startedPayload,
    streamRoomId: match.hostB.streamRoomId,
  });

  logger.info(
    `🥊 PK matched: ${match.hostA.userId} vs ${match.hostB.userId} (room ${match.pkRoomId})`,
  );
}

async function emitEnded(io, match, reason = "host_left") {
  if (!match) return;
  const payload = { pkRoomId: match.pkRoomId, reason };
  emitToUserSockets(match.hostA.userId, "pk:ended", payload);
  emitToUserSockets(match.hostB.userId, "pk:ended", payload);
  io.to(match.hostA.streamRoomId).emit("pk:ended", {
    ...payload,
    streamRoomId: match.hostA.streamRoomId,
  });
  io.to(match.hostB.streamRoomId).emit("pk:ended", {
    ...payload,
    streamRoomId: match.hostB.streamRoomId,
  });
}

function register(socket, io) {
  // ── Otomatik kuyruğa gir ──
  socket.on("pk:find_opponent", async (raw) => {
    const { streamRoomId } = sanitizeSocketPayload(raw);
    const userId = socket.data.userId;
    if (!userId || !streamRoomId || typeof streamRoomId !== "string") return;
    if (tooSoon(socket, "find", 2000)) return;
    try {
      const entry = await profileEntry(userId, streamRoomId);
      const result = await pkMatch.enqueueAndMatch(entry);
      if (result.status === "matched" || result.status === "already_in_match") {
        if (result.match) await emitMatched(io, result.match);
      } else {
        socket.emit("pk:waiting", { streamRoomId });
      }
    } catch (e) {
      logger.error("pk:find_opponent error", { err: e.message });
      socket.emit("pk:error", { message: "match_failed" });
    }
  });

  // ── Kuyruktan çık ──
  socket.on("pk:cancel", () => {
    const userId = socket.data.userId;
    if (!userId) return;
    pkMatch.removeFromQueue(userId);
    socket.emit("pk:cancelled", {});
  });

  // ── Bekleyen yayıncı listesi (manuel davet) ──
  socket.on("pk:list_waiting", () => {
    const userId = socket.data.userId;
    if (!userId) return;
    socket.emit("pk:waiting_list", { hosts: pkMatch.getWaitingList(userId) });
  });

  // ── Davet gönder ──
  socket.on("pk:invite", async (raw) => {
    const { targetUserId, streamRoomId } = sanitizeSocketPayload(raw);
    const userId = socket.data.userId;
    if (!userId || !targetUserId || !streamRoomId) return;
    if (String(targetUserId) === String(userId)) return;
    if (tooSoon(socket, "invite", 2000)) return;
    pruneInvites();
    if (pkMatch.isBusy(userId) || pkMatch.isBusy(targetUserId)) {
      socket.emit("pk:invite_failed", { reason: "busy" });
      return;
    }
    try {
      const from = await profileEntry(userId, streamRoomId);
      invites.set(`${userId}_${targetUserId}`, {
        from,
        toUserId: String(targetUserId),
        createdAt: Date.now(),
      });
      const delivered = emitToUserSockets(targetUserId, "pk:invite_received", {
        from: pub(from),
      });
      socket.emit("pk:invite_sent", {
        targetUserId: String(targetUserId),
        delivered,
      });
    } catch (e) {
      logger.error("pk:invite error", { err: e.message });
      socket.emit("pk:invite_failed", { reason: "error" });
    }
  });

  // ── Daveti kabul et ──
  socket.on("pk:accept", async (raw) => {
    const { fromUserId, streamRoomId } = sanitizeSocketPayload(raw);
    const userId = socket.data.userId;
    if (!userId || !fromUserId || !streamRoomId) return;
    pruneInvites();
    const key = `${fromUserId}_${userId}`;
    const inv = invites.get(key);
    if (!inv) {
      socket.emit("pk:invite_expired", {});
      return;
    }
    invites.delete(key);
    if (pkMatch.isBusy(userId) || pkMatch.isBusy(fromUserId)) {
      socket.emit("pk:invite_failed", { reason: "busy" });
      return;
    }
    try {
      const to = await profileEntry(userId, streamRoomId);
      const result = await pkMatch.createManualMatch(inv.from, to);
      if (result.status === "matched") {
        await emitMatched(io, result.match);
      } else {
        socket.emit("pk:invite_failed", { reason: result.status });
      }
    } catch (e) {
      logger.error("pk:accept error", { err: e.message });
      socket.emit("pk:invite_failed", { reason: "error" });
    }
  });

  // ── Daveti reddet ──
  socket.on("pk:reject", (raw) => {
    const { fromUserId } = sanitizeSocketPayload(raw);
    const userId = socket.data.userId;
    if (!userId || !fromUserId) return;
    invites.delete(`${fromUserId}_${userId}`);
    emitToUserSockets(fromUserId, "pk:invite_rejected", {
      byUserId: String(userId),
    });
  });

  // ── PK'dan ayrıl / bitir ──
  socket.on("pk:leave", async () => {
    const userId = socket.data.userId;
    if (!userId) return;
    try {
      const match = await pkMatch.endMatchByUser(userId);
      if (match) await emitEnded(io, match, "host_left");
    } catch (e) {
      logger.error("pk:leave error", { err: e.message });
    }
  });
}

module.exports = { register, invites };
