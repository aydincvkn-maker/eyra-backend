// test_presence_socket.js - Test Socket-based Presence System
// This replaces the old Firebase-based test

const io = require('socket.io-client');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Node 18+ provides global fetch (Node 24 in this environment)
const fetchJson = async (url) => {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch() is not available (need Node 18+)');
  }
  const res = await fetch(url);
  const json = await res.json();
  return { res, json };
};

// Create a test JWT token
const createTestToken = (userId) => {
  return jwt.sign(
    { id: userId, email: `test${userId}@test.com`, username: `testuser${userId}` },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
};

// Test users are fetched from the backend so socket auth passes (User.findById).
// Fallback to dummy ObjectIds only if the backend user list cannot be fetched.
const FALLBACK_TEST_USERS = [
  { id: '507f1f77bcf86cd799439011', name: 'FallbackUser1' },
  { id: '507f1f77bcf86cd799439012', name: 'FallbackUser2' },
  { id: '507f1f77bcf86cd799439013', name: 'FallbackUser3' },
];

const loadTestUsersFromBackend = async () => {
  try {
    // Prefer a public endpoint that filters banned/inactive users.
    const { json } = await fetchJson(`${BASE_URL}/api/users/females`);

    const users = Array.isArray(json?.users) ? json.users : [];
    const picked = users
      .map((u) => ({
        id: String(u?._id || '').trim(),
        name: String(u?.name || u?.username || 'User'),
      }))
      .filter((u) => u.id)
      .slice(0, 3);

    if (picked.length >= 1) {
      return picked;
    }
  } catch (_) {
    // ignore, fallback below
  }
  return FALLBACK_TEST_USERS;
};

const connectedSockets = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getConnectedSockets = () => connectedSockets.filter(({ socket }) => socket && socket.connected);

async function testPresence() {
  let success = true;
  console.log('\n🔌 SOCKET-BASED PRESENCE TEST\n');
  console.log(`📡 Connecting to: ${BASE_URL}\n`);

  const TEST_USERS = await loadTestUsersFromBackend();
  console.log(`👤 Using ${TEST_USERS.length} test users:`);
  TEST_USERS.forEach((u) => console.log(`   - ${u.name} (${u.id})`));
  console.log('');

  try {
    // Connect test users
    for (const user of TEST_USERS) {
      const token = createTestToken(user.id);
      
      const socket = io(BASE_URL, {
        transports: ['polling', 'websocket'],
        auth: { token },
        query: { userId: user.id, token },
        path: '/socket.io/',
        timeout: 10000,
      });

      socket.on('connect', () => {
        console.log(`✅ ${user.name} connected (socket: ${socket.id})`);
        socket.emit('register', user.id);
      });

      socket.on('connect_error', (err) => {
        console.log(`❌ ${user.name} connection error: ${err.message}`);
      });

      socket.on('presence-update', (data) => {
        console.log(`📡 ${user.name} received presence update:`, JSON.stringify(data, null, 2));
      });

      socket.on('user:status-changed', (data) => {
        console.log(`📡 ${user.name} received status change:`, JSON.stringify(data, null, 2));
      });

      socket.on('presence:all-users-updated', (data) => {
        const count = data?.users ? Object.keys(data.users).length : 0;
        console.log(`📡 ${user.name} received all-users snapshot: ${count} users`);
      });

      socket.on('disconnect', (reason) => {
        console.log(`🔌 ${user.name} disconnected: ${reason}`);
      });

      connectedSockets.push({ user, socket });
    }

    // Wait for connections
    await sleep(3000);

    const initiallyConnected = getConnectedSockets();
    if (initiallyConnected.length === 0) {
      throw new Error('No sockets connected; cannot run presence test');
    }

    console.log('\n📊 TESTING HEARTBEAT...\n');

    // Send heartbeats
    for (const { user, socket } of getConnectedSockets()) {
      if (socket.connected) {
        socket.emit('user:heartbeat');
        console.log(`💓 ${user.name} sent heartbeat`);
      }
    }

    await sleep(1000);

    console.log('\n📊 TESTING STATUS CHANGES...\n');

    const connectedNow = getConnectedSockets();

    // Test status changes
    if (connectedNow[0]?.socket?.connected) {
      connectedNow[0].socket.emit('user:set_status', 'live');
      console.log(`🔴 ${connectedNow[0].user.name} set status to LIVE`);
    }

    if (connectedNow[1]?.socket?.connected) {
      connectedNow[1].socket.emit('user:set_status', 'in_call');
      console.log(`📞 ${connectedNow[1].user.name} set status to IN_CALL`);
    }

    await sleep(2000);

    console.log('\n📊 CHECKING API ENDPOINTS...\n');

    // Check debug endpoints
    
    let beforePresenceOnline = null;
    try {
      const { json: presenceData } = await fetchJson(`${BASE_URL}/api/debug/presence`);
      beforePresenceOnline = presenceData.totalOnline;
      console.log('📡 /api/debug/presence:');
      console.log(`   Total Online: ${presenceData.totalOnline}`);
      console.log(`   Metrics:`, presenceData.metrics || 'N/A');
      presenceData.users?.forEach(u => {
        console.log(`   - ${u.userId}: ${u.status} (socket: ${u.socketId?.slice(-8) || 'N/A'})`);
      });
    } catch (e) {
      console.log(`⚠️ Could not fetch /api/debug/presence: ${e.message}`);
    }

    console.log('');

    let beforeConnectedUsers = null;
    let beforeConnectedSockets = null;
    try {
      const { json: socketData } = await fetchJson(`${BASE_URL}/api/debug/socket-status`);
      beforeConnectedSockets = socketData.connectedSockets;
      beforeConnectedUsers = socketData.connectedUsers;
      console.log('📡 /api/debug/socket-status:');
      console.log(`   Connected Sockets: ${socketData.connectedSockets}`);
      console.log(`   Connected Users: ${socketData.connectedUsers}`);
      console.log(`   Presence Metrics:`, socketData.presenceMetrics || 'N/A');
    } catch (e) {
      console.log(`⚠️ Could not fetch /api/debug/socket-status: ${e.message}`);
    }

    // Assert we really have multiple users online for a meaningful test
    const expectedConnected = getConnectedSockets().length;
    if (typeof beforePresenceOnline === 'number' && beforePresenceOnline < expectedConnected) {
      throw new Error(`Presence online count too low before disconnect (expected >= ${expectedConnected}, got ${beforePresenceOnline})`);
    }
    if (typeof beforeConnectedUsers === 'number' && beforeConnectedUsers < expectedConnected) {
      throw new Error(`Socket connected user count too low (expected >= ${expectedConnected}, got ${beforeConnectedUsers})`);
    }

    console.log('\n📊 TESTING DISCONNECT...\n');

    // Disconnect a currently connected user (deterministic)
    const toDisconnect = getConnectedSockets()[0];
    if (!toDisconnect) {
      throw new Error('No connected socket available to disconnect');
    }

    toDisconnect.socket.disconnect();
    console.log(`🔌 ${toDisconnect.user.name} manually disconnected`);

    await sleep(1000);

    // Poll presence until the server reflects the disconnect (avoid false positives)
    let finalOnline = null;
    for (let i = 0; i < 10; i++) {
      try {
        const { json: presenceData } = await fetchJson(`${BASE_URL}/api/debug/presence`);
        finalOnline = presenceData.totalOnline;
        if (typeof finalOnline === 'number' && finalOnline <= Math.max(0, getConnectedSockets().length)) {
          // Presence count should not exceed currently connected sockets in this test.
          break;
        }
      } catch (_) {
        // ignore
      }
      await sleep(500);
    }
    console.log(`📡 After disconnect - Online users: ${finalOnline}`);

    if (typeof beforePresenceOnline === 'number' && typeof finalOnline === 'number') {
      if (finalOnline > beforePresenceOnline) {
        throw new Error(`Online users increased after disconnect (${beforePresenceOnline} -> ${finalOnline})`);
      }
      if (finalOnline !== Math.max(0, beforePresenceOnline - 1)) {
        throw new Error(`Unexpected online users after disconnect (expected ${Math.max(0, beforePresenceOnline - 1)}, got ${finalOnline})`);
      }
    }

    console.log('\n✅ TEST COMPLETE\n');
    // Keep alive briefly to see async events
    await sleep(1000);

  } catch (err) {
    success = false;
    console.error('❌ Test error:', err);
  } finally {
    // Cleanup
    connectedSockets.forEach(({ socket }) => {
      if (socket.connected) socket.disconnect();
    });
    process.exit(success ? 0 : 1);
  }
}

testPresence();
