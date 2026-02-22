/* eslint-disable no-console */
// Kullanıcıyı username'e göre super_admin yapar
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

const TARGET_USERNAME = 'aydincvkn';

(async () => {
  try {
    await connectDB();

    const user = await User.findOne({ username: TARGET_USERNAME });

    if (!user) {
      console.log(`❌ Kullanıcı bulunamadı: ${TARGET_USERNAME}`);
      process.exit(1);
    }

    console.log(`📋 Mevcut: username=${user.username}, email=${user.email}, role=${user.role}`);

    user.role = 'super_admin';
    user.isActive = true;
    user.isBanned = false;
    user.isFrozen = false;
    await user.save();

    console.log(`✅ ${user.username} (${user.email}) artık super_admin! id=${user._id}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err.message);
    process.exit(1);
  }
})();
