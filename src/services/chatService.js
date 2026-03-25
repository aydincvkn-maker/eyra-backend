// src/services/chatService.js
const Message = require("../models/Message");
const User = require("../models/User");
const mongoose = require("mongoose");
const { logger } = require("../utils/logger");
const { getRedisClient } = require("../config/redis");
const { getChatRoomId } = require("../utils/chatUtils");
const { trackMissionProgress } = require("../controllers/missionController");

// ✅ Rate limiting map (Fallback if Redis is unavailable)
const messageRateLimits = new Map();
const MESSAGE_RATE_LIMIT = 20; // messages per minute
const RATE_LIMIT_WINDOW = 60; // seconds

const PAYMENT_REDIRECT_PATTERNS = [
  /https?:\/\/\S+/i,
  /www\./i,
  /\b(?:iban|papara|wise|paypal|payoneer|stripe|crypto|usdt|btc|eth|binance|trc20|erc20)\b/i,
  /\b(?:whatsapp|telegram|discord|t\.me|wa\.me|linktr\.ee|bio\.link)\b/i,
];

const PAYMENT_REDIRECT_CONTEXT_PATTERNS = [
  /\b(?:webden|siteden|siteye|tarayicidan|browserdan|disaridan|uygulama disindan|linkten)\b/i,
  /\b(?:web|site|link|tarayici|browser)\b/i,
];

const PAYMENT_ACTION_PATTERNS = [
  /\b(?:coin yukle|coin al|coin satin al|satin al|odeme yap|para gonder|gonder para|ucuz)\b/i,
  /\b(?:odeme|coin|bakiye|paket|yukleme|satinal|satinalma)\b/i,
];

/**
 * Check if user exceeded rate limit (Redis Supported)
 */
const checkRateLimit = async (userId) => {
  const redis = getRedisClient();
  
  if (redis) {
    const key = `ratelimit:chat:${userId}`;
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, RATE_LIMIT_WINDOW);
      }
      return current <= MESSAGE_RATE_LIMIT;
    } catch (err) {
      logger.warn('Redis rate limit error, falling back to memory:', err);
    }
  }

  // Fallback: In-memory implementation
  const now = Date.now();
  const userLimit = messageRateLimits.get(userId);
  
  if (!userLimit || now > userLimit.resetAt) {
    messageRateLimits.set(userId, { count: 1, resetAt: now + (RATE_LIMIT_WINDOW * 1000) });
    return true;
  }
  
  if (userLimit.count >= MESSAGE_RATE_LIMIT) {
    return false;
  }
  
  userLimit.count++;
  return true;
};

/**
 * Clean old rate limit entries (memory cleanup)
 */
setInterval(() => {
  const now = Date.now();
  for (const [userId, limit] of messageRateLimits.entries()) {
    if (now > limit.resetAt) {
      messageRateLimits.delete(userId);
    }
  }
}, 60000);

/**
 * Sanitize text content
 */
const sanitizeText = (text) => {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .substring(0, 1000);
};

const normalizeForModeration = (text) => {
  return String(text || '')
    .toLowerCase()
    .replace(/[çÇ]/g, 'c')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİ]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's')
    .replace(/[üÜ]/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
};

const containsPaymentRedirect = (text) => {
  const normalized = normalizeForModeration(text);
  if (!normalized) return false;

  const hasExplicitToken = PAYMENT_REDIRECT_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
  if (hasExplicitToken) return true;

  const hasRedirectContext = PAYMENT_REDIRECT_CONTEXT_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
  const hasPaymentContext = PAYMENT_ACTION_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );

  return hasRedirectContext && hasPaymentContext;
};

/**
 * Get conversation between two users
 */
exports.getConversation = async (userId, otherUserId, page = 0, limit = 50) => {
  try {
    limit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
    page = Math.max(0, Math.floor(Number(page) || 0));
    const roomId = getChatRoomId(userId, otherUserId);
    
    const messages = await Message.find({
      roomId,
      isDeleted: false,
      // ✅ Kullanıcının "benim için sil" yaptığı mesajları filtrele
      deletedFor: { $nin: [userId] },
      type: { $in: ['text', 'image', 'video', 'audio', 'file', 'emoji', 'sticker', 'call_chat'] }
    })
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .select('-__v')
      .lean();
    
    return messages.reverse();
  } catch (error) {
    logger.error('getConversation error:', error);
    throw error;
  }
};

