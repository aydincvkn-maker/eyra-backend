const mongoose = require("mongoose");

const paymentEventSchema = new mongoose.Schema(
  {
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, index: true },
    provider: { type: String, enum: ["mock"], required: true, index: true },
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true },
    providerPaymentId: { type: String, default: null, index: true },
    isSignatureValid: { type: Boolean, default: false },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

paymentEventSchema.index({ payment: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentEvent", paymentEventSchema);
