// src/services/pkMatchService.js
// PK (versus) eşleştirme servisi.
//
// İki yayıncıyı PK düellosu için eşleştirir. İki mod desteklenir:
//   1) Otomatik kuyruk  — "PK Başlat" diyen yayıncılar sıraya girer; sırada
//      başka bekleyen varsa anında eşleşirler.
//   2) Manuel davet      — bir yayıncı bekleyen başka bir yayıncıya davet
//      gönderir; kabul edilirse eşleşirler.
//
// Eşleşince ortak bir LiveKit odası (pkRoomId) oluşturulur; iki host da bu
// odaya host token'ı ile bağlanıp karşılıklı yayın yapar. İzleyiciler de
// joinAsViewer üzerinden bu ortak odaya (subscribe-only) bağlanarak ikisini
// birden görür.
//
// NOT: Durum bellek içinde tutulur (tek instance varsayımı). Çok-instance
// dağıtımda Redis tabanlı bir kuyruğa taşınmalıdır.

const { v4: uuidv4 } = require("uuid");
const { createLiveKitToken, livekitUrl } = require("../utils/livekitToken");
const LiveStream = require("../models/LiveStream");
const { logger } = require("../utils/logger");

const PK_DURATION_SEC = 5 * 60; // 5 dakikalık düello

// Otomatik eşleşme için bekleyen yayıncılar.
// entry: { userId, streamRoomId, name, image, enqueuedAt }
let queue = [];

// matchId -> match
// match: { matchId, pkRoomId, startedAt, durationSec, hostA, hostB }
// hostX: { userId, streamRoomId, name, image }
const activeMatches = new Map();
const userToMatch = new Map(); // userId -> matchId
const roomToMatch = new Map(); // streamRoomId -> matchId

function isBusy(userId) {
  return userToMatch.has(String(userId));
}

function removeFromQueue(userId) {
  const key = String(userId);
  const before = queue.length;
  queue = queue.filter((e) => String(e.userId) !== key);
  return queue.length !== before;
}

function getWaitingList(excludeUserId) {
  const ex = String(excludeUserId || "");
  return queue
    .filter((e) => String(e.userId) !== ex)
    .map((e) => ({
      userId: e.userId,
      streamRoomId: e.streamRoomId,
      name: e.name,
      image: e.image,
    }));
}

async function buildMatch(a, b) {
  const matchId = uuidv4();
  const pkRoomId = "pk_" + Date.now().toString() + "_" + uuidv4().slice(0, 8);
  const startedAt = Date.now();
  const match = {
    matchId,
    pkRoomId,
    startedAt,
    durationSec: PK_DURATION_SEC,
    hostA: {
      userId: String(a.userId),
      streamRoomId: String(a.streamRoomId || ""),
      name: a.name,
      image: a.image,
    },
    hostB: {
      userId: String(b.userId),
      streamRoomId: String(b.streamRoomId || ""),
      name: b.name,
      image: b.image,
    },
  };

  activeMatches.set(matchId, match);
  userToMatch.set(match.hostA.userId, matchId);
  userToMatch.set(match.hostB.userId, matchId);
  if (match.hostA.streamRoomId)
    roomToMatch.set(match.hostA.streamRoomId, matchId);
  if (match.hostB.streamRoomId)
    roomToMatch.set(match.hostB.streamRoomId, matchId);

  // İki yayın dokümanına PK bilgisini yaz (izleyici-join ortak oda token'ı için)
  try {
    await Promise.all([
      LiveStream.updateOne(
        { roomId: match.hostA.streamRoomId },
        {
          $set: {
            isPk: true,
            pkRoomId,
            pkMatchId: matchId,
            pkStartedAt: new Date(startedAt),
            pkOpponent: {
              userId: match.hostB.userId,
              name: match.hostB.name,
              image: match.hostB.image,
            },
          },
        },
      ),
      LiveStream.updateOne(
        { roomId: match.hostB.streamRoomId },
        {
          $set: {
            isPk: true,
            pkRoomId,
            pkMatchId: matchId,
            pkStartedAt: new Date(startedAt),
            pkOpponent: {
              userId: match.hostA.userId,
              name: match.hostA.name,
              image: match.hostA.image,
            },
          },
        },
      ),
    ]);
  } catch (e) {
    logger.error("pkMatchService.buildMatch persist error", { err: e.message });
  }

  return match;
}

