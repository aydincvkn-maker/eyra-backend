// src/models/Visitor.js
const mongoose = require("mongoose");

const visitorSchema = new mongoose.Schema(
  {
    // Profili ziyaret edilen kullanıcı
    profileOwner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Ziyaretçi
    visitor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Son ziyaret zamanı (aynı kişi tekrar ziyaret ederse güncellenir)
    lastVisitAt: { type: Date, default: Date.now },
    visitCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// Her (profileOwner, visitor) çifti unique
visitorSchema.index({ profileOwner: 1, visitor: 1 }, { unique: true });
visitorSchema.index({ profileOwner: 1, lastVisitAt: -1 });

module.exports = mongoose.model("Visitor", visitorSchema);
