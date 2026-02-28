// src/controllers/liveController.js
const LiveStream = require("../models/LiveStream");
const User = require("../models/User");
const Message = require("../models/Message");
const Report = require("../models/Report");
const { v4: uuidv4 } = require("uuid");
const { AccessToken } = require("livekit-server-sdk");
const presenceService = require("../services/presenceService");
const liveService = require("../services/liveService");
const translationService = require("../services/translationService");
const { optimizeStreamList, getStreamThumbnail, getProfileImageUrl } = require("../utils/cdn");
const { trackMissionProgress } = require("./missionController");
const { checkStreamAchievements } = require("./achievementController");

// ============ CATEGORY MAPPING (Turkish → English) ============
const CATEGORY_MAP = {
  'sohbet': 'chat',
  'chat': 'chat',
  'muzik': 'music',
  'music': 'music',
  'dans': 'dance',
  'dance': 'dance',
  'yetenek': 'talk',
  'talk': 'talk',
  'oyun': 'gaming',
  'gaming': 'gaming',
  'diger': 'other',
  'other': 'other',
};

const normalizeCategory = (input) => {
  if (!input) return 'chat';
  const normalized = String(input).toLowerCase().trim();
  return CATEGORY_MAP[normalized] || 'chat';
};

// ============ TOKEN GENERATORS ============

const generateHostToken = async (userId, roomId) => {
  try {
    console.log('🔵 [generateHostToken] Creating token...');
    console.log('   userId:', userId, '(type:', typeof userId, ')');
    console.log('   roomId:', roomId);
    console.log('   LIVEKIT_API_KEY:', process.env.LIVEKIT_API_KEY ? '✓ SET' : '✗ MISSING');
    console.log('   LIVEKIT_API_SECRET:', process.env.LIVEKIT_API_SECRET ? '✓ SET' : '✗ MISSING');
    console.log('   LIVEKIT_URL:', process.env.LIVEKIT_URL || '✗ MISSING');
    
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      throw new Error('LIVEKIT credentials missing (LIVEKIT_API_KEY or LIVEKIT_API_SECRET)');
    }

    if (!roomId || String(roomId).trim().length === 0) {
      throw new Error('LIVEKIT roomId missing/empty');
    }
    
    // ✅ IMPORTANT: Convert userId to string properly (handles ObjectId)
    const identity = userId && userId.toString ? userId.toString() : String(userId);
    console.log('   identity:', identity, '(length:', identity.length, ')');
    
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity }
    );

    at.addGrant({
      roomJoin: true,
      room: String(roomId),
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    // ✅ FIX: livekit-server-sdk v2.x'te toJwt() Promise döndürür
    const token = await at.toJwt();
    
    // Debug token type
    console.log('🔵 [DEBUG] token type:', typeof token);
    console.log('🔵 [DEBUG] token value:', token);
    console.log('🔵 [DEBUG] token constructor:', token?.constructor?.name);
    
    // ✅ Make sure token is a string
    let tokenString = token;
    if (typeof token === 'string') {
      tokenString = token;
    } else if (token && typeof token === 'object') {
      // Eğer object ise, string'e çevir
      tokenString = token.toString();
    } else {
      // Fallback
      tokenString = String(token);
    }
    
    console.log('🔵 [DEBUG] final tokenString type:', typeof tokenString);
    console.log('🔵 [DEBUG] final tokenString length:', tokenString.length);
    
    if (!tokenString || tokenString === 'undefined' || tokenString === '[object Object]') {
      console.error('❌ Token generation failed! Got:', tokenString);
      throw new Error('Token generation failed: toJwt() returned invalid value');
    }
    
    // ✅ Detailed token validation logging
    try {
      const parts = tokenString.split('.');
      if (parts.length !== 3) {
        throw new Error(`Invalid JWT parts: expected 3, got ${parts.length}`);
      }
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      console.log('✅ [generateHostToken] Token created successfully');
      console.log('   Header:', header);
      console.log('   Payload sub:', payload.sub);
    } catch (decodeErr) {
      console.warn('⚠️ Could not decode token for logging:', decodeErr.message);
      console.warn('⚠️ But token should still be valid');
    }
    
    return tokenString;
  } catch (err) {
    console.error('❌ generateHostToken error:', err.message);
    console.error('Stack:', err.stack);
    throw new Error('host_token_generation_failed: ' + err.message);
  }
};

const generateViewerToken = async (userId, roomId) => {
  try {
    console.log('🔵 [generateViewerToken] Creating viewer token...');
    console.log('   userId:', userId, '(type:', typeof userId, ')');
    console.log('   roomId:', roomId);
    
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      throw new Error('LIVEKIT credentials missing (LIVEKIT_API_KEY or LIVEKIT_API_SECRET)');
    }

    if (!roomId || String(roomId).trim().length === 0) {
      throw new Error('LIVEKIT roomId missing/empty');
    }
    
    // ✅ IMPORTANT: Convert userId to string properly (handles ObjectId)
    const identity = userId && userId.toString ? userId.toString() : String(userId);
    console.log('   identity:', identity, '(length:', identity.length, ')');
    
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity }
    );

    at.addGrant({
      roomJoin: true,
      room: String(roomId),
      canPublish: false,
      canSubscribe: true,
      canPublishData: true
    });

    // ✅ FIX: livekit-server-sdk v2.x'te toJwt() Promise döndürür
    const token = await at.toJwt();
    
    console.log('🔵 [DEBUG] viewer token type:', typeof token);
    console.log('🔵 [DEBUG] viewer token exists:', !!token);
    
    // ✅ Make sure token is a string
    let tokenString = token;
    if (typeof token === 'string') {
      tokenString = token;
    } else if (token && typeof token === 'object') {
      tokenString = token.toString();
    } else {
      tokenString = String(token);
    }
    
    if (!tokenString || tokenString === 'undefined' || tokenString === '[object Object]') {
      console.error('❌ Viewer token generation failed! Got:', tokenString);
      throw new Error('Viewer token generation failed');
    }
    
    // ✅ Detailed token validation logging
    try {
      const parts = tokenString.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('✅ [generateViewerToken] Token created successfully, sub:', payload.sub);
      }
    } catch (decodeErr) {
      console.warn('⚠️ Viewer token decode failed:', decodeErr.message);
    }
    
    return tokenString;
  } catch (err) {
    console.error('❌ generateViewerToken error:', err.message);
    console.error('Stack:', err.stack);
    throw new Error('viewer_token_generation_failed: ' + err.message);
  }
};

