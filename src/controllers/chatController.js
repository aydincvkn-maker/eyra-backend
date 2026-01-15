// src/controllers/chatController.js
const Message = require("../models/Message");

exports.getRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(200);

    res.json(messages);
  } catch (err) {
    console.error("getRoomMessages error:", err);
    res.status(500).json({ message: "Sunucu hatası" });
  }
};
