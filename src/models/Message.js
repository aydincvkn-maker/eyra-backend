// src/models/Message.js
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true }, // canlı oda ID veya chat room
    from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // private chat veya gift alıcısı
    type: { 
      type: String, 
      enum: ["text", "gift", "system", "emoji", "sticker", "image", "video", "audio", "file", "call_chat"], 
      default: "text" 
    },
    content: {
      type: String,
      default: "",
      required: function () {
        // Media messages may legitimately have empty content.
        return ["text", "gift", "system", "emoji", "sticker", "call_chat"].includes(this.type);
      },
      maxlength: 1000
    },

    // Call chat extras (optional)
    originalContent: { type: String },
    originalLanguage: { type: String },
    translations: { type: mongoose.Schema.Types.Mixed },
    
    // Moderasyon
    isDeleted: { type: Boolean, default: false },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    deletedAt: { type: Date },
    
    // Metadata (gift detayları vb.)
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Compound index for efficient chat queries
messageSchema.index({ roomId: 1, createdAt: -1 });
messageSchema.index({ from: 1, createdAt: -1 });

module.exports = mongoose.model("Message", messageSchema);