// ============ YAYINCI ENDPOINTS ============

/**
 * Yayın başlat (Sadece kadınlar)
 */
exports.startLive = async (req, res) => {
  try {
    const userId = req.user.id;
    let { title, category, description, quality, resolution } = req.body;
    
    // Kategoriyi normalize et (Turkish → English)
    category = normalizeCategory(category);
    
    // Quality settings validation
    const validQualities = ['low', 'medium', 'high', 'auto'];
    const validResolutions = ['480p', '720p', '1080p'];
    quality = validQualities.includes(quality) ? quality : 'auto';
    resolution = validResolutions.includes(resolution) ? resolution : '720p';
    
    // Bitrate based on quality
    const bitrateMap = {
      'low': 1000,
      'medium': 2000,
      'high': 4000,
      'auto': 2500
    };
    const bitrate = bitrateMap[quality] || 2000;
    
    console.log('🔵 [startLive] Starting live broadcast...');
    console.log('   userId:', userId);
    console.log('   title:', title);
    console.log('   category (normalized):', category);
    console.log('   quality:', quality, 'resolution:', resolution);

    // Cinsiyet kontrolü
    const host = await User.findById(userId).select('gender isBanned isActive username name profileImage');
    console.log('🔵 [startLive] Host found:', host ? `${host.username} (${host.gender})` : 'NOT FOUND');
    
    if (!host) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }
    if (host.isBanned || host.isActive === false) {
      return res.status(403).json({ ok: false, error: "account_restricted" });
    }
    if (host.gender !== 'female') {
      console.log('⚠️ [startLive] Gender check failed:', host.gender);
      return res.status(403).json({ 
        ok: false, 
        error: "only_female_can_broadcast", 
        message: "Only female users can start a live broadcast" 
      });
    }

    // Zaten yayında mı?
    const existing = await LiveStream.findOne({
      host: userId,
      isLive: true,
      status: "live"
    });

    if (existing) {
      // Zaten yayında, mevcut token'ı döndür
      const token = await generateHostToken(userId, existing.roomId);
      return res.json({
        ok: true,
        message: "already_live",
        streamId: existing.roomId,
        liveId: existing._id,
        token,
        livekitUrl: process.env.LIVEKIT_URL
      });
    }

    // Yeni yayın oluştur
    const roomId = "room_" + Date.now().toString() + "_" + uuidv4().slice(0, 8);
    console.log('🔵 [startLive] Creating stream with roomId:', roomId);

    const stream = await LiveStream.create({
      host: userId,
      title: title || `${host.name || host.username}'s Live`,
      description: description || "",
      category: category || "chat",
      thumbnailUrl: host.profileImage || "",
      isLive: true,
      status: "live",
      viewerCount: 0,
      roomId,
      platform: "Mobile",
      quality,
      resolution,
      bitrate,
    });
    
    console.log('✅ [startLive] Stream created:', stream._id);

    // ✅ Cache invalidate - yeni yayın eklendi
    try {
      await liveService.invalidateStreamCache();
    } catch (e) {
      console.warn('⚠️ Cache invalidation failed:', e.message);
    }

    // User'ı live olarak işaretle
    await User.findByIdAndUpdate(userId, { isLive: true }, { runValidators: false });

    // Presence'ı güncelle
    try {
      await presenceService.setLive(userId, true, { streamId: roomId });
    } catch (e) {
      console.warn('⚠️ presenceService.setLive failed:', e.message);
    }

    // Token oluştur
    console.log('🔵 [startLive] Generating host token...');
    const token = await generateHostToken(userId, roomId);
    console.log('✅ [startLive] Token generated, length:', token?.length);

    // ✅ Mission & Achievement tracking for streaming
    try {
      await trackMissionProgress(userId, 'first_stream');
      await trackMissionProgress(userId, 'weekly_stream');
      // Stream count for achievements
      const streamCount = await LiveStream.countDocuments({ host: userId });
      await checkStreamAchievements(userId, streamCount);
    } catch (e) { console.warn('⚠️ Mission/achievement tracking failed:', e.message); }

    res.status(201).json({
      ok: true,
      streamId: roomId,
      liveId: stream._id,
      token,
      livekitUrl: process.env.LIVEKIT_URL,
      stream: {
        _id: stream._id,
        roomId: stream.roomId,
        title: stream.title,
        category: stream.category,
        host: {
          _id: host._id,
          username: host.username,
          name: host.name,
          profileImage: host.profileImage
        }
      }
    });
  } catch (err) {
    console.error("❌ startLive error:", err.message);
    console.error("Stack:", err.stack);
    res.status(500).json({ 
      ok: false, 
      error: "live_start_failed",
      details: err.message 
    });
  }
};

/**
 * Yayını sonlandır
 */
exports.endLive = async (req, res) => {
  try {
    const userId = req.user.id;
    const { liveId, roomId } = req.body;

    // Yayını bul
    let stream;
    if (liveId) {
      stream = await LiveStream.findById(liveId);
    } else if (roomId) {
      stream = await LiveStream.findOne({ roomId });
    } else {
      // Kullanıcının aktif yayınını bul
      stream = await LiveStream.findOne({ host: userId, isLive: true, status: "live" });
    }

    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Sadece yayın sahibi kapatabilir
    if (String(stream.host) !== String(userId)) {
      return res.status(403).json({ ok: false, error: "not_authorized" });
    }

    // ✅ PROFESSIONAL: Önce tüm izleyicileri kaydet (bildirim için)
    const viewerIds = [...(stream.viewers || [])];
    const finalViewerCount = stream.viewerCount || 0;
    const streamRoomId = stream.roomId;

    // Yayını kapat
    stream.isLive = false;
    stream.status = "ended";
    stream.endedAt = new Date();
    stream.viewerCount = 0; // Reset viewer count
    stream.viewers = []; // Clear viewers array
    await stream.save();

    // ✅ Cache invalidate - yayın kapandı
    try {
      await liveService.invalidateStreamCache(streamRoomId);
    } catch (e) {
      console.warn('⚠️ Cache invalidation failed:', e.message);
    }

    // User'ı offline yap
    await User.findByIdAndUpdate(userId, { isLive: false }, { runValidators: false });

    // Presence'ı güncelle
    try {
      await presenceService.setLive(userId, false);
    } catch (e) {
      console.warn('⚠️ presenceService.setLive(false) failed:', e.message);
    }

    // ✅ PROFESSIONAL: İzleyicilere detaylı bildir
    if (global.io) {
      // Odadaki herkese stream_ended eventi
      global.io.to(streamRoomId).emit('stream_ended', {
        roomId: streamRoomId,
        hostId: userId,
        duration: stream.duration,
        totalGiftsValue: stream.totalGiftsValue,
        peakViewerCount: stream.peakViewerCount,
        finalViewerCount,
        endedAt: stream.endedAt,
        reason: 'host_ended'
      });

      // ✅ Socket.io room'daki tüm socket'ları room'dan çıkar
      const sockets = await global.io.in(streamRoomId).fetchSockets();
      for (const s of sockets) {
        s.leave(streamRoomId);
      }
      
      console.log(`📺 Stream ${streamRoomId} ended by host. ${sockets.length} sockets removed from room.`);
    }

    res.json({ 
      ok: true, 
      message: "Yayın sonlandırıldı",
      stats: {
        duration: stream.duration,
        totalGiftsValue: stream.totalGiftsValue,
        peakViewerCount: stream.peakViewerCount,
        totalGiftsCount: stream.totalGiftsCount
      }
    });
  } catch (err) {
    console.error("endLive error:", err);
    res.status(500).json({ ok: false, error: "live_stop_failed" });
  }
};

