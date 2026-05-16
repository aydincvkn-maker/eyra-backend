const fs = require('fs');
const c = fs.readFileSync('./src/controllers/userController.js', 'utf8');
const start = c.indexOf('exports.deleteAvatar');
const end = c.indexOf('\r\nexports.getMyStats', start);
const oldBlock = c.slice(start, end + 1);

const newBlock = `exports.deleteAvatar = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select(
      "profileImage profileImagePublicId gender username",
    );
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Kullanici bulunamadi" });
    }

    if (user.profileImage) {
      const oldPublicId =
        user.profileImagePublicId ||
        storageService.extractPublicId(user.profileImage || "");
      if (oldPublicId) {
        storageService.destroy(oldPublicId, "image").catch(() => {});
      } else if (user.profileImage.startsWith("/uploads/")) {
        const filePath = path.join(__dirname, "../..", user.profileImage);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
      }
    }

    const updateFields = { profileImage: "", profileImagePublicId: "" };

    // Kadin kullanici profil resmini kaldirarsa otomatik gizle
    if (user.gender === "female") {
      updateFields["settings.profileVisibility"] = false;
      createNotification({
        recipientId: userId,
        type: "system",
        title: "Profilin gizlendi",
        titleEn: "Your profile is now hidden",
        body: "Profil fotografin olmadigi icin erkek kullanicilar seni goremez. Gorunur olmak icin yeni bir fotograf yukle.",
        bodyEn: "Male users cannot see your profile without a photo. Upload a new photo to become visible.",
        actionData: {},
      }).catch(() => {});
    }

    await User.findByIdAndUpdate(userId, { $set: updateFields });

    logger.info(\`Avatar silindi: \${user.username}\`);

    res.json({ success: true, message: "Avatar silindi" });
  } catch (err) {
    logger.error("deleteAvatar error:", err);
    res.status(500).json({ success: false, message: "Avatar silinemedi" });
  }
};`;

const result = c.replace(oldBlock, newBlock);
if (result === c) {
  console.log('ERROR: No replacement made');
} else {
  fs.writeFileSync('./src/controllers/userController.js', result, 'utf8');
  console.log('SUCCESS');
}