/**
 * Kuyruğa ekler ve mümkünse anında eşleştirir.
 * @returns {Promise<{status:'matched'|'waiting'|'already_in_match', match?:object}>}
 */
async function enqueueAndMatch(entry) {
  const key = String(entry.userId);

  if (userToMatch.has(key)) {
    return {
      status: "already_in_match",
      match: activeMatches.get(userToMatch.get(key)),
    };
  }

  const opponentIdx = queue.findIndex((e) => String(e.userId) !== key);
  if (opponentIdx >= 0) {
    const opponent = queue.splice(opponentIdx, 1)[0];
    removeFromQueue(entry.userId);
    const match = await buildMatch(opponent, entry);
    return { status: "matched", match };
  }

  removeFromQueue(entry.userId); // dedupe
  queue.push({ ...entry, enqueuedAt: Date.now() });
  return { status: "waiting" };
}

/**
 * Manuel davet kabul edilince iki yayıncıyı eşleştirir.
 */
async function createManualMatch(fromEntry, toEntry) {
  if (isBusy(fromEntry.userId) || isBusy(toEntry.userId)) {
    return { status: "busy" };
  }
  removeFromQueue(fromEntry.userId);
  removeFromQueue(toEntry.userId);
  const match = await buildMatch(fromEntry, toEntry);
  return { status: "matched", match };
}

function getMatchByUser(userId) {
  const id = userToMatch.get(String(userId));
  return id ? activeMatches.get(id) : null;
}

function getMatchByRoom(streamRoomId) {
  const id = roomToMatch.get(String(streamRoomId));
  return id ? activeMatches.get(id) : null;
}

async function endMatchByUser(userId) {
  const matchId = userToMatch.get(String(userId));
  if (!matchId) return null;
  return endMatch(matchId);
}

async function endMatchByRoom(streamRoomId) {
  const matchId = roomToMatch.get(String(streamRoomId));
  if (!matchId) return null;
  return endMatch(matchId);
}

async function endMatch(matchId) {
  const match = activeMatches.get(matchId);
  if (!match) return null;
  activeMatches.delete(matchId);
  userToMatch.delete(match.hostA.userId);
  userToMatch.delete(match.hostB.userId);
  roomToMatch.delete(match.hostA.streamRoomId);
  roomToMatch.delete(match.hostB.streamRoomId);

  try {
    await LiveStream.updateMany(
      { roomId: { $in: [match.hostA.streamRoomId, match.hostB.streamRoomId] } },
      {
        $set: { isPk: false },
        $unset: {
          pkRoomId: "",
          pkMatchId: "",
          pkOpponent: "",
          pkStartedAt: "",
        },
      },
    );
  } catch (e) {
    logger.error("pkMatchService.endMatch persist error", { err: e.message });
  }

  return match;
}

/** Bağlantısı kopan / çıkan kullanıcıyı kuyruktan temizler. */
function cleanupUser(userId) {
  removeFromQueue(userId);
}

/** Ortak PK odası için host (yayın izinli) token üretir. */
async function hostToken(match, userId) {
  return createLiveKitToken({
    userId,
    roomId: match.pkRoomId,
    canPublish: true,
  });
}

/** Ortak PK odası için izleyici (sadece izleme) token üretir. */
async function viewerToken(pkRoomId, userId) {
  return createLiveKitToken({ userId, roomId: pkRoomId, canPublish: false });
}

module.exports = {
  PK_DURATION_SEC,
  enqueueAndMatch,
  createManualMatch,
  removeFromQueue,
  getWaitingList,
  isBusy,
  getMatchByUser,
  getMatchByRoom,
  endMatchByUser,
  endMatchByRoom,
  hostToken,
  viewerToken,
  cleanupUser,
  livekitUrl,
};
