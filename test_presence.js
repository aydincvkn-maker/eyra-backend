// test_presence.js - Test Firebase presence with real users
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

// Initialize Firebase
const serviceAccountPath = path.join(__dirname, './serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://eyra-9cf0d-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/eyra', {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅ MongoDB bağlantısı başarılı'))
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('⚠️ Make sure MongoDB is running: mongod.exe');
    process.exit(1);
  });

// User model
const userSchema = new mongoose.Schema({
  username: String,
  email: String,
  gender: String,
});

const User = mongoose.model('User', userSchema);

async function testPresence() {
  try {
    console.log('\n📊 DATABASE STATUS\n');
    
    // Get users
    const users = await User.find().limit(5);
    console.log(`📝 Found ${users.length} users in MongoDB`);
    
    if (users.length === 0) {
      console.log('❌ No users found! Creating test users...');
      
      // Create test users
      const testUsers = [
        { username: 'user1', email: 'user1@test.com', gender: 'male' },
        { username: 'user2', email: 'user2@test.com', gender: 'female' },
        { username: 'user3', email: 'user3@test.com', gender: 'female' }
      ];
      
      const created = await User.insertMany(testUsers);
      console.log(`✅ Created ${created.length} test users`);
      
      users.length = 0;
      users.push(...created);
    }
    
    console.log('\nUsers:');
    users.forEach(u => {
      console.log(`  - ${u.username} (${u.gender}) - ID: ${u._id}`);
    });
    
    // Check Firebase presence
    console.log('\n🔥 FIREBASE PRESENCE\n');
    
    const snapshot = await db.ref('presence').once('value');
    const presenceData = snapshot.val() || {};
    
    console.log(`📊 Firebase presence records: ${Object.keys(presenceData).length}`);
    
    if (Object.keys(presenceData).length === 0) {
      console.log('⚠️ No presence data in Firebase');
      console.log('\n💡 ACTION: Please connect from Flutter app (it will auto-register and set online status)');
    } else {
      console.log('\n✅ Presence data found:');
      Object.entries(presenceData).forEach(([userId, data]) => {
        const status = data.online ? (data.live ? 'LIVE' : 'ONLINE') : 'OFFLINE';
        console.log(`  - ${userId}: ${status}`);
      });
    }
    
    console.log('\n📡 URLS TO TEST:\n');
    console.log('  1. Get all users: http://localhost:5000/api/list-all-users');
    console.log('  2. Firebase presence: http://localhost:5000/api/debug/firebase-presence');
    console.log('  3. Socket status: http://localhost:5000/api/debug/socket-status');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

testPresence();
