# 📡 EYRA Online/Offline Presence System

## Genel Bakış

EYRA'nın presence (online/offline) sistemi **socket-driven** ve **in-memory** bir yapıdır. Bu dokümanda sistemin mimarisi, özellikleri ve önemli noktalar açıklanmaktadır.

---

## 🏗️ Mimari

### Single Source of Truth: Socket.io + Heartbeat

- **Socket bağlantısı = Online**: Kullanıcı socket'e bağlı olduğunda online kabul edilir
- **Heartbeat mekanizması**: Client her 5 saniyede bir `user:heartbeat` event'i gönderir
- **Timeout**: 15 saniye heartbeat gelmezse kullanıcı offline olarak işaretlenir
- **Sweep**: Her 3 saniyede bir stale connections temizlenir

### Veri Akışı

```
1. Client connects → Socket.io authentication (JWT)
2. registerUser() → presenceService.setOnline()
3. presenceService emits 'changed' event
4. Event listener → persistPresenceToDatabase() + broadcast to sockets
5. Client sends heartbeat every 5s → updates lastPing
6. If no heartbeat for 15s → sweep marks user offline
7. Client disconnects → setOffline() → broadcast offline status
```

---

## 🔥 Temel Özellikler

### 1. **Socket-Driven Presence**
- Memory-based (Redis yok, Firebase yok)
- Gerçek zamanlı socket bağlantısı = presence durumu
- DB sadece persistence için (async, non-blocking)

### 2. **Gender-Based Visibility**
- **Male users**: Sadece female kullanıcıları görür
- **Female/Other users**: Tüm kullanıcıları görür
- Socket.io rooms kullanılarak optimize edilmiş broadcast

### 3. **Status Types**
- `online`: Normal bağlı durum
- `offline`: Bağlantı yok
- `live`: Canlı yayın yapıyor
- `in_call`: Görüşme içinde (busy)

### 4. **Race Condition Protection**
- Duplicate registration önlenir
- Socket ID validation ile stale disconnect'ler ignore edilir
- Debounce ile DB güncellemeleri optimize edilir

### 5. **Memory Leak Prevention**
- Graceful shutdown mekanizması
- Event listener cleanup
- Timer ve cache cleanup
- socketGenderCache otomatik temizlenir

---

## 📊 Metrics & Monitoring

### Health Endpoint
```bash
GET /api/health
```

Response:
```json
{
  "status": "ok",
  "presence": {
    "onlineUsers": 42,
    "peakOnline": 156,
    "totalConnections": 1234,
    "totalDisconnections": 1192,
    "totalSwepts": 89,
    "lastSweepAt": "2026-01-11T10:30:45.123Z",
    "uptimeMs": 3600000
  },
  "sockets": {
    "connected": 42,
    "connectedUsers": 42
  }
}
```

### Debug Endpoints
- `GET /api/debug/presence` - Online kullanıcılar ve metrics
- `GET /api/debug/socket-status` - Socket bağlantı durumu
- `GET /api/check-online-status` - DB vs Memory karşılaştırması

---

## 🔒 Güvenlik

### 1. **JWT Authentication**
- Socket bağlantısı için JWT token gerekli
- Token validation middleware ile korunur
- Production'da insecure auth devre dışı (NODE_ENV check)

### 2. **Regex Injection Protection**
- Search query'lerde özel karakterler escape edilir
- SQL/NoSQL injection koruması

### 3. **Socket ID Validation**
- Her setOffline çağrısında socket ID kontrol edilir
- Eski socket'lerden gelen disconnect ignore edilir

---

## 🚀 Performance Optimizations

### 1. **Socket.io Rooms**
Önceki implementasyon:
```javascript
// ❌ Her socket için loop (O(n))
for (const socket of io.sockets.sockets.values()) {
  if (canSeeTarget(viewerGender, targetGender)) {
    socket.emit('presence-update', data);
  }
}
```