/**
 * Delete all messages in a conversation for one user ("clear for me")
 */
exports.deleteConversation = async (userId, otherUserId) => {
  try {
    const roomId = getChatRoomId(userId, otherUserId);
    await Message.updateMany(
      { roomId, isDeleted: false },
      { $addToSet: { deletedFor: userId } }
    );
  } catch (error) {
    logger.error('deleteConversation error:', error);
    throw error;
  }
};

/**
 * Send a message
 */
exports.sendMessage = async (fromUserId, toUserId, data) => {
  try {
    console.log(`📨 chatService.sendMessage: from=${fromUserId}, to=${toUserId}`);
    
    // Rate limit check
    const isAllowed = await checkRateLimit(fromUserId);
    if (!isAllowed) {
      throw new Error('RATE_LIMIT_EXCEEDED');
    }
    
    // Validate text
    const text = sanitizeText(data.text || '');
    if (!text && !data.mediaUrl) {
      throw new Error('EMPTY_MESSAGE');
    }

    if (text && containsPaymentRedirect(text)) {
      throw new Error('PAYMENT_REDIRECT_BLOCKED');
    }

    // Block check (skip for admin messages)
    if (!data.isAdmin) {
      const fromUser = await User.findById(fromUserId).select('blockedUsers isBanned');
      const toUser = await User.findById(toUserId).select('blockedUsers isBanned');

      if (!fromUser || !toUser) {
        console.log(`❌ User not found: fromUser=${!!fromUser}, toUser=${!!toUser}`);
        throw new Error('USER_NOT_FOUND');
      }

      // ⛔ Banlı kullanıcıya mesaj gönderme
      if (toUser.isBanned) {
        throw new Error('USER_NOT_FOUND');
      }
      
      const fromBlocked = fromUser.blockedUsers?.some(id => id.toString() === toUserId);
      const toBlocked = toUser.blockedUsers?.some(id => id.toString() === fromUserId);

      if (fromBlocked || toBlocked) {
        throw new Error('USER_BLOCKED');
      }
    } else {
      // Admin: only verify target user exists
      const toUser = await User.findById(toUserId).select('_id');
      if (!toUser) {
        console.log(`❌ Target user not found: ${toUserId}`);
        throw new Error('USER_NOT_FOUND');
      }
    }
    
    // Create consistent roomId
    const roomId = getChatRoomId(fromUserId, toUserId);
    const clientTempId = String(data.clientTempId || '').trim();

    if (clientTempId) {
      const existingMessage = await Message.findOne({
        roomId,
        from: fromUserId,
        to: toUserId,
        isDeleted: false,
        'metadata.clientTempId': clientTempId,
      });

      if (existingMessage) {
        await existingMessage.populate('from', 'username name profileImage');
        return existingMessage;
      }
    }
    
    // Determine message type
    let messageType = 'text';
    if (data.mediaType === 'image') messageType = 'image';
    else if (data.mediaType === 'video') messageType = 'video';
    else if (data.mediaType === 'audio') messageType = 'audio';
    else if (data.mediaType === 'file') messageType = 'file';
    
    // Create message
    const message = new Message({
      roomId,
      from: fromUserId,
      to: toUserId,
      type: messageType,
      content: text,
      metadata: {
        clientTempId,
        replyToId: data.replyToId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        durationSec: data.durationSec || undefined,
        isForwarded: data.isForwarded || false,
      }
    });
    
    await message.save();
    console.log(`✅ Message saved: ${message._id}`);
    
    // ✅ Mission tracking for sending messages
    try { await trackMissionProgress(fromUserId, 'send_message'); } catch (_) {}
    
    // Populate sender info
    await message.populate('from', 'username name profileImage');
    
    return message;
  } catch (error) {
    logger.error('sendMessage error:', error);
    throw error;
  }
};

/**
 * Delete a message
 */
