// scripts/unban_admins.js - Admin hesaplarını unban et
const mongoose = require('mongoose');
const env = require('../src/config/env');
const User = require('../src/models/User');

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log('DB bağlandı');

  // Tüm admin/super_admin hesaplarını unban et
  const result = await User.updateMany(
    { role: { $in: ['admin', 'super_admin'] } },
    { $set: { isBanned: false, isFrozen: false, isActive: true } }
  );
  console.log('Admin hesaplar güncellendi:', result.modifiedCount, 'hesap');

  // Durumu göster
  const admins = await User.find({ role: { $in: ['admin', 'super_admin'] } })
    .select('username role isBanned isFrozen isActive coins');
  admins.forEach(a => {
    console.log(`  ${a.username} | ${a.role} | banned:${a.isBanned} | frozen:${a.isFrozen} | active:${a.isActive} | coins:${a.coins}`);
  });

  await mongoose.disconnect();
  console.log('Bitti!');
}

main().catch(err => { console.error(err); process.exit(1); });
