// src/services/groupSeatService.js
// Grup yayını koltuk + sıra (rotasyon) servisi.
//
// Model (oda başına):
//   - 6 rotasyon koltuğu (grid). Her koltukta bir yayıncı 60 sn kalır.
//   - Süre bitince yayıncı sıranın SONUNA döner, sıradaki ilk yayıncı boş
//     koltuğa anında girer (otomatik rotasyon).
//   - Ayrı bir BOSS koltuğu (erkek kullanıcı ücret ödeyerek oturur) — burada
//     sadece durum tutulur; coin düşürme REST tarafında yapılır.
//
// Durum bellek içinde otoriter tutulur (tek instance varsayımı, pkMatchService
// ile aynı desen). Redis varsa her değişiklikte snapshot yazılır; sunucu
// yeniden başlarsa `hydrate()` ile geri yüklenir (mutlak expiresAt sayesinde
// kalan süre korunur).

const { getRedisClient } = require("../config/redis");
const { logger } = require("../utils/logger");

const SEAT_COUNT = 6;
const SEAT_DURATION_MS = 60 * 1000; // 60 saniye
const REDIS_PREFIX = "group:seats:";
const REDIS_TTL_SEC = 6 * 60 * 60; // 6 saat

// roomId -> { seats: Array(6)<seat|null>, queue: entry[], boss: entry|null }
// seat:  { userId, name, image, expiresAt(ms), paused(bool), pausedRemainingMs }
// entry: { userId, name, image }
const rooms = new Map();

// Rotasyon/değişiklik olduğunda çağrılan yayın callback'i (socket katmanı verir)
let onUpdate = null;
let loopTimer = null;

const now = () => Date.now();

function _getRoom(roomId) {
    const key = String(roomId || "").trim();
    if (!key) return null;
    if (!rooms.has(key)) {
        rooms.set(key, {
            seats: new Array(SEAT_COUNT).fill(null),
            queue: [],
            boss: null,
        });
    }
    return rooms.get(key);
}

function _sanitizeEntry(entry) {
    return {
        userId: String(entry.userId),
        name: entry.name || "Yayıncı",
        image: entry.image || "",
    };
}

function _isKnown(room, userId) {
    const id = String(userId);
    if (room.seats.some((s) => s && s.userId === id)) return true;
    if (room.queue.some((e) => e.userId === id)) return true;
    if (room.boss && room.boss.userId === id) return true;
    return false;
}

// Boş koltukları sıradaki yayıncılarla doldur.
function _fill(room) {
    let changed = false;
    for (let i = 0; i < SEAT_COUNT; i++) {
        if (room.seats[i] == null && room.queue.length > 0) {
            const entry = room.queue.shift();
            room.seats[i] = {
                ...entry,
                expiresAt: now() + SEAT_DURATION_MS,
                paused: false,
                pausedRemainingMs: 0,
            };
            changed = true;
        }
    }
    return changed;
}

// Süresi dolan koltukları sıra sonuna al, sonra boşları doldur.
function _tick(room) {
    let changed = false;
    const ts = now();
    for (let i = 0; i < SEAT_COUNT; i++) {
        const seat = room.seats[i];
        if (seat && !seat.paused && seat.expiresAt <= ts) {
            room.queue.push({ userId: seat.userId, name: seat.name, image: seat.image });
            room.seats[i] = null;
            changed = true;
        }
    }
    if (_fill(room)) changed = true;
    return changed;
}

function _isRoomEmpty(room) {
    return (
        room.queue.length === 0 &&
        room.boss == null &&
        room.seats.every((s) => s == null)
    );
}

function _publicState(roomId, room) {
    const ts = now();
    return {
        roomId: String(roomId),
        seats: room.seats.map((s) =>
            s == null
                ? null
                : {
                    userId: s.userId,
                    name: s.name,
                    image: s.image,
                    remainingSec: s.paused
                        ? Math.ceil(s.pausedRemainingMs / 1000)
                        : Math.max(0, Math.ceil((s.expiresAt - ts) / 1000)),
                    paused: s.paused === true,
                },
        ),
        queue: room.queue.map((e) => ({ userId: e.userId, name: e.name, image: e.image })),
        queueCount: room.queue.length,
        boss: room.boss
            ? { userId: room.boss.userId, name: room.boss.name, image: room.boss.image }
            : null,
    };
}

