// src/jobs/backupCron.js
// ═══════════════════════════════════════════════════════════════
// Otomatik MongoDB Backup Sistemi
// - Her gün 03:00'te tüm kritik koleksiyonları JSON olarak yedekler
// - Firebase Realtime Database'e yazar (kalıcı, uzak depolama)
// - Son 7 günlük backup tutar, eskilerini siler
// - Manuel tetikleme: /api/admin/backup endpoint'i ile
// - Hafif indeks node'u (backup_index) üzerinden listeleme/temizlik
// ═══════════════════════════════════════════════════════════════
const cron = require("node-cron");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const { logger } = require("../utils/logger");

// Yedeklenecek koleksiyonlar (kritik veriler)
const COLLECTIONS_TO_BACKUP = [
  "users",
  "livestreams",
  "follows",
  "visitors",
  "callhistories",
  "achievements",
  "missions",
  "notifications",
  "transactions",
  "withdrawals",
  "adminmessages",
  "reports",
  "supporttickets",
  "gifts",
  "violations",
];

const MAX_BACKUP_DAYS = 7;

// 24-hex ObjectId regex (referans alanlarını tespit etmek için)
const OBJECTID_RE = /^[a-f\d]{24}$/i;

let cronJob = null;

/**
 * Tek bir koleksiyonun tüm dokümanlarını çeker
 * _id sıralı cursor kullanır — skip/limit'siz güvenilir okuma
 */
async function dumpCollection(collectionName) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB bağlantısı yok");

  const collection = db.collection(collectionName);
  const docs = await collection.find({}).sort({ _id: 1 }).toArray();
  return { count: docs.length, docs };
}

/**
 * Dokümanı JSON-safe hale getirir (ObjectId, Date → string)
 */
function serializeDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/**
 * Restore sırasında string ObjectId'leri tekrar ObjectId'ye çevirir (recursive)
 */
function restoreObjectIds(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string" && OBJECTID_RE.test(obj)) {
    try {
      return new mongoose.Types.ObjectId(obj);
    } catch {
      return obj;
    }
  }
  if (Array.isArray(obj)) return obj.map(restoreObjectIds);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = restoreObjectIds(v);
    }
    return out;
  }
  return obj;
}

/**
 * Tüm koleksiyonları yedekle → Firebase Realtime DB'ye yaz
 */
async function runBackup() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dateKey = new Date().toISOString().slice(0, 10); // 2026-03-20

  logger.info(`🔄 Backup başlıyor: ${timestamp}`);

  const result = {
    timestamp,
    date: dateKey,
    collections: {},
    totalDocuments: 0,
    errors: [],
    durationMs: 0,
  };

  for (const colName of COLLECTIONS_TO_BACKUP) {
    try {
      const db = mongoose.connection.db;
      if (!db) throw new Error("DB bağlantısı yok");

      // Koleksiyonun var olup olmadığını kontrol et
      const collections = await db.listCollections({ name: colName }).toArray();
      if (collections.length === 0) {
        result.collections[colName] = { count: 0, status: "skipped" };
        continue;
      }

      const { count, docs } = await dumpCollection(colName);
      result.collections[colName] = { count, status: "ok" };
      result.totalDocuments += count;

      // Firebase Realtime DB'ye yaz
      const ref = admin.database().ref(`backups/${dateKey}/${colName}`);

      // Önce eski veriyi temizle (aynı gün tekrar çalışırsa stale data kalmasın)
      await ref.set(null);

      if (count > 0) {
        // Chunk'lar halinde yaz (Firebase tek yazma limiti ~16 MB)
        const chunkSize = 200;
        for (let i = 0; i < docs.length; i += chunkSize) {
          const chunk = docs.slice(i, i + chunkSize);
          const chunkData = {};
          chunk.forEach((doc, idx) => {
            chunkData[`${i + idx}`] = serializeDoc(doc);
          });
          await ref.update(chunkData);
        }
      }

      logger.info(`  ✅ ${colName}: ${count} doküman yedeklendi`);
    } catch (err) {
      result.collections[colName] = { count: 0, status: "error", error: err.message };
      result.errors.push({ collection: colName, error: err.message });
      logger.error(`  ❌ ${colName} backup hatası:`, err.message);
    }
  }

  // Süre hesapla
  result.durationMs = Date.now() - startTime;

  const metaPayload = {
    timestamp,
    totalDocuments: result.totalDocuments,
    collectionsCount: Object.keys(result.collections).length,
    errors: result.errors.length,
    durationMs: result.durationMs,
    status: result.errors.length === 0 ? "success" : "partial",
  };

  // Metadata'yı hem backup verisi altına hem de hafif indeks node'una yaz
  await admin.database().ref(`backups/${dateKey}/_meta`).set(metaPayload);
  await admin.database().ref(`backup_index/${dateKey}`).set(metaPayload);

  // Eski backupları temizle
  await cleanOldBackups();

  logger.info(
    `✅ Backup tamamlandı: ${result.totalDocuments} doküman, ${result.durationMs}ms, ${result.errors.length} hata`
  );

  return result;
}