// ============ İZLEYİCİ ENDPOINTS ============

/**
 * Yayına katıl (token al)
 */
exports.joinAsViewer = async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user.id;

    if (!roomId) {
      return res.status(400).json({ ok: false, error: "missing_room" });
    }

    const stream = await LiveStream.findOne({ roomId, isLive: true, status: "live" })
      .populate('host', 'username name profileImage');

    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Token oluştur
    const token = await generateViewerToken(userId, roomId);

    // ✅ ATOMIC UPDATE: İzleyici sayısını güvenli şekilde artır
    // Race condition önleme: $inc ve $addToSet kullan
    const updatedStream = await LiveStream.findOneAndUpdate(
      { roomId, isLive: true, status: "live" },
      {
        $inc: { viewerCount: 1 },
        $addToSet: { viewers: userId }
      },
      { new: true }
    );

    if (!updatedStream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Peak viewer count'u güncelle (eğer yeni değer daha büyükse)
    if (updatedStream.viewerCount > updatedStream.peakViewerCount) {
      await LiveStream.updateOne(
        { _id: updatedStream._id },
        { $max: { peakViewerCount: updatedStream.viewerCount } }
      );
    }

    // Socket ile bildir
    if (global.io) {
      global.io.to(roomId).emit('viewer_joined', {
        roomId,
        viewerCount: updatedStream.viewerCount,
        userId
      });
    }

    // ✅ Mission tracking for watching streams
    try { await trackMissionProgress(userId, 'watch_stream'); } catch (_) {}

    res.json({
      ok: true,
      token,
      livekitUrl: process.env.LIVEKIT_URL,
      viewerCount: updatedStream.viewerCount,
      stream: {
        _id: updatedStream._id,
        roomId: updatedStream.roomId,
        title: updatedStream.title,
        category: updatedStream.category,
        host: stream.host
      }
    });
  } catch (err) {
    console.error("joinAsViewer error:", err);
    res.status(500).json({ ok: false, error: "join_failed" });
  }
};

/**
 * Yayından ayrıl
 */
exports.leaveAsViewer = async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user.id;

    if (!roomId) {
      return res.status(400).json({ ok: false, error: "missing_room" });
    }

    // ✅ ATOMIC UPDATE: İzleyici sayısını güvenli şekilde azalt
    const stream = await LiveStream.findOneAndUpdate(
      { roomId },
      {
        $inc: { viewerCount: -1 },
        $pull: { viewers: userId }
      },
      { new: true }
    );
    
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // viewerCount negatif olmasın
    if (stream.viewerCount < 0) {
      await LiveStream.updateOne(
        { _id: stream._id },
        { $set: { viewerCount: 0 } }
      );
      stream.viewerCount = 0;
    }

    // Socket ile bildir
    if (global.io) {
      global.io.to(roomId).emit('viewer_left', {
        roomId,
        viewerCount: stream.viewerCount,
        userId
      });
    }

    res.json({ ok: true, viewerCount: stream.viewerCount });
  } catch (err) {
    console.error("leaveAsViewer error:", err);
    res.status(500).json({ ok: false, error: "leave_failed" });
  }
};

// ============ LİSTELEME ENDPOINTS ============

/**
 * Aktif yayınları listele (Redis cache ile)
 */
exports.getActiveLives = async (req, res) => {
  try {
    const { category, limit = 50, page = 1 } = req.query;
    
    // ✅ Redis cache kullan
    const result = await liveService.getActiveStreamsWithCache({
      category,
      limit: parseInt(limit),
      page: parseInt(page)
    });

    const formattedStreams = result.streams
      .filter(s => s.host && s.host._id)
      .map(stream => ({
        _id: stream._id,
        roomId: stream.roomId,
        title: stream.title,
        category: stream.category,
        description: stream.description,
        viewerCount: stream.viewerCount || 0,
        quality: stream.quality || 'auto',
        resolution: stream.resolution || '720p',
        // ✅ CDN optimized thumbnail
        thumbnailUrl: getStreamThumbnail(stream),
        startedAt: stream.startedAt,
        host: {
          _id: stream.host._id,
          username: stream.host.username,
          name: stream.host.name,
          // ✅ CDN optimized profile image
          profileImage: getProfileImageUrl(stream.host.profileImage),
          gender: stream.host.gender
        }
      }));

    res.json({
      ok: true,
      streams: formattedStreams,
      pagination: result.pagination,
      cached: result.cached || false
    });
  } catch (err) {
    console.error("getActiveLives error:", err);
    res.status(500).json({ ok: false, error: "list_failed" });
  }
};

/**
 * Tek yayın detayı (Redis cache ile)
 */
