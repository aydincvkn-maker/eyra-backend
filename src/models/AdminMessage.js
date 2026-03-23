// src/models/AdminMessage.js
const mongoose = require("mongoose");

const adminMessageSchema = new mongoose.Schema(
  {
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderName: { type: String, required: true },
    senderRole: { type: String, required: true },
    content: { type: String, default: "", maxlength: 2000 },
    attachment: {
      url: { type: String },
      type: {
        type: String,
        enum: ["image", "video", "audio", "file"],
      },
      fileName: { type: String },
      fileSize: { type: Number },
      mimeType: { type: String },
    },
    threadType: {
      type: String,
      enum: ["group", "direct"],
      default: function () {
        return this.recipientId ? "direct" : "group";
      },
    },
    // Boş = genel grup chat, dolu = özel mesaj
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

adminMessageSchema.index({ createdAt: -1 });
adminMessageSchema.index({ threadType: 1, recipientId: 1, createdAt: -1 });
adminMessageSchema.index({ deletedFor: 1, createdAt: -1 });

module.exports = mongoose.model("AdminMessage", adminMessageSchema);
