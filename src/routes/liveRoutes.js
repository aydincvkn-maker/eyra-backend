// src/routes/liveRoutes.js
const express = require("express");
const router = express.Router();
const liveController = require("../controllers/liveController");
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const { liveStartLimiter, chatLimiter, reportLimiter } = require("../middleware/rateLimit");

// ============ DEBUG ROUTES ============
// Token kontrolü (authentication debug)
router.post("/debug/token-check", auth, (req, res) => {
  res.json({
    ok: true,
    message: "Token valid ✅",
    userId: req.user.id,
    username: req.user.username,
    role: req.user.role,
  });
});

// LiveKit Token generation test
// ✅ FIX: async handler for livekit-server-sdk v2.x
router.post("/debug/generate-test-token", auth, async (req, res) => {
  try {
    const { AccessToken } = require("livekit-server-sdk");
    const roomId = `test_room_${Date.now()}`;
    const userId = req.user.id;
    
    console.log('🔵 [DEBUG] Generating test token...');
    console.log('   API_KEY:', process.env.LIVEKIT_API_KEY ? '✓' : '✗');
    console.log('   API_SECRET:', process.env.LIVEKIT_API_SECRET ? '✓' : '✗');
    console.log('   URL:', process.env.LIVEKIT_URL);
    
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: String(userId) }
    );
    
    at.addGrant({
      roomJoin: true,
      room: String(roomId),
      canPublish: true,
      canSubscribe: true
    });
    
    // ✅ FIX: await toJwt() for v2.x
    const token = await at.toJwt();
    
    // Decode token for inspection
    const parts = token.split('.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    
    res.json({
      ok: true,
      token,
      decoded: {
        header,
        payload: {
          sub: payload.sub,
          aud: payload.aud,
          iat: payload.iat,
          exp: payload.exp,
          video: payload.video,
          metadata: payload.metadata
        }
      },
      livekitUrl: process.env.LIVEKIT_URL
    });
  } catch (err) {
    console.error('❌ Test token generation failed:', err.message);
    res.status(500).json({
      ok: false,
      error: 'token_generation_failed',
      message: err.message
    });
  }
});

// ============ BROADCASTER ENDPOINTS ============
// Yayın başlat (Sadece kadınlar) - Rate limited: 5 attempts per 5 minutes
router.post("/start", auth, liveStartLimiter, liveController.startLive);

// Yayını sonlandır
router.post("/stop", auth, liveController.endLive);

// ============ VIEWER ENDPOINTS ============
// Yayına katıl (token al)
router.post("/viewer-join", auth, liveController.joinAsViewer);

// Yayından ayrıl
router.post("/viewer-leave", auth, liveController.leaveAsViewer);

// ============ LISTING ENDPOINTS ============
// Aktif yayınları listele (auth optional - provides user context)
router.get("/list", liveController.getActiveLives);

// Tek yayın detayı (auth optional - provides user context)
router.get("/stream/:roomId", liveController.getStreamDetails);

// Kullanıcının yayın geçmişi
router.get("/history/:userId", auth, liveController.getUserStreamHistory);

// ============ CHAT ENDPOINTS ============
// Chat mesajı gönder (rate limited)
router.post("/chat/send", auth, chatLimiter, liveController.sendChatMessage);

// Chat geçmişini getir
router.get("/chat/:roomId", auth, liveController.getChatHistory);

// ============ MODERATION ENDPOINTS ============
// Yayını flagle (report) - rate limited
router.post("/flag", auth, reportLimiter, liveController.flagStream);

// Yayını banla (admin only)
router.post("/ban", auth, admin, liveController.banStream);

// ============ CO-HOST ENDPOINTS ============
// Co-host daveti gönder (Host tarafından)
router.post("/cohost/invite", auth, liveController.inviteCoHost);

// Co-host davetini kabul et
router.post("/cohost/accept", auth, liveController.acceptCoHostInvite);

// Co-host davetini reddet
router.post("/cohost/reject", auth, liveController.rejectCoHostInvite);

// Co-host olarak ayrıl
router.post("/cohost/leave", auth, liveController.leaveAsCoHost);

// Co-host'u çıkar (Host tarafından)
router.post("/cohost/remove", auth, liveController.removeCoHost);

// Co-host listesini getir
router.get("/cohost/:roomId", auth, liveController.getCoHosts);

// Co-host ayarlarını güncelle
router.put("/cohost/settings", auth, liveController.updateCoHostSettings);

// ============ TRANSLATION ENDPOINTS ============
// Desteklenen dilleri getir
router.get("/translate/languages", liveController.getSupportedLanguages);

// Tek bir mesajı çevir
router.post("/translate/message", auth, liveController.translateMessage);

// Birden fazla mesajı toplu çevir
router.post("/translate/batch", auth, liveController.translateBatch);

// Chat geçmişini çevrilmiş olarak getir
router.get("/translate/chat/:roomId", auth, liveController.getTranslatedChatHistory);

// ============ PAID VIDEO CALL ENDPOINTS ============
// Yayıncının arama fiyatını getir
router.get("/call/price/:hostId", auth, liveController.getHostCallPrice);

// Yayıncı kendi arama fiyatını ayarlar
router.post("/call/set-price", auth, liveController.setCallPrice);

// İzleyici yayıncıya ücretli arama talebi gönderir
router.post("/call/request", auth, liveController.requestPaidCall);

// Yayıncı arama talebini kabul eder
router.post("/call/accept", auth, liveController.acceptPaidCall);

// Yayıncı arama talebini reddeder
router.post("/call/reject", auth, liveController.rejectPaidCall);

// Ücretli aramayı sonlandır
router.post("/call/end", auth, liveController.endPaidCall);

module.exports = router;
