// src/models/Verification.js
const mongoose = require("mongoose");

const verificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    
    // Doğrulama fotoğrafı
    selfieUrl: { type: String, required: true },
    
    // Durum
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    
    // Admin review
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    
    // Notlar
    adminNotes: { type: String },
  },
  { timestamps: true }
);

verificationSchema.index({ status: 1, createdAt: -1 });
verificationSchema.index({ user: 1 });

module.exports = mongoose.model("Verification", verificationSchema);