exports.deleteMessage = async (messageId, userId) => {
  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      throw new Error('MESSAGE_NOT_FOUND');
    }
    
    if (message.from.toString() !== userId) {
      throw new Error('UNAUTHORIZED');
    }
    
    message.isDeleted = true;
    message.deletedBy = userId;
    message.deletedAt = new Date();
    await message.save();
    
    return message;
  } catch (error) {
    logger.error('deleteMessage error:', error);
    throw error;
  }
};

/**
 * Edit a message
 */
exports.editMessage = async (messageId, userId, newText) => {
  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      throw new Error('MESSAGE_NOT_FOUND');
    }
    
    if (message.from.toString() !== userId) {
      throw new Error('UNAUTHORIZED');
    }

    const sanitizedText = sanitizeText(newText);
    if (sanitizedText && containsPaymentRedirect(sanitizedText)) {
      throw new Error('PAYMENT_REDIRECT_BLOCKED');
    }

    message.content = sanitizedText;
    message.metadata = message.metadata || {};
    message.metadata.isEdited = true;
    message.metadata.editedAt = new Date();
    await message.save();
    
    return message;
  } catch (error) {
    logger.error('editMessage error:', error);
    throw error;
  }
};

/**
 * Get chat users (users who have conversations with the current user)
 */
exports.getChatUsers = async (userId) => {
  try {
    // Find all unique users the current user has chatted with
    const sentMessages = await Message.distinct('to', { 
      from: userId,
      isDeleted: false 
    });
    
    const receivedMessages = await Message.distinct('from', { 
      to: userId,
      isDeleted: false 
    });
    
    const userIds = [...new Set([...sentMessages, ...receivedMessages])];
    
    const users = await User.find({ _id: { $in: userIds } })
      .select('username name profileImage isOnline lastSeen gender')
      .lean();
    
    // Get last message and unread count for each user
    const usersWithInfo = await Promise.all(users.map(async (user) => {
      const roomId = getChatRoomId(userId, user._id.toString());
      
      const lastMessage = await Message.findOne({ 
        roomId,
        isDeleted: false 
      })
        .sort({ createdAt: -1 })
        .select('content createdAt from')
        .lean();
      
      const unreadCount = await Message.countDocuments({
        roomId,
        from: user._id,
        to: userId,
        isDeleted: false,
        'metadata.readAt': { $exists: false }
      });
      
      return {
        ...user,
        lastMessage: lastMessage?.content || '',
        lastMessageTime: lastMessage?.createdAt || null,
        unreadCount
      };
    }));
    
    // Sort by last message time
    usersWithInfo.sort((a, b) => {
      if (!a.lastMessageTime) return 1;
      if (!b.lastMessageTime) return -1;
      return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
    });
    
    return usersWithInfo;
  } catch (error) {
    logger.error('getChatUsers error:', error);
    throw error;
  }
};

/**
 * Mark messages as read
 */
exports.markAsRead = async (userId, otherUserId) => {
  try {
    const roomId = getChatRoomId(userId, otherUserId);
    
    await Message.updateMany(
      {
        roomId,
        from: otherUserId,
        to: userId,
        'metadata.readAt': { $exists: false }
      },
      {
        $set: { 'metadata.readAt': new Date() }
      }
    );
    
    return true;
  } catch (error) {
    logger.error('markAsRead error:', error);
    throw error;
  }
};

/**
 * Add reaction to message
 */
exports.addReaction = async (messageId, userId, emoji) => {
  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      throw new Error('MESSAGE_NOT_FOUND');
    }
    
    message.metadata = message.metadata || {};
    message.metadata.reactions = message.metadata.reactions || {};
    message.metadata.reactions[userId] = emoji;
    await message.save();
    
    return message;
  } catch (error) {
    logger.error('addReaction error:', error);
    throw error;
  }
};

/**
 * Remove reaction from message
 */
exports.removeReaction = async (messageId, userId) => {
  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      throw new Error('MESSAGE_NOT_FOUND');
    }
    
    if (message.metadata?.reactions?.[userId]) {
      delete message.metadata.reactions[userId];
      await message.save();
    }
    
    return message;
  } catch (error) {
    logger.error('removeReaction error:', error);
    throw error;
  }
};
