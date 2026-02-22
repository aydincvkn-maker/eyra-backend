// src/controllers/supportController.js
const SupportTicket = require("../models/SupportTicket");
const User = require("../models/User");

// =============================================
// KULLANICI ENDPOINT'LERİ
// =============================================

// POST /api/support - Yeni destek talebi oluştur (kullanıcı)
exports.createTicket = async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ success: false, message: "Konu ve mesaj gerekli" });
    }

    const ticket = await SupportTicket.create({
      user: req.user.id,
      subject: subject.trim(),
      message: message.trim(),
    });

    res.status(201).json({ success: true, ticket });
  } catch (err) {
    console.error("createTicket error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/support/my - Kendi destek taleplerini getir (kullanıcı)
exports.getMyTickets = async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ user: req.user.id })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ success: true, tickets });
  } catch (err) {
    console.error("getMyTickets error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/support/:ticketId/reply - Kullanıcı yanıt (kendi ticket'ına)
exports.userReply = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: "Mesaj boş olamaz" });
    }

    const ticket = await SupportTicket.findById(ticketId);
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Talep bulunamadı" });
    }

    // Sadece kendi ticket'ına yanıt verebilir
    if (String(ticket.user) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Yetkiniz yok" });
    }

    if (ticket.status === "closed") {
      return res.status(400).json({ success: false, message: "Bu talep kapatılmış" });
    }

    ticket.replies.push({
      from: req.user.id,
      fromRole: "user",
      content: content.trim(),
    });
    ticket.status = "open";
    await ticket.save();

    res.json({ success: true, ticket });
  } catch (err) {
    console.error("userReply error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ADMIN ENDPOINT'LERİ
// =============================================

// GET /api/support/admin - Tüm destek taleplerini listele (admin)
exports.getAdminTickets = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50"), 1), 200);
    const status = req.query.status; // open, replied, closed

    const query = {};
    if (status && ["open", "replied", "closed"].includes(status)) {
      query.status = status;
    }

    const total = await SupportTicket.countDocuments(query);

    const tickets = await SupportTicket.find(query)
      .populate("user", "username name email profileImage")
      .populate("replies.from", "username name role")
      .populate("assignedTo", "username name")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      tickets,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getAdminTickets error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/support/admin/:ticketId - Tek bir talebi getir (admin)
exports.getTicketById = async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.ticketId)
      .populate("user", "username name email profileImage coins level country")
      .populate("replies.from", "username name role")
      .lean();

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Talep bulunamadı" });
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error("getTicketById error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/support/admin/:ticketId/reply - Admin yanıt
exports.adminReply = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: "Mesaj boş olamaz" });
    }

    const ticket = await SupportTicket.findById(ticketId);
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Talep bulunamadı" });
    }

    ticket.replies.push({
      from: req.user.id,
      fromRole: "admin",
      content: content.trim(),
    });
    ticket.status = "replied";
    ticket.assignedTo = req.user.id;
    await ticket.save();

    const updated = await SupportTicket.findById(ticketId)
      .populate("user", "username name email profileImage")
      .populate("replies.from", "username name role")
      .lean();

    console.log(`💬 Admin ${req.user.username || req.user.id} destek talebine yanıt verdi: ${ticketId}`);

    res.json({ success: true, ticket: updated });
  } catch (err) {
    console.error("adminReply error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/support/admin/send-to-user - Admin kullaniciya mesaj gonder (ticket uzerinden)
exports.adminSendToUser = async (req, res) => {
  try {
    const { userId, text } = req.body;

    if (!userId || !text || !text.trim()) {
      return res.status(400).json({ success: false, message: "userId ve text gerekli" });
    }

    // Kullanicinin var olan acik/yanıtlanmis ticketini bul
    let ticket = await SupportTicket.findOne({
      user: userId,
      status: { $in: ["open", "replied"] },
    }).sort({ updatedAt: -1 });

    if (!ticket) {
      // Yoksa yeni ticket olustur (admin baslatmis)
      ticket = await SupportTicket.create({
        user: userId,
        subject: "Eyra Destek",
        message: "",
        initiatedByAdmin: true,
        status: "replied",
      });
    }

    ticket.replies.push({
      from: req.user.id,
      fromRole: "admin",
      content: text.trim(),
    });
    ticket.status = "replied";
    ticket.assignedTo = req.user.id;
    await ticket.save();

    console.log(`💬 Admin ${req.user.username || req.user.id} kullaniciya mesaj gonderdi: ${userId}`);
    res.json({ success: true, ticketId: ticket._id });
  } catch (err) {
    console.error("adminSendToUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatasi" });
  }
};

// PATCH /api/support/admin/:ticketId/status - Durum güncelle (admin)
exports.updateTicketStatus = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status } = req.body;

    if (!["open", "replied", "closed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Geçersiz durum" });
    }

    const updateData = { status };
    if (status === "closed") {
      updateData.closedBy = req.user.id;
      updateData.closedAt = new Date();
    }

    const ticket = await SupportTicket.findByIdAndUpdate(ticketId, updateData, { new: true })
      .populate("user", "username name email profileImage")
      .populate("replies.from", "username name role")
      .lean();

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Talep bulunamadı" });
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error("updateTicketStatus error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/support/admin/:ticketId - Talebi sil (admin)
exports.deleteTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findByIdAndDelete(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ success: false, message: "Talep bulunamadı" });
    }

    res.json({ success: true, message: "Talep silindi" });
  } catch (err) {
    console.error("deleteTicket error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
