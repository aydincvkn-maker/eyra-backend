/* eslint-disable no-console */
/**
 * Patronu (owner) belirleme scripti
 * Kullanım: node scripts/set-owner.js <email>
 * Örnek: node scripts/set-owner.js benim@email.com
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

const TARGET_EMAIL = process.argv[2];

(async () => {
  if (!TARGET_EMAIL) {
    console.error('❌ Kullanım: node scripts/set-owner.js <email>');
    process.exit(1);
  }

  try {
    await connectDB();

    // Önce tüm mevcut owner'ları kaldır
    const prevOwners = await User.find({ isOwner: true }).select('email').lean();
    if (prevOwners.length > 0) {
      console.log(`📋 Mevcut owner'lar temizleniyor:`, prevOwners.map(u => u.email).join(', '));
      await User.updateMany({ isOwner: true }, { $set: { isOwner: false } });
    }

    const user = await User.findOne({ email: TARGET_EMAIL.toLowerCase().trim() });
    if (!user) {
      console.error(`❌ ${TARGET_EMAIL} emailine sahip kullanıcı bulunamadı.`);
      process.exit(1);
    }

    user.isOwner = true;
    user.role = 'super_admin'; // Owner super_admin rolünde olmalı
    user.isActive = true;
    user.isBanned = false;
    user.isPanelRestricted = false;
    await user.save();

    console.log(`✅ ${user.email} (${user.username}) artık PATRON (owner) olarak atandı!`);
    console.log(`   Role: ${user.role}, isOwner: ${user.isOwner}`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err.message);
    process.exit(1);
  }
})();
