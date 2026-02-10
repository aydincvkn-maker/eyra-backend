/* eslint-disable no-console */
require('dotenv').config();
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

(async () => {
  try {
    await connectDB();

    const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.ADMIN_PASSWORD || '').trim();
    const name = String(process.env.ADMIN_NAME || '').trim();
    const username = String(process.env.ADMIN_USERNAME || '').trim();

    if (!email || !password) {
      console.log('❌ ADMIN_EMAIL and ADMIN_PASSWORD are required.');
      process.exit(1);
    }

    const user = await User.findOne({ email });
    if (!user) {
      console.log('❌ User not found. Create first.');
      process.exit(1);
    }

    if (username) user.username = username;
    if (name) user.name = name;
    user.password = password; // will be hashed by pre-save hook
    user.role = 'admin';
    user.isActive = true;
    user.isBanned = false;
    user.isFrozen = false;

    await user.save();

    console.log(`✅ Admin reset: ${user.email} (id=${user._id})`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to reset admin:', err.message);
    process.exit(1);
  }
})();
