// scripts/clearLegacyUploadUrls.js
//
// One-shot migration helper: clears legacy /uploads/* URLs from the DB.
// Render's ephemeral disk wiped these files; users must re-upload.
//
// Usage:
//   node scripts/clearLegacyUploadUrls.js          # dry-run (counts only)
//   node scripts/clearLegacyUploadUrls.js --apply  # actually clear

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB. Mode:", APPLY ? "APPLY" : "DRY-RUN");

  const User = require("../src/models/User");
  const Verification = require("../src/models/Verification");

  // Count how many users have legacy avatars
  const userQuery = { profileImage: { $regex: "^/uploads/" } };
  const userCount = await User.countDocuments(userQuery);
  console.log(`Users with legacy /uploads/ profileImage: ${userCount}`);

  if (APPLY && userCount > 0) {
    const r = await User.updateMany(userQuery, {
      $set: { profileImage: "", profileImagePublicId: "" },
    });
    console.log(`  -> cleared profileImage on ${r.modifiedCount} users`);
  }

  // Verification photos
  const verifyFields = [
    "selfieUrl",
    "faceCenterUrl",
    "faceLeftUrl",
    "faceRightUrl",
  ];
  for (const field of verifyFields) {
    const q = { [field]: { $regex: "^/uploads/" } };
    const cnt = await Verification.countDocuments(q);
    console.log(`Verifications with legacy ${field}: ${cnt}`);
    if (APPLY && cnt > 0) {
      const r = await Verification.updateMany(q, { $set: { [field]: "" } });
      console.log(`  -> cleared ${field} on ${r.modifiedCount} docs`);
    }
  }

  // Chat messages: try to load Message model if present
  try {
    const Message = require("../src/models/Message");
    const msgQuery = { mediaUrl: { $regex: "^/uploads/" } };
    const msgCount = await Message.countDocuments(msgQuery);
    console.log(`Messages with legacy mediaUrl: ${msgCount}`);
    if (APPLY && msgCount > 0) {
      const r = await Message.updateMany(msgQuery, { $set: { mediaUrl: "" } });
      console.log(`  -> cleared mediaUrl on ${r.modifiedCount} messages`);
    }
  } catch (e) {
    console.log("(skipped Message cleanup:", e.message, ")");
  }

  // Posts
  try {
    const Post = require("../src/models/Post");
    const postQuery = { imageUrl: { $regex: "^/uploads/" } };
    const postCount = await Post.countDocuments(postQuery);
    console.log(`Posts with legacy imageUrl: ${postCount}`);
    if (APPLY && postCount > 0) {
      const r = await Post.updateMany(postQuery, { $set: { imageUrl: "" } });
      console.log(`  -> cleared imageUrl on ${r.modifiedCount} posts`);
    }
  } catch (e) {
    console.log("(skipped Post cleanup:", e.message, ")");
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
