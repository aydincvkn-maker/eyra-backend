// src/controllers/blockController.js
const User = require("../models/User");
const mongoose = require("mongoose");

// POST /api/users/:userId/block - Kullanıcı engelle
exports.blockUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res.status(400).json({ success: false, message: "Kendinizi engelleyemezsiniz" });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    // Zaten engelli mi kontrol et
    const currentUser = await User.findById(currentUserId);
    if (currentUser.blockedUsers?.includes(userId)) {
      return res.json({ success: true, message: "Zaten engellenmiş", isBlocked: true });
    }

    await User.findByIdAndUpdate(currentUserId, {
      $addToSet: { blockedUsers: userId },
    });

    res.json({ success: true, message: "Kullanıcı engellendi", isBlocked: true });
  } catch (err) {
    console.error("blockUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/users/:userId/block - Engel kaldır
exports.unblockUser = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    await User.findByIdAndUpdate(currentUserId, {
      $pull: { blockedUsers: userId },
    });

    res.json({ success: true, message: "Engel kaldırıldı", isBlocked: false });
  } catch (err) {
    console.error("unblockUser error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/me/blocked - Engellenen kullanıcı listesi
exports.getBlockedUsers = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const user = await User.findById(currentUserId)
      .populate("blockedUsers", "_id username name profileImage gender age level");

    const blockedUsers = (user.blockedUsers || []).map((u) => ({
      _id: u._id,
      username: u.username,
      name: u.name || u.username,
      profileImage: u.profileImage || "",
      gender: u.gender,
      age: u.age,
      level: u.level || 1,
    }));

    res.json({ success: true, blockedUsers, count: blockedUsers.length });
  } catch (err) {
    console.error("getBlockedUsers error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/users/:userId/is-blocked - Engel durumu kontrol
exports.isBlocked = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const { userId } = req.params;

    const user = await User.findById(currentUserId).select("blockedUsers");
    const isBlocked = user?.blockedUsers?.includes(userId) || false;

    // Karşı taraf bizi engellemiş mi?
    const targetUser = await User.findById(userId).select("blockedUsers");
    const isBlockedBy = targetUser?.blockedUsers?.includes(currentUserId) || false;

    res.json({ success: true, isBlocked, isBlockedBy });
  } catch (err) {
    console.error("isBlocked error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
