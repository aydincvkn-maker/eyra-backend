/**
 * Socket disconnect handler.
 * Cleans up live rooms, presence, user socket map, and heartbeat timer.
 */

const { userSockets, socketGenderCache, activeCalls } = require("./state");
const LiveStream = require("../models/LiveStream");
const presenceService = require("../services/presenceService");
const pkMatchService = require("../services/pkMatchService");
const { emitToUserSockets } = require("./helpers");
const { logger } = require("../utils/logger");

function clearDirectCallRequest(roomName) {
  if (!global.callRequests || !roomName) return;

  for (const [requestId, request] of global.callRequests) {
    if (request.callRoomName === roomName && request.isDirectCall) {
      if (request._serverTickTimer) {
        clearInterval(request._serverTickTimer);
      }
      global.callRequests.delete(requestId);
      return;
    }
  }
}

async function cleanupActiveCallsForUser(userId) {
  const key = String(userId || "").trim();
  if (!key) return;

  for (const [roomName, callInfo] of activeCalls.entries()) {
    const callerId = String(callInfo.callerId || "");
    const targetUserId = String(callInfo.targetUserId || "");
    if (callerId !== key && targetUserId !== key) continue;

    const counterpartyId = callerId === key ? targetUserId : callerId;

    if (global.callTimeouts) {
      const timer = global.callTimeouts.get(roomName);
      if (timer) {
        clearTimeout(timer);
        global.callTimeouts.delete(roomName);
      }
    }

    clearDirectCallRequest(roomName);
    activeCalls.delete(roomName);

    await presenceService.setBusy(counterpartyId, false).catch((err) => {
      logger.warn("Call disconnect cleanup setBusy failed", {
        userId: counterpartyId,
        err: err.message,
      });
    });

    emitToUserSockets(counterpartyId, "call:ended", {
      roomName,
      endedBy: key,
      reason: "disconnect",
    });
  }
}

/**
 * Register the disconnect handler on a connected socket.
 * @param {Socket}   socket             - The connected Socket.io socket
 * @param {Server}   io                 - The Socket.io server instance
 * @param {Function} stopServerHeartbeat - Cleanup function for the per-socket heartbeat timer
 */
function register(socket, io, stopServerHeartbeat) {
  socket.on("disconnect", async (reason) => {
    const userId = socket.data?.userId || "unknown";
    const gender = socket.data?.gender || "other";
    logger.info("Socket disconnected", { userId, socketId: socket.id, reason });

    // Leave gender room
    const roomName = `viewer-${gender}`;
    socket.leave(roomName);

    // Clear gender cache
    socketGenderCache.delete(socket.id);

    // Live room cleanup: update viewerCount for any live rooms this socket was in
    const socketRooms = Array.from(socket.rooms || []);
    const liveRooms = socketRooms.filter((r) => r.startsWith("room_"));

    for (const liveRoomId of liveRooms) {
      try {
        socket.leave(liveRoomId);

        const updatedStream = await LiveStream.findOneAndUpdate(
          { roomId: liveRoomId },
          {
            $inc: { viewerCount: -1 },
            $pull: { viewers: userId },
          },
          { new: true },
        ).select("viewerCount host");

        if (updatedStream) {
          if (updatedStream.viewerCount < 0) {
            await LiveStream.updateOne(
              { _id: updatedStream._id },
              { $set: { viewerCount: 0 } },
            );
          }

          io.to(liveRoomId).emit("viewer_left", {
            roomId: liveRoomId,
            userId,
            viewerCount: Math.max(0, updatedStream.viewerCount),
            reason: "disconnect",
            timestamp: Date.now(),
          });

          logger.debug("User removed from live room on disconnect", {
            userId,
            roomId: liveRoomId,
            viewerCount: Math.max(0, updatedStream.viewerCount),
          });
        }
      } catch (e) {
        logger.error(`Live room cleanup error for ${liveRoomId}`, {
          err: e.message,
        });
      }
    }

    // Stop per-socket heartbeat
    stopServerHeartbeat();

    if (!userId || userId === "unknown") {
      return;
    }

    const key = String(userId).trim();
    const set = userSockets.get(key);

    // Ignore stale disconnect from old socket
    if (!set || !set.has(socket.id)) {
      logger.debug("Ignoring stale disconnect", {
        userId,
        socketId: socket.id,
      });
      return;
    }

    set.delete(socket.id);

    if (set.size === 0) {
      userSockets.delete(key);

      // PK bekleme kuyruğundan çıkar ve aktif PK eşleşmesini sonlandır
      try {
        pkMatchService.cleanupUser(userId);
        const pkMatch = await pkMatchService.endMatchByUser(userId);
        if (pkMatch) {
          const endedPayload = {
            pkRoomId: pkMatch.pkRoomId,
            reason: "disconnect",
          };
          io.to(pkMatch.hostA.streamRoomId).emit("pk:ended", {
            ...endedPayload,
            streamRoomId: pkMatch.hostA.streamRoomId,
          });
          io.to(pkMatch.hostB.streamRoomId).emit("pk:ended", {
            ...endedPayload,
            streamRoomId: pkMatch.hostB.streamRoomId,
          });
        }
      } catch (err) {
        logger.error("PK disconnect cleanup error", { err: String(err) });
      }

      await cleanupActiveCallsForUser(userId);

      // Immediate offline
      try {
        await presenceService.setOffline(userId, {
          socketId: socket.id,
          reason: reason || "disconnect",
        });
        logger.info("User marked offline", { userId, reason });

        // Close any active live streams
        const now = new Date();
        await LiveStream.updateMany(
          { host: userId, isLive: true, status: "live" },
          { $set: { isLive: false, status: "ended", endedAt: now } },
        ).catch((err) =>
          logger.error("LiveStream cleanup failed", { err: err.message }),
        );
      } catch (err) {
        logger.error("Disconnect cleanup error", { err: String(err) });
      }
    } else {
      userSockets.set(key, set);
    }
  });
}

module.exports = { register };