async function _persist(roomId, room) {
    const redis = getRedisClient();
    if (!redis) return;
    try {
        await redis.setex(
            REDIS_PREFIX + roomId,
            REDIS_TTL_SEC,
            JSON.stringify({ seats: room.seats, queue: room.queue, boss: room.boss }),
        );
    } catch (e) {
        logger.warn("⚠️ [groupSeat] persist failed:", e.message);
    }
}

async function _removePersist(roomId) {
    const redis = getRedisClient();
    if (!redis) return;
    try {
        await redis.del(REDIS_PREFIX + roomId);
    } catch (e) {
        logger.warn("⚠️ [groupSeat] remove persist failed:", e.message);
    }
}

// ─── Public API ───────────────────────────────────────────────

function getState(roomId) {
    const room = _getRoom(roomId);
    if (!room) return null;
    return _publicState(roomId, room);
}

// Yayıncı grup sırasına girer (otomatik). Boş koltuk varsa anında oturur.
function joinQueue(roomId, entry) {
    const room = _getRoom(roomId);
    if (!room) return null;
    const clean = _sanitizeEntry(entry);
    if (!_isKnown(room, clean.userId)) {
        room.queue.push(clean);
        _fill(room);
        _persist(roomId, room);
    }
    return _publicState(roomId, room);
}

// Yayıncı gruptan ayrılır (koltuk / sıra / boss).
function leave(roomId, userId) {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return null;
    const id = String(userId);
    let changed = false;

    for (let i = 0; i < SEAT_COUNT; i++) {
        if (room.seats[i] && room.seats[i].userId === id) {
            room.seats[i] = null;
            changed = true;
        }
    }
    const beforeQueue = room.queue.length;
    room.queue = room.queue.filter((e) => e.userId !== id);
    if (room.queue.length !== beforeQueue) changed = true;
    if (room.boss && room.boss.userId === id) {
        room.boss = null;
        changed = true;
    }
    if (changed) _fill(room);

    if (_isRoomEmpty(room)) {
        rooms.delete(String(roomId).trim());
        _removePersist(roomId);
        return { roomId: String(roomId), seats: new Array(SEAT_COUNT).fill(null), queue: [], queueCount: 0, boss: null };
    }
    if (changed) _persist(roomId, room);
    return _publicState(roomId, room);
}

// Hediye ile koltuk süresini uzat (saniye).
function extendSeat(roomId, userId, seconds) {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return { changed: false, state: null };
    const id = String(userId);
    const add = Math.max(0, Math.floor(Number(seconds) || 0)) * 1000;
    if (add <= 0) return { changed: false, state: _publicState(roomId, room) };
    for (let i = 0; i < SEAT_COUNT; i++) {
        const seat = room.seats[i];
        if (seat && seat.userId === id) {
            if (seat.paused) {
                seat.pausedRemainingMs += add;
            } else {
                seat.expiresAt += add;
            }
            _persist(roomId, room);
            return { changed: true, state: _publicState(roomId, room) };
        }
    }
    return { changed: false, state: _publicState(roomId, room) };
}

// Koltuktaki yayıncı aramaya geçtiğinde: kalan süreyi dondur (koltuğu korur).
function pauseSeat(roomId, userId) {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return null;
    const id = String(userId);
    for (let i = 0; i < SEAT_COUNT; i++) {
        const seat = room.seats[i];
        if (seat && seat.userId === id && !seat.paused) {
            seat.paused = true;
            seat.pausedRemainingMs = Math.max(0, seat.expiresAt - now());
            _persist(roomId, room);
            return _publicState(roomId, room);
        }
    }
    return _publicState(roomId, room);
}

// Arama bitince koltuğu kaldığı yerden devam ettir.
function resumeSeat(roomId, userId) {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return null;
    const id = String(userId);
    for (let i = 0; i < SEAT_COUNT; i++) {
        const seat = room.seats[i];
        if (seat && seat.userId === id && seat.paused) {
            seat.paused = false;
            seat.expiresAt = now() + Math.max(0, seat.pausedRemainingMs);
            seat.pausedRemainingMs = 0;
            _persist(roomId, room);
            return _publicState(roomId, room);
        }
    }
    return _publicState(roomId, room);
}

