/* eslint-disable no-console */
require('dotenv').config();
const readline = require('readline');
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

(async () => {
  try {
    await connectDB();

    const email = String(await ask('Admin email: ')).trim().toLowerCase();
    const password = String(await ask('Admin password: ')).trim();
    const username = String(await ask('Admin username: ')).trim();
    const name = String(await ask('Admin name: ')).trim();

    if (!email || !password || !username || !name) {
      console.log('❌ All fields are required.');
      process.exit(1);
    }

    const existing = await User.findOne({ email });
    if (existing) {
      console.log('⚠️ User already exists with this email.');
      process.exit(0);
    }

    const user = await User.create({
      username,
      name,
      email,
      password,
      role: 'admin',
      gender: 'other',
      age: 20,
      location: 'Türkiye',
      country: 'TR',
      coins: 0,
      isGuest: false,
      isOnline: false,
      isActive: true,
      isBanned: false,
      isFrozen: false,
    });

    console.log(`✅ Admin created: ${user.email} (id=${user._id})`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to create admin:', err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
})();
