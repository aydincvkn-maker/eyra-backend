try {
  require("./src/routes/chatRoutes");
  require("./src/routes/userRoutes");
  require("./src/routes/verificationRoutes");
  console.log("ALL-OK");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exit(1);
}