exports.getStreamDetails = async (req, res) => {
  try {
    const { roomId } = req.params;

    // ✅ Redis cache kullan
    const stream = await liveService.getStreamDetailWithCache(roomId);

    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    res.json({ ok: true, stream });
  } catch (err) {
    console.error("getStreamDetails error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

/**
 * Yayın geçmişi (belirli kullanıcının)
 */
exports.getUserStreamHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;

    const streams = await LiveStream.find({ 
      host: userId, 
      status: "ended" 
    })
      .sort({ endedAt: -1 })
      .limit(parseInt(limit))
      .select('title category viewerCount peakViewerCount totalGiftsValue duration startedAt endedAt')
      .lean();

    res.json({ ok: true, streams });
  } catch (err) {
    console.error("getUserStreamHistory error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

// ============ CHAT ENDPOINTS ============

/**
 * Chat mesajı gönder
 */
exports.sendChatMessage = async (req, res) => {
  try {
    const { roomId, message, type = "text" } = req.body;
    const userId = req.user.id;

    if (!roomId || !message) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    if (message.length > 500) {
      return res.status(400).json({ ok: false, error: "message_too_long" });
    }

    // Yayın aktif mi kontrol et
    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Kullanıcı bilgilerini al
    const user = await User.findById(userId).select('username name profileImage');

    // Mesajı kaydet
    const msg = await Message.create({
      roomId,
      from: userId,
      type,
      content: message,
    });

    // Socket ile tüm izleyicilere gönder
    if (global.io) {
      global.io.to(roomId).emit('chat_message', {
        _id: msg._id,
        roomId,
        type,
        content: message,
        sender: {
          _id: userId,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage
        },
        timestamp: msg.createdAt
      });
    }

    res.status(201).json({ ok: true, message: msg });
  } catch (err) {
    console.error("sendChatMessage error:", err);
    res.status(500).json({ ok: false, error: "send_failed" });
  }
};

/**
 * Chat geçmişini getir
 */
exports.getChatHistory = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 100, before } = req.query;

    const query = { roomId };
    if (before) {
      query._id = { $lt: before };
    }

    const messages = await Message.find(query)
      .populate('from', 'username name profileImage')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({ 
      ok: true, 
      messages: messages.reverse() 
    });
  } catch (err) {
    console.error("getChatHistory error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

// ============ MODERASYON ============

/**
 * Yayını flagle (moderasyon)
 */
exports.flagStream = async (req, res) => {
  try {
    const { roomId, reason } = req.body;

    const stream = await LiveStream.findOne({ roomId });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    stream.isFlagged = true;
    stream.flagReason = reason;
    await stream.save();

    // ✅ Create report record for admin panel
    try {
      const reporterId = req.user?.id;
      const targetId = stream.host;

      if (reporterId && targetId) {
        await Report.create({
          reporter: reporterId,
          target: targetId,
          stream: stream._id,
          roomId: stream.roomId,
          reason: String(reason || "").trim(),
          status: "open",
        });
      }
    } catch (e) {
      console.warn("⚠️ Report create failed:", e.message);
    }

    res.json({ ok: true, message: "Yayın işaretlendi" });
  } catch (err) {
    console.error("flagStream error:", err);
    res.status(500).json({ ok: false, error: "flag_failed" });
  }
};

/**
 * Yayını banla (admin)
 */
exports.banStream = async (req, res) => {
  try {
    const { roomId, reason, streamId } = req.body;

    let stream = null;
    if (roomId) {
      stream = await LiveStream.findOne({ roomId });
    } else if (streamId) {
      stream = await LiveStream.findById(streamId);
    }

    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // ✅ PROFESSIONAL: Önce tüm izleyicileri kaydet
    const viewerIds = [...(stream.viewers || [])];
    const streamRoomId = stream.roomId;
    const hostId = stream.host;

    stream.isLive = false;
    stream.status = "banned";
    stream.flagReason = reason;
    stream.bannedAt = new Date();
    stream.endedAt = new Date();
    stream.viewerCount = 0;
    stream.viewers = [];
    await stream.save();
    
    // ✅ Cache invalidate
    try {
      await liveService.invalidateStreamCache(streamRoomId);
    } catch (e) {
      console.warn('⚠️ Cache invalidation failed:', e.message);
    }

    // Host'u offline yap
    await User.findByIdAndUpdate(hostId, { isLive: false });
    
    // Presence güncelle
    try {
      await presenceService.setLive(hostId, false);
    } catch (e) {}

    // ✅ PROFESSIONAL: İzleyicilere detaylı bildir
    if (global.io) {
      global.io.to(streamRoomId).emit('stream_banned', {
        roomId: streamRoomId,
        hostId: String(hostId),
        reason,
        bannedAt: stream.bannedAt
      });
      
      // ✅ Socket.io room'daki tüm socket'ları room'dan çıkar
      const sockets = await global.io.in(streamRoomId).fetchSockets();
      for (const s of sockets) {
        s.leave(streamRoomId);
      }
      
      console.log(`🚫 Stream ${streamRoomId} banned by admin. ${sockets.length} sockets removed from room.`);
    }

    res.json({ ok: true, message: "Yayın yasaklandı" });
  } catch (err) {
    console.error("banStream error:", err);
    res.status(500).json({ ok: false, error: "ban_failed" });
  }
};

/**
 * Yayın yasağını kaldır (admin)
 */
exports.unbanStream = async (req, res) => {
  try {
    const { roomId, streamId } = req.body;

    let stream = null;
    if (roomId) {
      stream = await LiveStream.findOne({ roomId });
    } else if (streamId) {
      stream = await LiveStream.findById(streamId);
    }

    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    stream.isLive = false;
    stream.status = "ended";
    stream.isFlagged = false;
    stream.flagReason = undefined;
    stream.bannedAt = undefined;
    await stream.save();

    try {
      await liveService.invalidateStreamCache(stream.roomId);
    } catch (e) {
      console.warn("⚠️ Cache invalidation failed:", e.message);
    }

    res.json({ ok: true, message: "Yayın yasağı kaldırıldı" });
  } catch (err) {
    console.error("unbanStream error:", err);
    res.status(500).json({ ok: false, error: "unban_failed" });
  }
};

// ============ CO-HOST ENDPOINTS ============

/**
 * Co-host token oluştur (yayın + izleme yetkisi olan)
 */
const generateCoHostToken = async (userId, roomId, canPublish = true) => {
  try {
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: String(userId) }
    );

    at.addGrant({
      roomJoin: true,
      rooms: [roomId],  // ✅ FIXED: 'room' -> 'rooms' (array)
      canPublish: canPublish,       // Video/ses paylaşabilir
      canSubscribe: true,           // Diğerlerini izleyebilir
      canPublishData: true          // Chat mesajı gönderebilir
    });

    // ✅ FIX: livekit-server-sdk v2.x'te toJwt() Promise döndürür
    return await at.toJwt();
  } catch (err) {
    console.error('❌ generateCoHostToken error:', err.message);
    throw new Error('token_generation_failed: ' + err.message);
  }
};

/**
 * Co-host daveti gönder (Host tarafından)
 */
exports.inviteCoHost = async (req, res) => {
  try {
    const hostId = req.user.id;
    const { roomId, userId, role = 'guest' } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: "user_id_required" });
    }

    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Sadece host davet edebilir
    if (String(stream.host) !== String(hostId)) {
      return res.status(403).json({ ok: false, error: "only_host_can_invite" });
    }

    // Co-host isteklerine açık mı?
    if (!stream.allowCoHostRequests) {
      return res.status(403).json({ ok: false, error: "cohost_requests_disabled" });
    }

    // Max co-host kontrolü
    const activeCoHosts = stream.coHosts.filter(c => c.status === 'accepted');
    if (activeCoHosts.length >= stream.maxCoHosts) {
      return res.status(400).json({ 
        ok: false, 
        error: "max_cohosts_reached",
        max: stream.maxCoHosts 
      });
    }

    // Zaten co-host mu veya beklemede mi?
    const existingCoHost = stream.coHosts.find(c => String(c.user) === String(userId));
    if (existingCoHost) {
      if (existingCoHost.status === 'accepted') {
        return res.status(400).json({ ok: false, error: "already_cohost" });
      }
      if (existingCoHost.status === 'pending') {
        return res.status(400).json({ ok: false, error: "already_invited" });
      }
    }

    // Kullanıcıyı kontrol et
    const user = await User.findById(userId).select('username name profileImage isBanned');
    if (!user || user.isBanned) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    // Co-host olarak ekle (pending durumunda)
    stream.coHosts.push({
      user: userId,
      role: role,
      status: 'pending',
      canPublish: true,
      canModerate: role === 'moderator'
    });
    await stream.save();

    // Kullanıcıya bildirim gönder (socket)
    if (global.io) {
      global.io.to(`user_${userId}`).emit('cohost:invite', {
        roomId,
        streamId: stream._id,
        hostId,
        role
      });
    }

    res.json({ 
      ok: true, 
      message: "Davet gönderildi",
      invite: {
        userId,
        username: user.username,
        role,
        status: 'pending'
      }
    });
  } catch (err) {
    console.error("inviteCoHost error:", err);
    res.status(500).json({ ok: false, error: "invite_failed" });
  }
};