Yeni implementasyon:
```javascript
// ✅ Room-based broadcast (O(1))
io.to('viewer-male').to('viewer-female').emit('presence-update', data);
```

### 2. **DB Sync Debounce**
- Online transitions: 2 saniye debounce (rapid changes için)
- Offline transitions: 0ms debounce (immediate visibility)
- Pending updates map ile duplicate engellenir

### 3. **Cache Optimization**
- socketGenderCache: Gender'ı cache'ler, her socket read'i önler
- lastSeenCache: Offline kullanıcılar için fallback
- Otomatik cleanup: Stale entries kaldırılır

### 4. **Batch Processing**
- getMultiplePresence: Sync operation, await gereksiz
- Sweep: Batch delete operations

---

## 🐛 Çözülen Kritik Hatalar

### 1. **Race Condition: Duplicate Registration**
```javascript
// ❌ ÖNCE
let isRegistered = false;
const registerUser = async () => {
  if (isRegistered) return;
  // async işlemler...
  isRegistered = true; // ÇOK GEÇ!
}

// ✅ SONRA
let registrationInProgress = false;
const registerUser = async () => {
  if (isRegistered || registrationInProgress) return;
  registrationInProgress = true; // HEMEN!
  try {
    // async işlemler...
    isRegistered = true;
  } finally {
    registrationInProgress = false;
  }
}
```

### 2. **Memory Leak: DB Sync Timeout**
```javascript
// ❌ ÖNCE
setTimeout(async () => {
  pendingDbUpdates.delete(userId); // Hata olursa çalışmaz!
  await User.updateOne(...);
}, delayMs);

// ✅ SONRA
setTimeout(async () => {
  try {
    await User.updateOne(...);
  } finally {
    pendingDbUpdates.delete(userId); // HER ZAMAN çalışır
  }
}, delayMs);
```

### 3. **Memory Leak: Event Listeners**
```javascript
// ❌ ÖNCE
presenceService.on("changed", (payload) => { ... }); // Cleanup yok

// ✅ SONRA
const onPresenceChanged = (payload) => { ... };
presenceService.on("changed", onPresenceChanged);

process.on('SIGTERM', () => {
  presenceService.off("changed", onPresenceChanged); // Cleanup!
});
```

### 4. **Regex Injection**
```javascript
// ❌ ÖNCE
{ username: { $regex: searchQuery, $options: 'i' } }

// ✅ SONRA
const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
{ username: { $regex: escaped, $options: 'i' } }
```

### 5. **Insecure Auth in Production**
```javascript
// ❌ ÖNCE
if (process.env.SOCKET_ALLOW_INSECURE_USERID === 'true') {
  // Herkes her userId ile bağlanabilir!
}

// ✅ SONRA
const ALLOW_INSECURE = process.env.NODE_ENV === 'development' 
  && process.env.SOCKET_ALLOW_INSECURE_USERID === 'true';
if (!token && ALLOW_INSECURE) { ... }
```

---

## 🔧 Environment Variables

```bash
# Presence System
PRESENCE_HEARTBEAT_TIMEOUT_MS=15000    # 15 saniye (client 5s gönderir)
PRESENCE_SWEEP_INTERVAL_MS=3000        # 3 saniye sweep interval
PRESENCE_ENABLE_SERVER_HEARTBEAT=false # Server-side heartbeat (optional)
PRESENCE_SERVER_HEARTBEAT_INTERVAL_MS=10000

# Socket.io
SOCKET_ALLOW_INSECURE_USERID=false     # DEV ONLY - production'da false!

# Node.js
NODE_ENV=production                     # development | production
```

---

## 📝 Best Practices

