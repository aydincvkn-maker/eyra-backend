const fs = require('fs');
const c = fs.readFileSync('./src/controllers/userController.js', 'utf8');

// Find the part inside uploadAvatar where we do findByIdAndUpdate
const marker = 'const user = await User.findByIdAndUpdate(\r\n      userId,\r\n      {\r\n        $set: {\r\n          profileImage: avatarUrl,\r\n          profileImagePublicId: uploaded.publicId,\r\n        },\r\n      },\r\n      { new: true },\r\n    ).select("-password -refreshToken");';

const replacement = `// Kadin kullanici yeni fotograf yuklediginde gorunurlugu geri ac
    const uploadingUser = await User.findById(userId).select("gender settings");
    const setFields = {
      profileImage: avatarUrl,
      profileImagePublicId: uploaded.publicId,
    };
    if (
      uploadingUser?.gender === "female" &&
      uploadingUser?.settings?.profileVisibility === false
    ) {
      setFields["settings.profileVisibility"] = true;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: setFields },
      { new: true },
    ).select("-password -refreshToken");`;

if (!c.includes(marker)) {
  console.log('MARKER NOT FOUND');
  process.exit(1);
}

const result = c.replace(marker, replacement);
fs.writeFileSync('./src/controllers/userController.js', result, 'utf8');
console.log('SUCCESS');
