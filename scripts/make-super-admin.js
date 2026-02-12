/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const TARGET_EMAIL = '0987sashok@gmail.com';

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ MongoDB bağlantısı başarılı');

    const db = mongoose.connection.db;
    const user = await db.collection('users').findOne({ email: TARGET_EMAIL });

    if (!user) {
      console.log(`❌ Kullanıcı bulunamadı: ${TARGET_EMAIL}`);
      process.exit(1);
    }

    console.log(`📋 Mevcut kullanıcı: ${user.email}, role: ${user.role}`);

    await db.collection('users').updateOne(
      { email: TARGET_EMAIL },
      { $set: { role: 'super_admin', isActive: true, isBanned: false, isFrozen: false } }
    );

    const updated = await db.collection('users').findOne({ email: TARGET_EMAIL });
    console.log(`✅ Kullanıcı super_admin yapıldı: ${updated.email}, yeni role: ${updated.role}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err.message);
    process.exit(1);
  }
})();
