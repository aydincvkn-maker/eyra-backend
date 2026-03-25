const mongoose = require("mongoose");

const moderationIncidentSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["payment_redirect"],
      required: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      index: true,
    },
    actorUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    targetUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    roomId: {
      type: String,
      default: null,
      index: true,
    },
    contentPreview: {
      type: String,
      required: true,
      maxlength: 280,
    },
    normalizedContent: {
      type: String,
      required: true,
      maxlength: 280,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

moderationIncidentSchema.index({ kind: 1, createdAt: -1 });
moderationIncidentSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model("ModerationIncident", moderationIncidentSchema);
