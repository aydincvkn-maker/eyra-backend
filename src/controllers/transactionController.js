// src/controllers/transactionController.js
const Transaction = require("../models/Transaction");
const User = require("../models/User");

// GET /api/transactions - Kendi işlem geçmişim
exports.getMyTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20"), 1), 100);
    const type = req.query.type;

    const query = { user: userId };
    if (type) query.type = type;

    const total = await Transaction.countDocuments(query);
    const transactions = await Transaction.find(query)
      .populate("relatedUser", "_id username name profileImage")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getMyTransactions error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/transactions/summary - Özet istatistikler
exports.getTransactionSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const days = parseInt(req.query.days || "30");
    const since = new Date();
    since.setDate(since.getDate() - days);

    const summary = await Transaction.aggregate([
      { $match: { user: require("mongoose").Types.ObjectId.createFromHexString(userId), createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$type",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Toplam gelir ve gider
    const income = summary
      .filter((s) => s.totalAmount > 0)
      .reduce((sum, s) => sum + s.totalAmount, 0);
    const expense = summary
      .filter((s) => s.totalAmount < 0)
      .reduce((sum, s) => sum + Math.abs(s.totalAmount), 0);

    res.json({
      success: true,
      summary: {
        period: `${days} gün`,
        income,
        expense,
        net: income - expense,
        breakdown: summary,
      },
    });
  } catch (err) {
    console.error("getTransactionSummary error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// =============================================
// ADMIN ENDPOINTS
// =============================================

// GET /api/transactions/admin - Tüm işlemler (admin)
exports.adminGetTransactions = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50"), 1), 200);
    const type = req.query.type;
    const userId = req.query.userId;

    const query = {};
    if (type) query.type = type;
    if (userId) query.user = userId;

    const total = await Transaction.countDocuments(query);
    const transactions = await Transaction.find(query)
      .populate("user", "_id username name profileImage")
      .populate("relatedUser", "_id username name profileImage")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("adminGetTransactions error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};

// GET /api/transactions/admin/stats - Finansal istatistikler
exports.adminGetFinanceStats = async (req, res) => {
  try {
    const days = parseInt(req.query.days || "30");
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Genel istatistikler
    const stats = await Transaction.aggregate([
      { $match: { createdAt: { $gte: since }, status: "completed" } },
      {
        $group: {
          _id: "$type",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Günlük trend
    const dailyTrend = await Transaction.aggregate([
      { $match: { createdAt: { $gte: since }, status: "completed" } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          totalIncome: {
            $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
          },
          totalExpense: {
            $sum: { $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0] },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Top earners
    const topEarners = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          amount: { $gt: 0 },
          type: { $in: ["gift_received", "call_earning"] },
        },
      },
      {
        $group: {
          _id: "$user",
          totalEarned: { $sum: "$amount" },
          transactionCount: { $sum: 1 },
        },
      },
      { $sort: { totalEarned: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      { $unwind: "$userInfo" },
      {
        $project: {
          userId: "$_id",
          username: "$userInfo.username",
          name: "$userInfo.name",
          profileImage: "$userInfo.profileImage",
          totalEarned: 1,
          transactionCount: 1,
        },
      },
    ]);

    // Top spenders
    const topSpenders = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          amount: { $lt: 0 },
          type: { $in: ["gift_sent", "call_payment", "vip_purchase"] },
        },
      },
      {
        $group: {
          _id: "$user",
          totalSpent: { $sum: { $abs: "$amount" } },
          transactionCount: { $sum: 1 },
        },
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      { $unwind: "$userInfo" },
      {
        $project: {
          userId: "$_id",
          username: "$userInfo.username",
          name: "$userInfo.name",
          profileImage: "$userInfo.profileImage",
          totalSpent: 1,
          transactionCount: 1,
        },
      },
    ]);

    const totalIncome = stats.filter((s) => s.totalAmount > 0).reduce((sum, s) => sum + s.totalAmount, 0);
    const totalExpense = stats.filter((s) => s.totalAmount < 0).reduce((sum, s) => sum + Math.abs(s.totalAmount), 0);

    res.json({
      success: true,
      stats: {
        period: `${days} gün`,
        totalIncome,
        totalExpense,
        netFlow: totalIncome - totalExpense,
        breakdown: stats,
        dailyTrend,
        topEarners,
        topSpenders,
      },
    });
  } catch (err) {
    console.error("adminGetFinanceStats error:", err);
    res.status(500).json({ success: false, message: "Sunucu hatası" });
  }
};