// BOSS koltuğuna oturt (coin düşümü REST tarafında yapılır).
function setBoss(roomId, entry) {
    const room = _getRoom(roomId);
    if (!room) return null;
    room.boss = _sanitizeEntry(entry);
    _persist(roomId, room);
    return _publicState(roomId, room);
}

function clearBoss(roomId, userId) {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return null;
    if (room.boss && (!userId || room.boss.userId === String(userId))) {
        room.boss = null;
        if (_isRoomEmpty(room)) {
            rooms.delete(String(roomId).trim());
            _removePersist(roomId);
            return { roomId: String(roomId), seats: new Array(SEAT_COUNT).fill(null), queue: [], queueCount: 0, boss: null };
        }
        _persist(roomId, room);
    }
    return _publicState(roomId, room);
}

// Yayın bittiğinde odanın tüm durumunu temizle.
function clearRoom(roomId) {
    const key = String(roomId || "").trim();
    rooms.delete(key);
    _removePersist(key);
}

// Hediye değerine göre uzatma saniyesi (ileride detaylandırılacak).
function giftExtendSeconds(valueCoins) {
    const v = Number(valueCoins) || 0;
    if (v < 50) return 10;
    if (v < 200) return 20;
    if (v < 500) return 40;
    return 60;
}

// ─── Rotasyon döngüsü ─────────────────────────────────────────

function startRotationLoop(publishFn) {
    onUpdate = typeof publishFn === "function" ? publishFn : null;
    if (loopTimer) return;
    loopTimer = setInterval(() => {
        for (const [roomId, room] of rooms.entries()) {
            const changed = _tick(room);
            if (_isRoomEmpty(room)) {
                rooms.delete(roomId);
                _removePersist(roomId);
                continue;
            }
            if (changed) {
                _persist(roomId, room);
                if (onUpdate) {
                    try {
                        onUpdate(roomId, _publicState(roomId, room));
                    } catch (e) {
                        logger.warn("⚠️ [groupSeat] onUpdate failed:", e.message);
                    }
                }
            }
        }
    }, 1000);
    if (loopTimer.unref) loopTimer.unref();
}

function stopRotationLoop() {
    if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = null;
    }
}

// Sunucu başlangıcında Redis snapshot'larından geri yükle.
async function hydrate() {
    const redis = getRedisClient();
    if (!redis) return;
    try {
        let cursor = "0";
        const keys = [];
        do {
            const [next, batch] = await redis.scan(
                cursor,
                "MATCH",
                REDIS_PREFIX + "*",
                "COUNT",
                100,
            );
            cursor = next;
            if (Array.isArray(batch)) keys.push(...batch);
        } while (cursor !== "0");

        for (const key of keys) {
            try {
                const raw = await redis.get(key);
                if (!raw) continue;
                const data = JSON.parse(raw);
                const roomId = key.slice(REDIS_PREFIX.length);
                rooms.set(roomId, {
                    seats: Array.isArray(data.seats)
                        ? data.seats.slice(0, SEAT_COUNT)
                        : new Array(SEAT_COUNT).fill(null),
                    queue: Array.isArray(data.queue) ? data.queue : [],
                    boss: data.boss || null,
                });
            } catch (_) {
                /* tek kayıt hatası göz ardı */
            }
        }
        if (keys.length > 0) {
            logger.info(`♻️ [groupSeat] ${keys.length} oda snapshot geri yüklendi`);
        }
    } catch (e) {
        logger.warn("⚠️ [groupSeat] hydrate failed:", e.message);
    }
}

module.exports = {
    SEAT_COUNT,
    SEAT_DURATION_MS,
    getState,
    joinQueue,
    leave,
    extendSeat,
    pauseSeat,
    resumeSeat,
    setBoss,
    clearBoss,
    clearRoom,
    giftExtendSeconds,
    startRotationLoop,
    stopRotationLoop,
    hydrate,
};