/**
 * MAX_BACKUP_DAYS'den eski backupları siler
 * Hafif backup_index node'u üzerinden çalışır (tüm veriyi çekmez)
 */
async function cleanOldBackups() {
  try {
    const indexRef = admin.database().ref("backup_index");
    const snapshot = await indexRef.once("value");
    const data = snapshot.val();
    if (!data) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_BACKUP_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const keysToDelete = Object.keys(data).filter((key) => key < cutoffStr);

    for (const key of keysToDelete) {
      // Hem asıl backup verisini hem de index kaydını sil
      await admin.database().ref(`backups/${key}`).remove();
      await admin.database().ref(`backup_index/${key}`).remove();
      logger.info(`🗑️ Eski backup silindi: ${key}`);
    }
  } catch (err) {
    logger.error("Eski backup temizleme hatası:", err.message);
  }
}

/**
 * Backup listesini getir (tarihler + metadata)
 * Hafif backup_index node'u kullanır — tüm veriyi çekmez
 */
async function listBackups() {
  try {
    const indexRef = admin.database().ref("backup_index");
    const snapshot = await indexRef.once("value");
    const data = snapshot.val();
    if (!data) return [];

    return Object.keys(data)
      .sort()
      .reverse()
      .map((dateKey) => ({
        date: dateKey,
        ...(data[dateKey] || {}),
      }));
  } catch (err) {
    logger.error("Backup listeleme hatası:", err.message);
    return [];
  }
}

/**
 * Belirli bir günün backupını Firebase'den çeker
 */
async function getBackupData(dateKey) {
  try {
    const ref = admin.database().ref(`backups/${dateKey}`);
    const snapshot = await ref.once("value");
    return snapshot.val();
  } catch (err) {
    logger.error("Backup getirme hatası:", err.message);
    return null;
  }
}

/**
 * Belirli bir günün backupından veritabanını geri yükle
 * ⚠️ DİKKAT: Mevcut verilerin üzerine yazar!
 * Tüm string ObjectId referanslarını (userId, senderId vb.) recursive olarak geri çevirir
 */
async function restoreBackup(dateKey, collectionsToRestore = null) {
  const backupData = await getBackupData(dateKey);
  if (!backupData) throw new Error(`${dateKey} tarihli backup bulunamadı`);

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB bağlantısı yok");

  const results = {};
  // Sadece bilinen koleksiyonları kabul et (güvenlik)
  const allowed = new Set(COLLECTIONS_TO_BACKUP);
  const targetCollections = (collectionsToRestore || COLLECTIONS_TO_BACKUP).filter(
    (c) => allowed.has(c)
  );

  for (const colName of targetCollections) {
    const colData = backupData[colName];
    if (!colData || colName === "_meta") {
      results[colName] = { status: "skipped", count: 0 };
      continue;
    }

    try {
      const docs = Object.values(colData);
      if (docs.length === 0) {
        results[colName] = { status: "empty", count: 0 };
        continue;
      }

      const collection = db.collection(colName);

      // Tüm ObjectId alanlarını recursive olarak geri çevir
      const cleanDocs = docs.map((doc) => restoreObjectIds(doc));

      // Mevcut koleksiyonu temizle ve yeni verileri ekle
      await collection.deleteMany({});
      if (cleanDocs.length > 0) {
        const batchSize = 1000;
        for (let i = 0; i < cleanDocs.length; i += batchSize) {
          const batch = cleanDocs.slice(i, i + batchSize);
          await collection.insertMany(batch, { ordered: false });
        }
      }

      results[colName] = { status: "restored", count: cleanDocs.length };
      logger.info(`  ✅ ${colName}: ${cleanDocs.length} doküman geri yüklendi`);
    } catch (err) {
      results[colName] = { status: "error", error: err.message };
      logger.error(`  ❌ ${colName} restore hatası:`, err.message);
    }
  }

  return results;
}

// ── Cron Job: Her gün 03:00 UTC ──
function start() {
  if (cronJob) return;
  cronJob = cron.schedule("0 3 * * *", async () => {
    try {
      await runBackup();
    } catch (err) {
      logger.error("Cron backup hatası:", err.message);
    }
  });
  logger.info("🔄 Backup cron başlatıldı (her gün 03:00 UTC)");
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

module.exports = {
  start,
  stop,
  runBackup,
  listBackups,
  getBackupData,
  restoreBackup,
  COLLECTIONS_TO_BACKUP,
};
