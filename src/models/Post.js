// src/models/Post.js
const mongoose = require("mongoose");

const postSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    
    // İçerik
    type: { type: String, enum: ["photo", "note", "photo_note"], default: "note" },
    text: { type: String, maxlength: 500, default: "" },
    imageUrl: { type: String, default: "" },
    
    // Etkileşim
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    likeCount: { type: Number, default: 0 },
    
    // Durum
    isActive: { type: Boolean, default: true },
    isReported: { type: Boolean, default: false },
  },
  { timestamps: true }
);

postSchema.index({ createdAt: -1 });
postSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Post", postSchema);
