const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    orderId: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, default: null, index: true },

    provider: { type: String, enum: ["mock"], default: "mock", index: true },
    method: { type: String, enum: ["card", "crypto"], required: true },

    productCode: { type: String, required: true },
    productType: { type: String, enum: ["coin_topup", "vip"], required: true },

    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true, default: "TRY" },

    providerPaymentId: { type: String, default: null, index: true },
    providerCheckoutUrl: { type: String, default: null },

    status: {
      type: String,
      enum: ["created", "pending", "paid", "failed", "refunded", "canceled"],
      default: "created",
      index: true,
    },

    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ user: 1, status: 1, createdAt: -1 });
paymentSchema.index({ idempotencyKey: 1, user: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Payment", paymentSchema);
