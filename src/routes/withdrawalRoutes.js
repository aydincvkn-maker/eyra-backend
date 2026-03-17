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
router.get("/my-violations", auth, withdrawalController.getMyViolations);

// ─── Admin endpointleri ──────────────────────────────────────────
router.get(
  "/admin/list",
  auth,
  requirePermission("finance:view"),
  withdrawalController.adminListWithdrawals,
);
router.put(
  "/admin/:id/approve",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminApproveWithdrawal,
);
router.put(
  "/admin/:id/reject",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminRejectWithdrawal,
);
router.put(
  "/admin/:id/mark-paid",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminMarkPaid,
);

// ─── Admin maaş yönetimi ────────────────────────────────────────
router.post(
  "/admin/salary/process",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminProcessSalaries,
);
router.get(
  "/admin/salary/list",
  auth,
  requirePermission("finance:view"),
  withdrawalController.adminListSalaries,
);
router.get(
  "/admin/weekly-report",
  auth,
  requirePermission("finance:view"),
  withdrawalController.adminWeeklyReport,
);

// ─── Admin ihlal (violation) yönetimi ────────────────────────────
router.post(
  "/admin/violations/:userId",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminAddViolation,
);
router.get(
  "/admin/violations/:userId",
  auth,
  requirePermission("finance:view"),
  withdrawalController.adminGetViolations,
);
router.put(
  "/admin/violations/:userId/:violationId",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminUpdateViolation,
);
router.delete(
  "/admin/violations/:userId/:violationId",
  auth,
  requirePermission("finance:manage"),
  withdrawalController.adminDeleteViolation,
);

module.exports = router;
