// src/models/SupportTicket.js
const mongoose = require("mongoose");

const supportReplySchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  fromRole: { type: String, enum: ["user", "admin"], default: "user" },
  content: { type: String, required: true, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
});

const supportTicketSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, maxlength: 200 },
    // message is optional for admin-initiated tickets (admin starts the conversation)
    message: { type: String, default: "", maxlength: 5000 },
    initiatedByAdmin: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["open", "replied", "closed"],
      default: "open",
      index: true,
    },
    replies: [supportReplySchema],
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    closedAt: { type: Date },
    // Soft delete: admin panelden silindi, kullanıcı hâlâ görebilir
    deletedByAdmin: { type: Boolean, default: false },
    deletedByAdminAt: { type: Date },
  },
  { timestamps: true }
);

supportTicketSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
