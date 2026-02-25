/**
 * Private chat and in-call messaging socket event handlers.
 * Handles chat:send_message, chat:typing, chat:mark_read, call:message.
 */

const chatService = require('../services/chatService');
const translationService = require('../services/translationService');
const User = require('../models/User');
const Message = require('../models/Message');
const { emitToUserSockets, getCounterpartyForRoom } = require('./helpers');
const { logger } = require('../utils/logger');

/**
 * Register chat events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance
 */
function register(socket, io) {
  // Send private chat message
  socket.on('chat:send_message', async (data) => {
    const fromUserId = socket.data.userId;
    console.log(`📩 chat:send_message received - fromUserId: ${fromUserId}, to: ${data.to}, text: ${data.text?.substring(0, 20)}`);

    if (!fromUserId || !data.to) {
      console.log('⚠️ chat:send_message - missing userId or recipient');
      socket.emit('chat:error', {
        tempId: data.tempId,
        error: 'Missing userId or recipient',
      });
      return;
    }

    try {
      console.log(`📩 Calling chatService.sendMessage...`);
      const message = await chatService.sendMessage(fromUserId, data.to, {
        text: data.text,
        replyToId: data.replyToId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
      });

      console.log(`📩 Message saved with id: ${message._id}`);

      const messageData = {
        messageId: message._id.toString(),
        from: fromUserId,
        to: data.to,
        text: message.content,
        timestamp: message.createdAt,
        replyToId: data.replyToId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        isMe: false,
      };

      // Send to recipient
      emitToUserSockets(data.to, 'chat:new_message', messageData);

      // Confirm to sender
      socket.emit('chat:new_message', {
        ...messageData,
        isMe: true,
        tempId: data.tempId,
      });

      console.log(`💬 Chat message sent: ${fromUserId} -> ${data.to}`);
    } catch (error) {
      console.error('❌ chat:send_message error:', error.message);

      let errorMessage = 'Failed to send message';
      if (error.message === 'RATE_LIMIT_EXCEEDED') errorMessage = 'Too many messages. Please slow down.';
      if (error.message === 'USER_BLOCKED') errorMessage = 'user_blocked';

      socket.emit('chat:error', {
        tempId: data.tempId,
        error: errorMessage,
      });
    }
  });

  // Typing indicator
  socket.on('chat:typing', (data) => {
    const fromUserId = socket.data.userId;
    if (!fromUserId || !data.to) return;

    emitToUserSockets(data.to, 'chat:typing', {
      from: fromUserId,
      fromUserId,
      isTyping: data.isTyping || false,
    });
  });

  // Mark messages as read
  socket.on('chat:mark_read', (data) => {
    const userId = socket.data.userId;
    if (!userId || !data.from) return;

    emitToUserSockets(data.from, 'chat:messages_read', {
      by: userId,
      conversationWith: data.from,
    });
  });

  // In-call messaging with auto-translation
  socket.on('call:message', async ({ roomName, content, targetLanguage, tempId }) => {
    const senderId = socket.data.userId;
    if (!senderId || !roomName || !content) {
      console.log(`⚠️ call:message - missing required fields`);
      return;
    }

    console.log(`💬 call:message received sender=${senderId} room=${roomName} tempId=${tempId || '-'}`);

    try {
      if (String(content).length > 500) {
        socket.emit('call:message_error', { error: 'message_too_long', maxLength: 500, tempId });
        return;
      }

      const sender = await User.findById(senderId)
        .select('username name profileImage preferredLanguage')
        .lean();

      if (!sender) {
        socket.emit('call:message_error', { error: 'user_not_found', tempId });
        return;
      }

      const receiverId = getCounterpartyForRoom(roomName, senderId);
      if (!receiverId) {
        console.log(`⚠️ call:message - counterparty not found for room=${roomName} sender=${senderId}`);
        socket.emit('call:message_error', { error: 'call_not_found', tempId });
        return;
      }

      const receiver = await User.findById(receiverId).select('preferredLanguage').lean();

      const senderLang = sender.preferredLanguage || 'tr';
      const receiverLang = receiver?.preferredLanguage || targetLanguage || 'tr';

      let originalLanguage = senderLang;
      let translatedContent = String(content);
      const translations = {};

      if (senderLang !== receiverLang) {
        try {
          const translateResult = await translationService.translateText(
            String(content),
            receiverLang,
            'auto',
          );

          originalLanguage = translateResult.detectedLanguage || senderLang;
          translatedContent = translateResult.translatedText || String(content);

          translations[originalLanguage] = String(content);
          translations[receiverLang] = translatedContent;
        } catch (translateErr) {
          console.error('❌ Translation error:', translateErr.message);
          translatedContent = String(content);
        }
      }

      const message = await Message.create({
        roomId: roomName,
        from: senderId,
        to: receiverId,
        type: 'call_chat',
        content: String(content),
        originalContent: String(content),
        originalLanguage,
        translations,
      });

      const messagePayload = {
        _id: message._id.toString(),
        roomName,
        content: String(content),
        translatedContent,
        originalLanguage,
        targetLanguage: receiverLang,
        isTranslated: String(content) !== translatedContent,
        tempId,
        sender: {
          _id: String(senderId),
          username: sender.username,
          name: sender.name,
          profileImage: sender.profileImage,
        },
        timestamp: message.createdAt,
      };

      socket.emit('call:message_sent', {
        ...messagePayload,
        displayContent: String(content),
      });

      emitToUserSockets(receiverId, 'call:message_received', {
        ...messagePayload,
        displayContent: translatedContent,
      });

      console.log(`💬 Call message: ${senderId} -> ${receiverId} in ${roomName} (${originalLanguage} -> ${receiverLang})`);
    } catch (e) {
      console.error('❌ call:message error:', e.message);
      socket.emit('call:message_error', { error: 'send_failed', details: e.message, tempId });
    }
  });
}

module.exports = { register };