/**
 * Co-host davetini kabul et
 */
exports.acceptCoHostInvite = async (req, res) => {
  try {
    const userId = req.user.id;
    const { roomId } = req.body;

    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Davet edilmiş mi?
    const coHostIndex = stream.coHosts.findIndex(
      c => String(c.user) === String(userId) && c.status === 'pending'
    );
    
    if (coHostIndex === -1) {
      return res.status(404).json({ ok: false, error: "invite_not_found" });
    }

    // Max co-host kontrolü (son anda dolmuş olabilir)
    const activeCoHosts = stream.coHosts.filter(c => c.status === 'accepted');
    if (activeCoHosts.length >= stream.maxCoHosts) {
      return res.status(400).json({ ok: false, error: "max_cohosts_reached" });
    }

    // Daveti kabul et
    stream.coHosts[coHostIndex].status = 'accepted';
    stream.coHosts[coHostIndex].joinedAt = new Date();
    await stream.save();

    // ✅ SAFE: Token generation with error handling
    let token;
    try {
      const canPublish = stream.coHosts[coHostIndex].canPublish;
      token = await generateCoHostToken(userId, roomId, canPublish);
    } catch (tokenErr) {
      console.error('⚠️ Token generation failed, returning error:', tokenErr.message);
      return res.status(500).json({ 
        ok: false, 
        error: "token_generation_failed",
        details: tokenErr.message 
      });
    }

    // Herkese bildir
    if (global.io) {
      const user = await User.findById(userId).select('username name profileImage');
      global.io.to(roomId).emit('cohost:joined', {
        roomId,
        userId,
        user: {
          _id: user._id,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage
        },
        role: stream.coHosts[coHostIndex].role
      });
    }

    res.json({ 
      ok: true, 
      message: "Yayına katıldınız",
      token,
      livekitUrl: process.env.LIVEKIT_URL,
      role: stream.coHosts[coHostIndex].role,
      canPublish: stream.coHosts[coHostIndex].canPublish
    });
  } catch (err) {
    console.error("acceptCoHostInvite error:", err);
    res.status(500).json({ ok: false, error: "accept_failed" });
  }
};

/**
 * Co-host davetini reddet
 */
exports.rejectCoHostInvite = async (req, res) => {
  try {
    const userId = req.user.id;
    const { roomId } = req.body;

    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    const coHostIndex = stream.coHosts.findIndex(
      c => String(c.user) === String(userId) && c.status === 'pending'
    );
    
    if (coHostIndex === -1) {
      return res.status(404).json({ ok: false, error: "invite_not_found" });
    }

    stream.coHosts[coHostIndex].status = 'rejected';
    await stream.save();

    // Host'a bildir
    if (global.io) {
      global.io.to(roomId).emit('cohost:rejected', {
        roomId,
        userId
      });
    }

    res.json({ ok: true, message: "Davet reddedildi" });
  } catch (err) {
    console.error("rejectCoHostInvite error:", err);
    res.status(500).json({ ok: false, error: "reject_failed" });
  }
};

/**
 * Co-host olarak yayından ayrıl
 */
exports.leaveAsCoHost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { roomId } = req.body;

    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    const coHostIndex = stream.coHosts.findIndex(
      c => String(c.user) === String(userId) && c.status === 'accepted'
    );
    
    if (coHostIndex === -1) {
      return res.status(404).json({ ok: false, error: "not_a_cohost" });
    }

    stream.coHosts[coHostIndex].status = 'left';
    await stream.save();

    // Herkese bildir
    if (global.io) {
      global.io.to(roomId).emit('cohost:left', {
        roomId,
        userId
      });
    }

    res.json({ ok: true, message: "Yayından ayrıldınız" });
  } catch (err) {
    console.error("leaveAsCoHost error:", err);
    res.status(500).json({ ok: false, error: "leave_failed" });
  }
};

/**
 * Co-host'u yayından çıkar (Host tarafından)
 */
