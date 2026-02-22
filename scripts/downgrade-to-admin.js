/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

// Bu kullanıcılar admin'e düşürülecek (aydincvkn hariç)
const DOWNGRADE_USERNAMES = ['akolomiitsieva', 'sasha_admin'];

(async () => {
  try {
    await connectDB();

    for (const username of DOWNGRADE_USERNAMES) {
      const user = await User.findOne({ username });
      if (!user) {
        console.log(`⚠️ Kullanıcı bulunamadı: ${username}`);
        continue;
      }
      console.log(`📋 Mevcut: username=${user.username}, role=${user.role}`);
      user.role = 'admin';
      await user.save();
      console.log(`✅ ${user.username} artık admin!`);
    }

    // Son durumu listele
    const admins = await User.find({ role: { $in: ['admin', 'super_admin'] } })
      .select('username role email').lean();
    console.log('\n📋 Güncel admin listesi:');
    admins.forEach(u => console.log(`  [${u.role}] ${u.username}`));

    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err.message);
    process.exit(1);
  }
})();
