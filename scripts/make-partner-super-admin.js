/* eslint-disable no-console */
/**
 * Ortağı super_admin yapma scripti
 * Kullanım: node scripts/make-partner-super-admin.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

const TARGET_EMAIL = 'mamasahatowadilya@gmail.com';
const TARGET_PASSWORD = '110405';

(async () => {
  try {
    await connectDB();

    let user = await User.findOne({ email: TARGET_EMAIL });

    if (user) {
      console.log(`📋 Mevcut kullanıcı bulundu: ${user.email}, role: ${user.role}`);
      user.role = 'super_admin';
      user.isActive = true;
      user.isBanned = false;
      user.isFrozen = false;
      user.isPanelRestricted = false;
      await user.save();
      console.log(`✅ Kullanıcı super_admin yapıldı: ${user.email}`);
    } else {
      console.log(`📋 Kullanıcı bulunamadı, yeni super_admin oluşturuluyor...`);
      user = await User.create({
        username: 'mamasaha_admin',
        name: 'Partner Admin',
        email: TARGET_EMAIL,
        password: TARGET_PASSWORD,
        role: 'super_admin',
        gender: 'other',
        age: 25,
        location: 'Türkiye',
        country: 'TR',
        coins: 0,
        isGuest: false,
        isOnline: false,
        isActive: true,
        isBanned: false,
        isFrozen: false,
        isPanelRestricted: false,
        isOwner: false,
      });
      console.log(`✅ Super admin oluşturuldu: ${user.email} (id=${user._id})`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err.message);
    process.exit(1);
  }
})();
