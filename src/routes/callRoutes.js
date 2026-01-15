// src/routes/callRoutes.js
// Video call signaling endpoints

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const presenceService = require('../services/presenceService');
const { LIVEKIT_URL } = require('../config/env');
const { generateLiveKitToken } = require('../services/liveService');

/**
 * POST /api/calls/initiate
 * Start a call to another user
 */
router.post('/initiate', auth, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const callerId = req.user.id;
    const User = require('../models/User');

    if (!targetUserId) {
      return res.status(400).json({ message: 'targetUserId gerekli' });
    }

    if (callerId === targetUserId) {
      return res.status(400).json({ message: 'Kendinizi arayamazsınız' });
    }

    // Check if target user is available (socket-driven, in-memory)
    const targetPresence = await presenceService.getPresence(targetUserId);
    
    if (!targetPresence.online) {
      return res.status(400).json({ 
        message: 'Kullanıcı çevrimdışı',
        presenceStatus: 'offline'
      });
    }

    if (targetPresence.busy || targetPresence.inCall) {
      return res.status(400).json({ 
        message: 'Kullanıcı meşgul',
        presenceStatus: 'in_call'
      });
    }

    if (targetPresence.live) {
      return res.status(400).json({ 
        message: 'Kullanıcı canlı yayında',
        presenceStatus: 'live'
      });
    }

    // Create room
    const roomName = `call_${callerId}_${targetUserId}_${Date.now()}`;

    // Set both users as busy
    await Promise.all([
      presenceService.setBusy(callerId, true, {
        partnerId: targetUserId,
        roomName
      }),
      presenceService.setBusy(targetUserId, true, {
        partnerId: callerId,
        roomName
      })
    ]);

    // Store call info in global state
    if (global.activeCalls) {
      global.activeCalls.set(roomName, {
        callerId,
        targetUserId,
        roomName,
        createdAt: Date.now()
      });
    }

    // Notify target user via socket
    if (global.io && global.userSockets) {
      const targetKey = String(targetUserId);
      console.log(`📞 Looking for target user: ${targetKey}`);
      console.log(`📞 Active user sockets: ${Array.from(global.userSockets.keys()).join(', ')}`);
      
      const targetSockets = global.userSockets.get(targetKey);
      if (targetSockets && targetSockets.size > 0) {
        console.log(`✅ Found ${targetSockets.size} socket(s) for ${targetKey}`);
        const callerData = await require('../models/User').findById(callerId).select('username profileImage');
        
        targetSockets.forEach(socketId => {
          console.log(`📡 Sending incoming_call to socket ${socketId}`);
          global.io.to(socketId).emit('incoming_call', {
            callerId: String(callerId),
            callerName: callerData?.username || 'Unknown',
            callerImage: callerData?.profileImage || '',
            roomName,
            timestamp: Date.now()
          });
        });
      } else {
        console.log(`❌ No sockets found for target user ${targetKey}`);
      }
    }

    res.json({
      success: true,
      roomName,
      callerId: String(callerId),
      targetUserId: String(targetUserId),
      message: 'Arama başlatıldı'
    });

  } catch (error) {
    console.error('❌ Call initiate error:', error);
    res.status(500).json({ message: 'Sunucu hatası' });
  }
});

/**
 * POST /api/calls/end
 * End an active call
 */
router.post('/end', auth, async (req, res) => {
  try {
    const { roomName } = req.body;
    const userId = req.user.id;

    if (!roomName) {
      return res.status(400).json({ message: 'roomName gerekli' });
    }

    // Get call info
    const callInfo = global.activeCalls?.get(roomName);
    
    if (callInfo) {
      const { callerId, targetUserId } = callInfo;

      // Set both users as no longer busy
      await Promise.all([
        presenceService.setBusy(callerId, false),
        presenceService.setBusy(targetUserId, false)
      ]);

      // Remove from active calls
      global.activeCalls.delete(roomName);

      // Notify via socket
      if (global.io) {
        global.io.emit('call:ended', {
          roomName,
          endedBy: String(userId),
          timestamp: Date.now()
        });
      }
    }

    res.json({
      success: true,
      message: 'Arama sonlandırıldı'
    });

  } catch (error) {
    console.error('❌ Call end error:', error);
    res.status(500).json({ message: 'Sunucu hatası' });
  }
});

/**
 * POST /api/calls/reject
 * Reject an incoming call
 */
router.post('/reject', auth, async (req, res) => {
  try {
    const { roomName } = req.body;
    const userId = req.user.id;

    if (!roomName) {
      return res.status(400).json({ message: 'roomName gerekli' });
    }

    // Get call info
    const callInfo = global.activeCalls?.get(roomName);
    
    if (callInfo) {
      const { callerId, targetUserId } = callInfo;

      // Set both users as no longer busy
      await Promise.all([
        presenceService.setBusy(callerId, false),
        presenceService.setBusy(targetUserId, false)
      ]);

      // Remove from active calls
      global.activeCalls.delete(roomName);

      // Notify caller via socket that call was rejected
      if (global.io && global.userSockets) {
        const callerKey = String(callerId);
        const callerSockets = global.userSockets.get(callerKey);
        if (callerSockets && callerSockets.size > 0) {
          callerSockets.forEach(socketId => {
            global.io.to(socketId).emit('call:rejected', {
              roomName,
              rejectedBy: String(userId),
              timestamp: Date.now()
            });
          });
        }
      }
    }

    res.json({
      success: true,
      message: 'Arama reddedildi'
    });

  } catch (error) {
    console.error('❌ Call reject error:', error);
    res.status(500).json({ message: 'Sunucu hatası' });
  }
});

/**
 * POST /api/calls/token
 * Generate LiveKit token for a call room
 */
router.post('/token', auth, async (req, res) => {
  try {
    const { roomName, userName } = req.body;
    const userId = String(req.user.id);

    if (!roomName) {
      return res.status(400).json({ ok: false, message: 'roomName gerekli' });
    }

    const displayName = (userName || req.user.username || 'User').toString();
    const token = await generateLiveKitToken(roomName, displayName, userId);

    if (!token || typeof token !== 'string') {
      return res.status(500).json({ ok: false, message: 'Token üretilemedi' });
    }

    return res.json({
      ok: true,
      token,
      roomName,
      livekitUrl: LIVEKIT_URL,
    });
  } catch (error) {
    console.error('❌ Call token error:', error);
    return res.status(500).json({ ok: false, message: 'Sunucu hatası' });
  }
});


/**
 * GET /api/calls/active
 * Get active calls for debugging
 */
router.get('/active', auth, async (req, res) => {
  try {
    const activeCalls = global.activeCalls ? 
      Array.from(global.activeCalls.entries()).map(([roomName, info]) => ({
        roomName,
        ...info
      })) : [];

    res.json({
      count: activeCalls.length,
      calls: activeCalls
    });
  } catch (error) {
    console.error('❌ Get active calls error:', error);
    res.status(500).json({ message: 'Sunucu hatası' });
  }
});

module.exports = router;