exports.removeCoHost = async (req, res) => {
  try {
    const hostId = req.user.id;
    const { roomId, userId } = req.body;

    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    // Sadece host çıkarabilir
    if (String(stream.host) !== String(hostId)) {
      return res.status(403).json({ ok: false, error: "only_host_can_remove" });
    }

    const coHostIndex = stream.coHosts.findIndex(
      c => String(c.user) === String(userId) && c.status === 'accepted'
    );
    
    if (coHostIndex === -1) {
      return res.status(404).json({ ok: false, error: "cohost_not_found" });
    }

    stream.coHosts[coHostIndex].status = 'left';
    await stream.save();

    // Co-host'a ve herkese bildir
    if (global.io) {
      global.io.to(`user_${userId}`).emit('cohost:removed', {
        roomId
      });
      global.io.to(roomId).emit('cohost:left', {
        roomId,
        userId,
        removedByHost: true
      });
    }

    res.json({ ok: true, message: "Co-host yayından çıkarıldı" });
  } catch (err) {
    console.error("removeCoHost error:", err);
    res.status(500).json({ ok: false, error: "remove_failed" });
  }
};

/**
 * Yayındaki co-host listesini getir
 */
exports.getCoHosts = async (req, res) => {
  try {
    const { roomId } = req.params;

    const stream = await LiveStream.findOne({ roomId })
      .populate('coHosts.user', 'username name profileImage');
    
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    const activeCoHosts = stream.coHosts
      .filter(c => c.status === 'accepted')
      .map(c => ({
        userId: c.user._id,
        username: c.user.username,
        name: c.user.name,
        profileImage: c.user.profileImage,
        role: c.role,
        joinedAt: c.joinedAt,
        canPublish: c.canPublish,
        canModerate: c.canModerate
      }));

    res.json({ 
      ok: true, 
      coHosts: activeCoHosts,
      maxCoHosts: stream.maxCoHosts,
      allowRequests: stream.allowCoHostRequests
    });
  } catch (err) {
    console.error("getCoHosts error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

/**
 * Co-host ayarlarını güncelle (Host tarafından)
 */
exports.updateCoHostSettings = async (req, res) => {
  try {
    const hostId = req.user.id;
    const { roomId, maxCoHosts, allowCoHostRequests } = req.body;

    const stream = await LiveStream.findOne({ roomId, isLive: true });
    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    if (String(stream.host) !== String(hostId)) {
      return res.status(403).json({ ok: false, error: "only_host_can_update" });
    }

    if (maxCoHosts !== undefined) {
      stream.maxCoHosts = Math.min(Math.max(maxCoHosts, 1), 10); // 1-10 arası
    }
    if (allowCoHostRequests !== undefined) {
      stream.allowCoHostRequests = allowCoHostRequests;
    }

    await stream.save();

    res.json({ 
      ok: true, 
      maxCoHosts: stream.maxCoHosts,
      allowCoHostRequests: stream.allowCoHostRequests
    });
  } catch (err) {
    console.error("updateCoHostSettings error:", err);
    res.status(500).json({ ok: false, error: "update_failed" });
  }
};

// ============ TRANSLATION ENDPOINTS ============

/**
 * Tek bir mesajı çevir
 */
exports.translateMessage = async (req, res) => {
  try {
    const { text, targetLang, sourceLang } = req.body;

    if (!text || !targetLang) {
      return res.status(400).json({ ok: false, error: "text and targetLang required" });
    }

    const result = await translationService.translateText(text, targetLang, sourceLang || 'auto');

    res.json({
      ok: true,
      original: text,
      translated: result.translatedText,
      detectedLanguage: result.detectedLanguage,
      targetLang
    });
  } catch (err) {
    console.error("translateMessage error:", err);
    res.status(500).json({ ok: false, error: "translation_failed" });
  }
};

/**
 * Birden fazla mesajı toplu çevir
 */
exports.translateBatch = async (req, res) => {
  try {
    const { texts, targetLang, sourceLang } = req.body;

    if (!texts || !Array.isArray(texts) || !targetLang) {
      return res.status(400).json({ ok: false, error: "texts array and targetLang required" });
    }

    if (texts.length > 50) {
      return res.status(400).json({ ok: false, error: "max 50 texts per request" });
    }

    const results = await translationService.translateBatch(texts, targetLang, sourceLang || 'auto');

    res.json({
      ok: true,
      translations: results,
      targetLang
    });
  } catch (err) {
    console.error("translateBatch error:", err);
    res.status(500).json({ ok: false, error: "translation_failed" });
  }
};

/**
 * Chat geçmişini çevrilmiş olarak getir
 */
exports.getTranslatedChatHistory = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 100, targetLang } = req.query;

    if (!targetLang) {
      return res.status(400).json({ ok: false, error: "targetLang query param required" });
    }

    const messages = await Message.find({ roomId })
      .populate('from', 'username name profileImage')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Mesajları çevir
    const translatedMessages = await Promise.all(
      messages.map(async (msg) => {
        if (msg.type === 'gift') return msg;
        
        const translated = await translationService.translateChatMessage(msg, targetLang);
        return {
          ...msg,
          content: translated.content,
          originalContent: translated.originalContent,
          isTranslated: translated.isTranslated,
          detectedLanguage: translated.detectedLanguage
        };
      })
    );

    res.json({ 
      ok: true, 
      messages: translatedMessages.reverse(),
      targetLang
    });
  } catch (err) {
    console.error("getTranslatedChatHistory error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

/**
 * Desteklenen dilleri getir
 */
exports.getSupportedLanguages = async (req, res) => {
  try {
    const languages = translationService.getSupportedLanguages();
    res.json({ ok: true, languages });
  } catch (err) {
    console.error("getSupportedLanguages error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

// ============ PAID VIDEO CALL ENDPOINTS ============

/**
 * Yayıncıdan ücretli görüntülü arama talebi gönder
 * İzleyici yayıncıyı arayabilir (coin karşılığı)
 */
exports.requestPaidCall = async (req, res) => {
  try {
    const { roomId, duration = 5 } = req.body; // duration: dakika cinsinden
    const callerId = req.user.id;

    if (!roomId) {
      return res.status(400).json({ ok: false, error: "roomId required" });
    }

    // Yayını bul
    const stream = await LiveStream.findOne({ roomId, isLive: true })
      .populate('host', 'username name profileImage callPricePerMinute');

    if (!stream) {
      return res.status(404).json({ ok: false, error: "stream_not_found" });
    }

    const hostId = stream.host._id;
    
    // Kendini arayamaz
    if (String(hostId) === String(callerId)) {
      return res.status(400).json({ ok: false, error: "cannot_call_yourself" });
    }

    // Caller'ı kontrol et + Fiyat hesapla
    const pricePerMinute = stream.host.callPricePerMinute || 100; // Default: 100 coin/dk
    const parsedDuration = Number(duration) || 0;
    const flatEntryPrice = 899;
    const totalPrice = parsedDuration > 0 ? pricePerMinute * parsedDuration : flatEntryPrice;

    // Coin kontrolü + atomik düşürme (TOCTOU race condition önleme)
    const updatedCaller = await User.findOneAndUpdate(
      { _id: callerId, coins: { $gte: totalPrice } },
      { $inc: { coins: -totalPrice } },
      { new: true, select: "coins name username profileImage" }
    );
    if (!updatedCaller) {
      // Tekrar bak: kullanıcı var mı yoksa coin mi yetersiz?
      const callerCheck = await User.findById(callerId).select("coins").lean();
      if (!callerCheck) {
        return res.status(404).json({ ok: false, error: "caller_not_found" });
      }
      return res.status(400).json({ 
        ok: false, 
        error: "insufficient_coins",
        required: totalPrice,
        available: callerCheck.coins
      });
    }

    // Host'a coin ekle (%45) — zaten atomik
    const hostShare = Math.floor(totalPrice * 0.45);
    await User.findByIdAndUpdate(hostId, {
      $inc: { coins: hostShare, totalEarnings: hostShare }
    });

    // Talep ID oluştur
    const requestId = `call_request_${Date.now()}_${uuidv4().slice(0, 8)}`;

    // Call room oluştur ve token üret
    const callRoomName = `paid_call_${requestId}`;
    let callerToken, hostToken;
    try {
      // ✅ FIX: Both sides need canPublish:true for 1-on-1 video call
      callerToken = await generateHostToken(callerId, callRoomName);
      hostToken = await generateHostToken(hostId, callRoomName);
    } catch (tokenErr) {
      // 🛡️ Token üretilemezse coin'leri geri iade et
      console.error("❌ Token generation failed, rolling back coins:", tokenErr.message);
      await User.findByIdAndUpdate(callerId, { $inc: { coins: totalPrice } });
      await User.findByIdAndUpdate(hostId, { $inc: { coins: -hostShare, totalEarnings: -hostShare } });
      return res.status(500).json({ ok: false, error: "token_generation_failed" });
    }

    // Global state'e kaydet (gerçek uygulamada Redis kullanılmalı)
    if (!global.callRequests) global.callRequests = new Map();
    
    global.callRequests.set(requestId, {
      requestId,
      callerId,
      callerName: updatedCaller.name || updatedCaller.username,
      callerImage: updatedCaller.profileImage,
      hostId: String(hostId),
      roomId,
      duration: parsedDuration,
      pricePerMinute,
      totalPrice,
      status: 'accepted',
      callRoomName,
      createdAt: Date.now(),
      expiresAt: Date.now() + (2 * 60 * 60 * 1000) // 2 saat sonra temizlenebilir
    });

    // ✅ FIX: activeCalls'a da kaydet - mesajlaşma getCounterpartyForRoom bunu kullanıyor
    if (global.activeCalls) {
      global.activeCalls.set(callRoomName, {
        callerId: String(callerId),
        targetUserId: String(hostId),
        roomName: callRoomName,
        createdAt: Date.now()
      });
    }

    // Her iki tarafa da doğrudan başlatma bilgisini gönder
    if (global.io) {
      const callerSocketKey = String(callerId);
      if (global.userSockets?.has(callerSocketKey)) {
        global.userSockets.get(callerSocketKey).forEach(socketId => {
          global.io.to(socketId).emit('paid_call_accepted', {
            requestId,
            callRoomName,
            token: callerToken,
            livekitUrl: process.env.LIVEKIT_URL,
            duration: parsedDuration,
            hostName: stream.host?.name || stream.host?.username,
            directConnect: true
          });
        });
      }

      // ✅ FIX: Host'a 'paid_call_request' event'i gönder (mobil bu event'i dinliyor)
      const hostSocketKey = String(hostId);
      if (global.userSockets?.has(hostSocketKey)) {
        const hostPayload = {
          requestId,
          callerId: String(callerId),
          callerName: updatedCaller.name || updatedCaller.username,
          callerImage: updatedCaller.profileImage,
          duration: parsedDuration,
          totalPrice,
          pricePerMinute,
          callRoomName,
          token: hostToken,
          livekitUrl: process.env.LIVEKIT_URL,
          directConnect: true
        };

        global.userSockets.get(hostSocketKey).forEach(socketId => {
          // ✅ Host mobilde 'paid_call_request' dinliyor - bunu gönder
          global.io.to(socketId).emit('paid_call_request', hostPayload);
          // Geriye dönük uyumluluk
          global.io.to(socketId).emit('paid_call_direct_started', hostPayload);
          global.io.to(socketId).emit('paid_call_accepted', hostPayload);
        });
      }

      // Odaya host'un özel görüşmede olduğunu bildir
      global.io.to(roomId).emit('host_in_private_call', {
        hostId,
        duration: parsedDuration
      });
    }

    // ✅ Mission tracking for making calls
    try { await trackMissionProgress(callerId, 'make_call'); } catch (_) {}

    res.json({
      ok: true,
      requestId,
      callRoomName,
      token: callerToken,
      livekitUrl: process.env.LIVEKIT_URL,
      duration: parsedDuration,
      totalPrice,
      pricePerMinute,
      directConnect: true,
      message: "Özel görüşme başlatıldı"
    });
  } catch (err) {
    console.error("requestPaidCall error:", err);
    res.status(500).json({ ok: false, error: "request_failed" });
  }
};

/**
 * Yayıncı ücretli arama talebini kabul eder
 */
exports.acceptPaidCall = async (req, res) => {
  try {
    const { requestId } = req.body;
    const hostId = req.user.id;

    if (!requestId) {
      return res.status(400).json({ ok: false, error: "requestId required" });
    }

    // Talebi bul
    const request = global.callRequests?.get(requestId);
    if (!request) {
      return res.status(404).json({ ok: false, error: "request_not_found" });
    }

    // Sadece host kabul edebilir
    if (String(request.hostId) !== String(hostId)) {
      return res.status(403).json({ ok: false, error: "only_host_can_accept" });
    }

    // Süre dolmuş mu?
    if (Date.now() > request.expiresAt) {
      global.callRequests.delete(requestId);
      return res.status(400).json({ ok: false, error: "request_expired" });
    }

    // ✅ FIX: Coin zaten requestPaidCall'da peşin düşüldü, tekrar düşme!
    // (Double charge bug fix)

    // Call room oluştur
    const callRoomName = `paid_call_${requestId}`;
    
    // Token oluştur (hem caller hem host için)
    // ✅ FIX: Both sides need canPublish:true for 1-on-1 video call
    const callerToken = await generateHostToken(request.callerId, callRoomName);
    const hostToken = await generateHostToken(hostId, callRoomName);

    // Request durumunu güncelle
    request.status = 'accepted';
    request.callRoomName = callRoomName;
    global.callRequests.set(requestId, request);

    // Her iki tarafa da bildir
    if (global.io) {
      // Caller'a bildir
      const callerSocketKey = String(request.callerId);
      if (global.userSockets?.has(callerSocketKey)) {
        global.userSockets.get(callerSocketKey).forEach(socketId => {
          global.io.to(socketId).emit('paid_call_accepted', {
            requestId,
            callRoomName,
            token: callerToken,
            livekitUrl: process.env.LIVEKIT_URL,
            duration: request.duration,
            hostName: request.hostName
          });
        });
      }

      // Room'daki herkese bildir (yayın duraklatılabilir)
      global.io.to(request.roomId).emit('host_in_private_call', {
        hostId,
        duration: request.duration
      });
    }

    res.json({
      ok: true,
      callRoomName,
      token: hostToken,
      livekitUrl: process.env.LIVEKIT_URL,
      duration: request.duration,
      earnings: hostShare,
      message: "Arama başlatıldı"
    });
  } catch (err) {
    console.error("acceptPaidCall error:", err);
    res.status(500).json({ ok: false, error: "accept_failed" });
  }
};

/**
 * Yayıncı ücretli arama talebini reddeder
 */
exports.rejectPaidCall = async (req, res) => {
  try {
    const { requestId } = req.body;
    const hostId = req.user.id;

    if (!requestId) {
      return res.status(400).json({ ok: false, error: "requestId required" });
    }

    const request = global.callRequests?.get(requestId);
    if (!request) {
      return res.status(404).json({ ok: false, error: "request_not_found" });
    }

    if (String(request.hostId) !== String(hostId)) {
      return res.status(403).json({ ok: false, error: "only_host_can_reject" });
    }

    // Talebi sil
    global.callRequests.delete(requestId);

    // Caller'a bildir
    if (global.io) {
      const callerSocketKey = String(request.callerId);
      if (global.userSockets?.has(callerSocketKey)) {
        global.userSockets.get(callerSocketKey).forEach(socketId => {
          global.io.to(socketId).emit('paid_call_rejected', {
            requestId,
            message: "Yayıncı arama talebinizi reddetti"
          });
        });
      }
    }

    res.json({ ok: true, message: "Talep reddedildi" });
  } catch (err) {
    console.error("rejectPaidCall error:", err);
    res.status(500).json({ ok: false, error: "reject_failed" });
  }
};

/**
 * Ücretli aramayı sonlandır
 */
exports.endPaidCall = async (req, res) => {
  try {
    const { requestId } = req.body;
    const userId = req.user.id;

    const request = global.callRequests?.get(requestId);
    if (!request) {
      return res.status(404).json({ ok: false, error: "request_not_found" });
    }

    // Caller veya host sonlandırabilir
    if (String(request.callerId) !== String(userId) && String(request.hostId) !== String(userId)) {
      return res.status(403).json({ ok: false, error: "not_authorized" });
    }

    // Talebi sil
    global.callRequests.delete(requestId);

    // ✅ activeCalls'dan da temizle (mesajlaşma için eklenmişti)
    const callRoomName = request.callRoomName || `paid_call_${requestId}`;
    if (global.activeCalls) {
      global.activeCalls.delete(callRoomName);
    }

    // Her iki tarafa da bildir
    if (global.io) {
      [request.callerId, request.hostId].forEach(id => {
        const socketKey = String(id);
        if (global.userSockets?.has(socketKey)) {
          global.userSockets.get(socketKey).forEach(socketId => {
            global.io.to(socketId).emit('paid_call_ended', {
              requestId,
              endedBy: userId
            });
          });
        }
      });

      // Yayın odasına host'un döndüğünü bildir
      global.io.to(request.roomId).emit('host_returned_from_call', {
        hostId: request.hostId
      });
    }

    res.json({ ok: true, message: "Arama sonlandırıldı" });
  } catch (err) {
    console.error("endPaidCall error:", err);
    res.status(500).json({ ok: false, error: "end_failed" });
  }
};

/**
 * Yayıncının arama fiyatını getir
 */
exports.getHostCallPrice = async (req, res) => {
  try {
    const { hostId } = req.params;

    const host = await User.findById(hostId).select('callPricePerMinute username name');
    if (!host) {
      return res.status(404).json({ ok: false, error: "host_not_found" });
    }

    res.json({
      ok: true,
      hostId,
      hostName: host.name || host.username,
      pricePerMinute: host.callPricePerMinute || 100,
      currency: 'coins'
    });
  } catch (err) {
    console.error("getHostCallPrice error:", err);
    res.status(500).json({ ok: false, error: "fetch_failed" });
  }
};

/**
 * Yayıncı kendi arama fiyatını ayarlar
 */
exports.setCallPrice = async (req, res) => {
  try {
    const { pricePerMinute } = req.body;
    const userId = req.user.id;

    if (pricePerMinute === undefined || pricePerMinute < 0) {
      return res.status(400).json({ ok: false, error: "valid pricePerMinute required" });
    }

    // Max fiyat kontrolü
    const maxPrice = 1000;
    const finalPrice = Math.min(Math.max(0, pricePerMinute), maxPrice);

    await User.findByIdAndUpdate(userId, { callPricePerMinute: finalPrice });

    res.json({
      ok: true,
      pricePerMinute: finalPrice,
      message: "Arama fiyatı güncellendi"
    });
  } catch (err) {
    console.error("setCallPrice error:", err);
    res.status(500).json({ ok: false, error: "update_failed" });
  }
};
