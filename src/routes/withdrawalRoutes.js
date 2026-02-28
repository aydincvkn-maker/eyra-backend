// src/routes/withdrawalRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requirePermission = require("../middleware/requirePermission");
const withdrawalController = require("../controllers/withdrawalController");

// ─── Yayıncı (kullanıcı) endpointleri ───────────────────────────
router.get("/broadcaster-info", auth, withdrawalController.getBroadcasterInfo);
router.post("/sign-contract", auth, withdrawalController.signContract);
router.put("/bank-info", auth, withdrawalController.updateBankInfo);
router.post("/request", auth, withdrawalController.createWithdrawalRequest);
router.get("/my", auth, withdrawalController.getMyWithdrawals);
router.get("/salary-history", auth, withdrawalController.getSalaryHistory);

// ─── Admin endpointleri ──────────────────────────────────────────
router.get("/admin/list", auth, requirePermission("finance:view"), withdrawalController.adminListWithdrawals);
router.put("/admin/:id/approve", auth, requirePermission("finance:view"), withdrawalController.adminApproveWithdrawal);
router.put("/admin/:id/reject", auth, requirePermission("finance:view"), withdrawalController.adminRejectWithdrawal);
router.put("/admin/:id/mark-paid", auth, requirePermission("finance:view"), withdrawalController.adminMarkPaid);

// ─── Admin maaş yönetimi ────────────────────────────────────────
router.post("/admin/salary/process", auth, requirePermission("finance:view"), withdrawalController.adminProcessSalaries);
router.get("/admin/salary/list", auth, requirePermission("finance:view"), withdrawalController.adminListSalaries);

module.exports = router;
