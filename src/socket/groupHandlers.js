// src/socket/groupHandlers.js
// Grup yayını koltuk + sıra (rotasyon) socket olayları.
//
// İstemci → Sunucu:
//   group:get_state        { roomId }  - Mevcut koltuk/sıra durumunu iste
//   group:join_seat_queue  { roomId }  - Yayıncı (kadın) sıraya girer
//   group:leave            { roomId }  - Koltuk/sıra/BOSS'tan ayrıl
//   group:pause_seat       { roomId }  - Aramaya geçerken koltuğu dondur
//   group:resume_seat      { roomId }  - Aramadan dönünce koltuğu sürdür
//
// Sunucu → İstemci:
//   group:state { roomId, seats[6], queue[], queueCount, boss }

const groupSeat = require("../services/groupSeatService");
const LiveStream = require("../models/LiveStream");
const User = require("../models/User");
const { sanitizeSocketPayload } = require("../middleware/validate");
const { logger } = require("../utils/logger");

let _loopStarted = false;

async function _isGroupLive(roomId) {
  const stream = await LiveStream.findOne({ roomId, isLive: true })
    .select("streamType")
    .lean();
  return !!stream && stream.streamType === "group";
}

function register(socket, io) {
  // Rotasyon döngüsünü tek sefer başlat (io stabil).
  if (!_loopStarted) {
    _loopStarted = true;
    groupSeat.hydrate();
    groupSeat.startRotationLoop((roomId, state) => {
      io.to(roomId).emit("group:state", state);
    });
  }

  const publish = (roomId, state) => {
    if (state) io.to(String(roomId)).emit("group:state", state);
  };

  socket.on("group:get_state", (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    if (!roomId || typeof roomId !== "string") return;
    const state = groupSeat.getState(roomId);
    socket.emit("group:state", state);
  });

  socket.on("group:join_seat_queue", async (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId) return;

    try {
      // Sadece kadın yayıncılar koltuk sırasına girebilir.
      const user = await User.findById(userId)
        .select("gender name username profileImage")
        .lean();
      if (!user || String(user.gender).toLowerCase() !== "female") {
        socket.emit("group:error", { message: "only_broadcaster_can_queue" });
        return;
      }
      if (!(await _isGroupLive(roomId))) {
        socket.emit("group:error", { message: "group_not_live" });
        return;
      }

      socket.join(roomId);
      if (!socket.data._groupRooms) socket.data._groupRooms = new Set();
      socket.data._groupRooms.add(roomId);

      const state = groupSeat.joinQueue(roomId, {
        userId,
        name: user.name || user.username || "Yayıncı",
        image: user.profileImage || "",
      });
      publish(roomId, state);
    } catch (e) {
      logger.error("group:join_seat_queue error", { err: e.message });
      socket.emit("group:error", { message: "join_queue_failed" });
    }
  });

  socket.on("group:leave", (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId) return;
    const state = groupSeat.leave(roomId, userId);
    if (socket.data._groupRooms) socket.data._groupRooms.delete(roomId);
    publish(roomId, state);
  });

  socket.on("group:pause_seat", (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId) return;
    const state = groupSeat.pauseSeat(roomId, userId);
    publish(roomId, state);
  });

  socket.on("group:resume_seat", (rawData) => {
    const { roomId } = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!roomId || typeof roomId !== "string" || !userId) return;
    const state = groupSeat.resumeSeat(roomId, userId);
    publish(roomId, state);
  });

  // Bağlantı kopunca girdiği tüm grup odalarından çıkar.
  socket.on("disconnect", () => {
    const userId = socket.data.userId;
    const roomsJoined = socket.data._groupRooms;
    if (!userId || !roomsJoined || roomsJoined.size === 0) return;
    for (const roomId of roomsJoined) {
      const state = groupSeat.leave(roomId, userId);
      publish(roomId, state);
    }
    roomsJoined.clear();
  });
}

module.exports = { register };
