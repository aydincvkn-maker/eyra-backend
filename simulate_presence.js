// simulate_presence.js - Simulate presence without MongoDB connection
const admin = require('firebase-admin');
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

async function simulatePresence() {
  try {
    console.log('\n🔥 SIMULATING PRESENCE DATA\n');
    
    // Create fake user IDs (as if they're MongoDB ObjectIds)
    const fakeUserIds = [
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
      '507f1f77bcf86cd799439013',
      '507f1f77bcf86cd799439014',
      '507f1f77bcf86cd799439015',
    ];
    
    console.log('📝 Adding presence data for test users:\n');
    
    for (let i = 0; i < fakeUserIds.length; i++) {
      const userId = fakeUserIds[i];
      const now = Date.now();
      
      // Alternate between online and offline for diversity
      const isOnline = i % 2 === 0;
      const isLive = i === 0; // First user is "live"
      const isBusy = i === 1; // Second user is "busy"
      
      const presenceData = {
        online: isOnline,
        busy: isBusy,
        live: isLive,
        inCall: false,
        lastSeen: now,
        lastOnline: isOnline ? now : now - 300000, // 5 min ago if offline
        lastOffline: !isOnline ? now : null
      };
      
      await db.ref(`presence/${userId}`).set(presenceData);
      
      const status = isLive ? 'LIVE' : (isBusy ? 'BUSY' : (isOnline ? 'ONLINE' : 'OFFLINE'));
      console.log(`  ✅ ${userId}: ${status}`);
    }
    
    console.log('\n✅ Presence data created successfully!\n');
    
    // Verify
    console.log('🔍 VERIFYING DATA:\n');
    const snapshot = await db.ref('presence').once('value');
    const allData = snapshot.val() || {};
    
    console.log(`📊 Total presence records: ${Object.keys(allData).length}`);
    console.log('\nData in Firebase:');
    Object.entries(allData).forEach(([userId, data]) => {
      const status = data.online ? (data.live ? 'LIVE' : 'ONLINE') : 'OFFLINE';
      console.log(`  - ${userId}: ${status} (lastSeen: ${new Date(data.lastSeen).toLocaleTimeString()})`);
    });
    
    console.log('\n✅ Now test with these URLs:\n');
    console.log('  1. http://localhost:5000/api/debug/firebase-presence');
    console.log('  2. http://localhost:5000/api/users');
    console.log('  3. http://localhost:5000/api/debug/socket-status\n');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
    process.exit(1);
  }
}

simulatePresence();
