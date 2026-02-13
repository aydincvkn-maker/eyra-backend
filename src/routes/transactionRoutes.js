// src/routes/transactionRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const transactionController = require("../controllers/transactionController");

// Kullanıcı endpoint'leri
router.get("/", auth, transactionController.getMyTransactions);
router.get("/summary", auth, transactionController.getTransactionSummary);

// Admin endpoint'leri
router.get("/admin", auth, requirePermission("finance:view"), transactionController.adminGetTransactions);
router.get("/admin/stats", auth, requirePermission("finance:view"), transactionController.adminGetFinanceStats);

module.exports = router;
