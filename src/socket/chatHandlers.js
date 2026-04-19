/**
 * Private chat and in-call messaging socket event handlers.
 * Handles chat:send_message, chat:typing, chat:mark_read, call:message.
 */

const chatService = require("../services/chatService");
const translationService = require("../services/translationService");
const User = require("../models/User");
const Message = require("../models/Message");
const { emitToUserSockets, getCounterpartyForRoom } = require("./helpers");
const { logger } = require("../utils/logger");
const { createNotification } = require("../controllers/notificationController");
const { sanitizeSocketPayload } = require("../middleware/validate");
const {
  containsPaymentRedirect,
} = require("../utils/paymentRedirectModeration");
const {
  recordPaymentRedirectAttempt,
} = require("../services/moderationAuditService");

/**
 * Register chat events on a connected socket.
 * @param {Socket} socket - The connected Socket.io socket
 * @param {Server} io     - The Socket.io server instance
 */
function register(socket, io) {
  // Send private chat message
  socket.on("chat:send_message", async (rawData) => {
    const data = sanitizeSocketPayload(rawData);
    const fromUserId = socket.data.userId;
    logger.debug("chat:send_message received", { fromUserId, to: data.to });

    if (!fromUserId || !data.to || typeof data.to !== "string") {
      logger.debug("chat:send_message - missing userId or recipient");
      socket.emit("chat:error", {
        tempId: data.tempId,
        error: "Missing userId or recipient",
      });
      return;
    }

    try {
      logger.debug("Calling chatService.sendMessage...");
      const message = await chatService.sendMessage(fromUserId, data.to, {
        text: data.text,
        clientTempId: data.tempId,
        replyToId: data.replyToId,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
        durationSec: data.durationSec,
      });

      logger.debug("Message saved", { messageId: message._id });

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
      const delivered = emitToUserSockets(
        data.to,
        "chat:new_message",
        messageData,
      );

      // ✅ FIX: Always send push notification for chat messages.
      // Even if socket delivery succeeded, the recipient's app may be
      // backgrounded or ChatService listeners may be dead after reconnect.
      try {
        const sender = await User.findById(fromUserId)
          .select("username name")
          .lean();
        const senderName = sender?.name || sender?.username || "Birisi";
        const previewText =
          (message.content || "").length > 80
            ? message.content.substring(0, 80) + "..."
            : message.content || "Yeni mesaj";

        await createNotification({
          recipientId: data.to,
          type: "chat_message",
          title: senderName,
          body: previewText,
          senderId: fromUserId,
          relatedId: message._id.toString(),
          relatedType: "Message",
        });
      } catch (pushErr) {
        logger.error("Chat push notification error", pushErr);
      }

      // Confirm to sender
      socket.emit("chat:new_message", {
        ...messageData,
        isMe: true,
        tempId: data.tempId,
      });

      logger.debug("Chat message sent", { from: fromUserId, to: data.to });
    } catch (error) {
      logger.error("chat:send_message error", { err: error.message });

      let errorMessage = "Failed to send message";
      if (error.message === "RATE_LIMIT_EXCEEDED")
        errorMessage = "Too many messages. Please slow down.";
      if (error.message === "USER_BLOCKED") errorMessage = "user_blocked";
      if (error.message === "PAYMENT_REDIRECT_BLOCKED")
        errorMessage = "payment_redirect_blocked";

      socket.emit("chat:error", {
        tempId: data.tempId,
        error: errorMessage,
      });
    }
  });

  // Typing indicator
  socket.on("chat:typing", (rawData) => {
    const data = sanitizeSocketPayload(rawData);
    const fromUserId = socket.data.userId;
    if (!fromUserId || !data.to || typeof data.to !== "string") return;

    emitToUserSockets(data.to, "chat:typing", {
      from: fromUserId,
      fromUserId,
      isTyping: data.isTyping || false,
    });
  });

  // Mark messages as read
  socket.on("chat:mark_read", (rawData) => {
    const data = sanitizeSocketPayload(rawData);
    const userId = socket.data.userId;
    if (!userId || !data.from || typeof data.from !== "string") return;

    emitToUserSockets(data.from, "chat:messages_read", {
      by: userId,
      conversationWith: data.from,
    });
  });

  // In-call messaging with auto-translation
  socket.on("call:message", async (rawData) => {
    const { roomName, content, targetLanguage, tempId } =
      sanitizeSocketPayload(rawData);
    const senderId = socket.data.userId;
    if (!senderId || !roomName || typeof roomName !== "string" || !content) {
      logger.debug("call:message - missing required fields");
      return;
    }

    logger.debug("call:message received", { senderId, roomName });

    try {
      if (String(content).length > 500) {
        socket.emit("call:message_error", {
          error: "message_too_long",
          maxLength: 500,
          tempId,
        });
        return;
      }

      if (containsPaymentRedirect(String(content))) {
        const receiverId = getCounterpartyForRoom(roomName, senderId);
        await recordPaymentRedirectAttempt({
          source: "call_chat",
          actorUserId: senderId,
          targetUserId: receiverId || null,
          roomId: roomName,
          content: String(content),
        });
        socket.emit("call:message_error", {
          error: "payment_redirect_blocked",
          tempId,
        });
        return;
      }

      const sender = await User.findById(senderId)
        .select("username name profileImage preferredLanguage")
        .lean();

      if (!sender) {
        socket.emit("call:message_error", {
          error: "user_not_found",
          tempId,
        });
        return;
      }

      const receiverId = getCounterpartyForRoom(roomName, senderId);
      if (!receiverId) {
        logger.debug("call:message - counterparty not found", {
          roomName,
          senderId,
        });
        socket.emit("call:message_error", {
          error: "call_not_found",
          tempId,
        });
        return;
      }

      const receiver = await User.findById(receiverId)
        .select("preferredLanguage")
        .lean();

      const senderLang = sender.preferredLanguage || "tr";
      const receiverLang =
        receiver?.preferredLanguage || targetLanguage || "tr";

      let originalLanguage = senderLang;
      let translatedContent = String(content);
      const translations = {};

      if (senderLang !== receiverLang) {
        try {
          const translateResult = await translationService.translateText(
            String(content),
            receiverLang,
            "auto",
          );

          originalLanguage = translateResult.detectedLanguage || senderLang;
          translatedContent = translateResult.translatedText || String(content);

          translations[originalLanguage] = String(content);
          translations[receiverLang] = translatedContent;
        } catch (translateErr) {
          logger.error("Translation error", { err: translateErr.message });
          translatedContent = String(content);
        }
      }

      const message = await Message.create({
        roomId: roomName,
        from: senderId,
        to: receiverId,
        type: "call_chat",
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

      socket.emit("call:message_sent", {
        ...messagePayload,
        displayContent: String(content),
      });

      emitToUserSockets(receiverId, "call:message_received", {
        ...messagePayload,
        displayContent: translatedContent,
      });

      logger.debug("Call message sent", {
        from: senderId,
        to: receiverId,
        roomName,
      });
    } catch (e) {
      logger.error("call:message error", { err: e.message });
      socket.emit("call:message_error", {
        error: "send_failed",
        details: e.message,
        tempId,
      });
    }
  });
}

module.exports = { register };
