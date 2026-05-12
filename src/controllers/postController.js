// src/controllers/postController.js
const Post = require("../models/Post");
const User = require("../models/User");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const storageService = require("../services/storageService");
const { logger } = require("../utils/logger");
const { normalizeGender } = require("../utils/gender");

const PHOTO_POST_TTL_MS = 24 * 60 * 60 * 1000;

const buildActivePostQuery = (extra = {}) => ({
  ...extra,
  isActive: true,
  $or: [
    { expiresAt: { $exists: false } },
    { expiresAt: null },
    { expiresAt: { $gt: new Date() } },
  ],
});

const serializePost = (post, currentUserId) => {
  const postUser =
    post.user && typeof post.user === "object" ? post.user : null;
  const postUserId = postUser?._id || post.user;

  return {
    _id: post._id,
    type: post.type,
    text: post.text,
    imageUrl: post.imageUrl,
    likeCount: post.likeCount,
    isLiked: (post.likes || []).some((id) => id.toString() === currentUserId),
    createdAt: post.createdAt,
    expiresAt: post.expiresAt || null,
    canDelete:
      Boolean(currentUserId) &&
      Boolean(postUserId) &&
      postUserId.toString() === currentUserId.toString(),
    user: postUser
      ? {
          _id: postUser._id,
          username: postUser.username,
          name: postUser.name,
          profileImage: postUser.profileImage,
          level: postUser.level,
          gender: postUser.gender,
          isOnline: postUser.isOnline,
        }
      : null,
  };
};

const removePostAsset = async (post) => {
  const imageUrl = String(post?.imageUrl || "").trim();
  if (!imageUrl) return;

  const publicId = storageService.extractPublicId(imageUrl);
  if (publicId) {
    await storageService.destroy(publicId, "image");
    return;
  }

  if (!imageUrl.startsWith("/")) {
    return;
  }

  const filePath = path.join(__dirname, "../..", imageUrl);
  try {
    await fsp.unlink(filePath);
  } catch (_) {
    // Dosya zaten silinmiş olabilir
  }
};

let _purgeExpiredPostsPromise = null;
const purgeExpiredPosts = async () => {
  if (_purgeExpiredPostsPromise) {
    return _purgeExpiredPostsPromise;
  }

  _purgeExpiredPostsPromise = (async () => {
    const expiredPosts = await Post.find({ expiresAt: { $lte: new Date() } })
      .select("_id imageUrl")
      .lean();

    if (expiredPosts.length === 0) {
      return 0;
    }

    await Promise.all(expiredPosts.map((post) => removePostAsset(post)));
    await Post.deleteMany({
      _id: { $in: expiredPosts.map((post) => post._id) },
    });

    return expiredPosts.length;
  })().finally(() => {
    _purgeExpiredPostsPromise = null;
  });

  return _purgeExpiredPostsPromise;
};

// =============================================
// POST FEED - Keşfet akışı
// =============================================

// GET /api/posts - Feed getir (sayfalı)
exports.getFeed = async (req, res) => {
  try {
    await purgeExpiredPosts();

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const posts = await Post.find(buildActivePostQuery())
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "username name profileImage level gender isOnline")
      .lean();

    const userId = req.user.id.toString();

    const result = posts.map((post) => serializePost(post, userId));

    res.json({ success: true, posts: result, page, limit });
  } catch (err) {
    logger.error("getFeed error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/posts/user/:userId - Kullanıcının postları
exports.getUserPosts = async (req, res) => {
  try {
    await purgeExpiredPosts();

    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const posts = await Post.find(buildActivePostQuery({ user: userId }))
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "username name profileImage level gender isOnline")
      .lean();

    const currentUserId = req.user.id.toString();

    const result = posts.map((post) => serializePost(post, currentUserId));

    res.json({ success: true, posts: result, page, limit });
  } catch (err) {
    logger.error("getUserPosts error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/posts - Yeni post oluştur (fotoğraf + not)
exports.createPost = async (req, res) => {
  try {
    await purgeExpiredPosts();

    const userId = req.user.id;
    const { text } = req.body;
    let imageUrl = "";
    let type = "note";

    const user = await User.findById(userId).select(
      "username name profileImage level gender isOnline",
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Kullanıcı bulunamadı" });
    }

    if (normalizeGender(user.gender) !== "female") {
      return res.status(403).json({
        success: false,
        message: "Keşfet paylaşımı sadece kadın kullanıcılar için açık",
      });
    }

    // Fotoğraf yükleme
    if (req.file) {
      const uploaded = await storageService.uploadBuffer(req.file.buffer, {
        folder: "posts",
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
        publicId: `post_${userId}_${Date.now()}`,
      });
      imageUrl = uploaded.url;
      type = text && text.trim() ? "photo_note" : "photo";
    } else if (text && text.trim()) {
      type = "note";
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Fotoğraf veya metin gerekli" });
    }

    const post = await Post.create({
      user: userId,
      type,
      text: (text || "").trim().slice(0, 500),
      imageUrl,
      expiresAt: req.file ? new Date(Date.now() + PHOTO_POST_TTL_MS) : null,
    });

    const populated = await Post.findById(post._id)
      .populate("user", "username name profileImage level gender isOnline")
      .lean();

    res.json({
      success: true,
      post: serializePost(populated, userId),
    });
  } catch (err) {
    logger.error("createPost error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// POST /api/posts/:postId/like - Beğen / Beğeniyi kaldır
exports.toggleLike = async (req, res) => {
  try {
    await purgeExpiredPosts();

    const userId = req.user.id;
    const { postId } = req.params;

    const post = await Post.findById(postId);
    if (
      !post ||
      !post.isActive ||
      (post.expiresAt instanceof Date && post.expiresAt <= new Date())
    ) {
      if (post) {
        await removePostAsset(post);
        await Post.findByIdAndDelete(postId);
      }
      return res
        .status(404)
        .json({ success: false, message: "Post bulunamadı" });
    }

    const alreadyLiked = post.likes.some(
      (id) => id.toString() === userId.toString(),
    );

    if (alreadyLiked) {
      post.likes = post.likes.filter(
        (id) => id.toString() !== userId.toString(),
      );
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
    logger.error("toggleLike error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// DELETE /api/posts/:postId - Post sil (sadece sahibi)
exports.deletePost = async (req, res) => {
  try {
    await purgeExpiredPosts();

    const userId = req.user.id;
    const { postId } = req.params;

    const post = await Post.findById(postId);
    if (
      !post ||
      (post.expiresAt instanceof Date && post.expiresAt <= new Date())
    ) {
      if (post) {
        await removePostAsset(post);
        await Post.findByIdAndDelete(postId);
      }
      return res
        .status(404)
        .json({ success: false, message: "Post bulunamadı" });
    }

    if (post.user.toString() !== userId.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Bu işlem için yetkiniz yok" });
    }

    await removePostAsset(post);

    await Post.findByIdAndDelete(postId);

    res.json({ success: true, message: "Post silindi" });
  } catch (err) {
    logger.error("deletePost error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
