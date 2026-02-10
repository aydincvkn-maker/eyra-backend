const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    target: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    stream: { type: mongoose.Schema.Types.ObjectId, ref: "LiveStream", required: false },
    roomId: { type: String, index: true },
    reason: { type: String, default: "" },
    status: {
      type: String,
      enum: ["open", "reviewing", "resolved"],
      default: "open",
      index: true,
    },
  },
  { timestamps: true }
);

reportSchema.index({ reporter: 1, target: 1, createdAt: -1 });

module.exports = mongoose.model("Report", reportSchema);