### Client Implementation (Flutter)
```dart
// 1. Socket bağlantısı
socket = io('https://api.eyra.com', {
  'transports': ['websocket', 'polling'],
  'auth': {'token': jwtToken},
});

// 2. Heartbeat gönder (5 saniyede bir)
Timer.periodic(Duration(seconds: 5), (_) {
  socket.emit('user:heartbeat');
});

// 3. Presence dinle
socket.on('presence-update', (data) {
  // Update UI
  updateUserStatus(data['userId'], data['status']);
});

// 4. Disconnect'te temizlik
socket.disconnect();
```

### Server Implementation
```javascript
// 1. Presence değişikliğini dinle
presenceService.on('changed', (payload) => {
  // Custom logic...
});

// 2. Kullanıcı durumunu kontrol et
const presence = await presenceService.getPresence(userId);
if (presence.online) {
  // User is online
}

// 3. Status değiştir
await presenceService.setStatus(userId, 'live', {
  socketId: socket.id,
  streamDetails: { ... }
});
```

---

## 🧪 Testing

### Test Files
- `test_presence_socket.js` - Socket-based presence test
- `test_presence.js` - Firebase legacy test (deprecated)
- `scripts/presence_smoke_test.ps1` - PowerShell smoke test

### Test Scenarios
1. ✅ Multiple users connect/disconnect
2. ✅ Heartbeat timeout (15s)
3. ✅ Status changes (live, in_call)
4. ✅ Gender-based visibility
5. ✅ Race conditions (rapid connect/disconnect)
6. ✅ Graceful shutdown

### Run Tests
```bash
# Socket-based test
node test_presence_socket.js

# Health check
curl http://localhost:5000/api/health

# Debug presence
curl http://localhost:5000/api/debug/presence
```

---

## 🚨 Common Issues & Solutions

### Issue 1: Users stuck online after disconnect
**Cause:** Sweep not running or timeout too high  
**Solution:** Check PRESENCE_SWEEP_INTERVAL_MS (3000ms recommended)

### Issue 2: Users not seeing each other online
**Cause:** Gender visibility rules or socket room issue  
**Solution:** Check user gender in DB, verify socket.join() works

### Issue 3: Memory growing over time
**Cause:** Event listeners or timers not cleaned up  
**Solution:** Enable graceful shutdown, verify cleanup logs

### Issue 4: DB updates delayed
**Cause:** Debounce too high or pending updates stuck  
**Solution:** Check pendingDbUpdates map, verify finally block

---

## 📚 Architecture Diagrams

### Connection Flow
```
┌─────────┐         ┌──────────┐         ┌─────────────┐
│ Client  │ ──JWT──▶│ Socket.io│ ──auth─▶│ Middleware  │
└─────────┘         └──────────┘         └─────────────┘
                         │                        │
                         ▼                        ▼
                    ┌─────────┐            ┌──────────┐
                    │ Room    │            │ User.    │
                    │ Join    │            │ findById │
                    └─────────┘            └──────────┘
                         │                        │
                         ▼                        ▼
                    ┌──────────────────────────────┐
                    │  registerUser()              │
                    │  - setOnline                 │
                    │  - emit 'changed'            │
                    │  - broadcast to rooms        │
                    └──────────────────────────────┘
```

### Heartbeat Flow
```
┌─────────┐                    ┌──────────────┐
│ Client  │──5s timer─────────▶│ user:        │
│         │   heartbeat        │ heartbeat    │
└─────────┘                    └──────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ presenceService.│
                              │ heartbeat()     │
                              │ - update lastPing│
                              └─────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Sweep (3s)      │
                              │ - check staleness│
                              │ - setOffline if │
                              │   > 15s         │
                              └─────────────────┘
```

---

## 🎯 Sonuç

EYRA presence sistemi artık **production-ready** durumda:

✅ Race conditions çözüldü  
✅ Memory leaks düzeltildi  
✅ Performance optimize edildi  
✅ Security güçlendirildi  
✅ Monitoring eklendi  
✅ Graceful shutdown destekleniyor  
✅ Comprehensive documentation hazır  

**Sistem artık tam profesyonel seviyede!** 🚀
