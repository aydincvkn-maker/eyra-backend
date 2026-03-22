// src/controllers/postController.js
const Post = require("../models/Post");
const User = require("../models/User");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

// =============================================
// POST FEED - Keşfet akışı
// =============================================

// GET /api/posts - Feed getir (sayfalı)
exports.getFeed = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const posts = await Post.find({ isActive: true })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "username name profileImage level gender isOnline")
      .lean();

    const userId = req.user.id.toString();

    const result = posts.map((post) => ({
      _id: post._id,
      type: post.type,
      text: post.text,
      imageUrl: post.imageUrl,
      likeCount: post.likeCount,
      isLiked: (post.likes || []).some((id) => id.toString() === userId),
      createdAt: post.createdAt,
      user: post.user
        ? {
            _id: post.user._id,
            username: post.user.username,
            name: post.user.name,
            profileImage: post.user.profileImage,
            level: post.user.level,
            gender: post.user.gender,
            isOnline: post.user.isOnline,
          }
        : null,
    }));

    res.json({ success: true, posts: result, page, limit });
  } catch (err) {
    console.error("getFeed error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/posts/user/:userId - Kullanıcının postları
exports.getUserPosts = async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const posts = await Post.find({ user: userId, isActive: true })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "username name profileImage level gender isOnline")
      .lean();

    const currentUserId = req.user.id.toString();

    const result = posts.map((post) => ({
      _id: post._id,
      type: post.type,
      text: post.text,
      imageUrl: post.imageUrl,
      likeCount: post.likeCount,
      isLiked: (post.likes || []).some((id) => id.toString() === currentUserId),
      createdAt: post.createdAt,
      user: post.user
        ? {
            _id: post.user._id,
            username: post.user.username,
            name: post.user.name,
            profileImage: post.user.profileImage,
            level: post.user.level,
            gender: post.user.gender,
            isOnline: post.user.isOnline,
          }
        : null,
    }));

    res.json({ success: true, posts: result, page, limit });
  } catch (err) {
    console.error("getUserPosts error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/posts - Yeni post oluştur (fotoğraf + not)
exports.createPost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { text } = req.body;
    let imageUrl = "";
    let type = "note";

    // Fotoğraf yükleme
    if (req.file) {
      const ext = path.extname(req.file.originalname || ".jpg").toLowerCase();
      const filename = `post_${userId}_${Date.now()}${ext}`;
      const uploadDir = path.join(__dirname, "../../uploads/posts");

      await fsp.mkdir(uploadDir, { recursive: true });

      const filePath = path.join(uploadDir, filename);
      await fsp.writeFile(filePath, req.file.buffer);

      imageUrl = `/uploads/posts/${filename}`;
      type = text && text.trim() ? "photo_note" : "photo";
    } else if (text && text.trim()) {
      type = "note";
    } else {
      return res.status(400).json({ success: false, message: "Fotoğraf veya metin gerekli" });
    }

    const post = await Post.create({
      user: userId,
      type,
      text: (text || "").trim().slice(0, 500),
      imageUrl,
    });

    const populated = await Post.findById(post._id)
      .populate("user", "username name profileImage level gender isOnline")
      .lean();

    res.json({
      success: true,
      post: {
        _id: populated._id,
        type: populated.type,
        text: populated.text,
        imageUrl: populated.imageUrl,
        likeCount: 0,
        isLiked: false,
        createdAt: populated.createdAt,
        user: populated.user
          ? {
              _id: populated.user._id,
              username: populated.user.username,
              name: populated.user.name,
              profileImage: populated.user.profileImage,
              level: populated.user.level,
              gender: populated.user.gender,
              isOnline: populated.user.isOnline,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("createPost error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/posts/:postId/like - Beğen / Beğeniyi kaldır
exports.toggleLike = async (req, res) => {
  try {
    const userId = req.user.id;
    const { postId } = req.params;

    const post = await Post.findById(postId);
    if (!post || !post.isActive) {
      return res.status(404).json({ success: false, message: "Post bulunamadı" });
    }

    const alreadyLiked = post.likes.some((id) => id.toString() === userId.toString());

    if (alreadyLiked) {
      post.likes = post.likes.filter((id) => id.toString() !== userId.toString());
      post.likeCount = Math.max(0, post.likeCount - 1);
    } else {
      post.likes.push(userId);
      post.likeCount = post.likes.length;
    }

    await post.save();

    res.json({
      success: true,
      isLiked: !alreadyLiked,
      likeCount: post.likeCount,
    });
  } catch (err) {
    console.error("toggleLike error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/posts/:postId - Post sil (sadece sahibi)
exports.deletePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const { postId } = req.params;

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: "Post bulunamadı" });
    }

    if (post.user.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: "Bu işlem için yetkiniz yok" });
    }

    // Fotoğraf varsa sil
    if (post.imageUrl) {
      const filePath = path.join(__dirname, "../..", post.imageUrl);
      try {
        await fsp.unlink(filePath);
      } catch (_) {
        // Dosya zaten silinmiş olabilir
      }
    }

    await Post.findByIdAndDelete(postId);

    res.json({ success: true, message: "Post silindi" });
  } catch (err) {
    console.error("deletePost error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
