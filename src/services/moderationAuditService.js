const ModerationIncident = require("../models/ModerationIncident");
const { logger } = require("../utils/logger");
const { normalizeForModeration } = require("../utils/paymentRedirectModeration");

const clampPreview = (text) => String(text || "").trim().slice(0, 280);

const recordPaymentRedirectAttempt = async ({
  source,
  actorUserId = null,
  targetUserId = null,
  roomId = null,
  content,
  metadata = {},
}) => {
  try {
    await ModerationIncident.create({
      kind: "payment_redirect",
      source: String(source || "unknown").trim(),
      actorUser: actorUserId || null,
      targetUser: targetUserId || null,
      roomId: roomId ? String(roomId).trim() : null,
      contentPreview: clampPreview(content),
      normalizedContent: clampPreview(normalizeForModeration(content)),
      metadata,
    });
  } catch (error) {
    logger.warn("Failed to persist moderation incident", {
      source,
      actorUserId,
      targetUserId,
      roomId,
      err: error.message,
    });
  }
};

module.exports = {
  recordPaymentRedirectAttempt,
};