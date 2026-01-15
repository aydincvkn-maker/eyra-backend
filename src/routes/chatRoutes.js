// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const auth = require("../middleware/auth");

router.get("/room/:roomId", auth, chatController.getRoomMessages);

module.exports = router;
