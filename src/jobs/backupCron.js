// src/jobs/backupCron.js
// ═══════════════════════════════════════════════════════════════
// Otomatik MongoDB Backup Sistemi
// - Her gün 03:00'te tüm kritik koleksiyonları JSON olarak yedekler
// - Firebase Realtime Database'e yazar (kalıcı, uzak depolama)
// - Son 7 günlük backup tutar, eskilerini siler
// - Manuel tetikleme: /api/admin/backup endpoint'i ile
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

let cronJob = null;

/**
 * Tek bir koleksiyonun tüm dokümanlarını çeker
 */
async function dumpCollection(collectionName) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB bağlantısı yok");

  const collection = db.collection(collectionName);
  const count = await collection.countDocuments();

  if (count === 0) return { count: 0, docs: [] };

  // Büyük koleksiyonlarda batch halinde çek (memory overflow önlemi)
  const BATCH_SIZE = 500;
  const docs = [];
  let skip = 0;

  while (skip < count) {
    const batch = await collection
      .find({})
      .skip(skip)
      .limit(BATCH_SIZE)
      .toArray();
    docs.push(...batch);
    skip += BATCH_SIZE;
  }

  return { count: docs.length, docs };
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
      if (count > 0) {
        const ref = admin.database().ref(`backups/${dateKey}/${colName}`);
        // Büyük veri için chunk'lar halinde yaz
        if (count > 200) {
          const chunkSize = 200;
          for (let i = 0; i < docs.length; i += chunkSize) {
            const chunk = docs.slice(i, i + chunkSize);
            const chunkData = {};
            chunk.forEach((doc, idx) => {
              chunkData[`${i + idx}`] = JSON.parse(JSON.stringify(doc));
            });
            await ref.update(chunkData);
          }
        } else {
          const data = {};
          docs.forEach((doc, idx) => {
            data[`${idx}`] = JSON.parse(JSON.stringify(doc));
          });
          await ref.set(data);
        }
      }

      logger.info(`  ✅ ${colName}: ${count} doküman yedeklendi`);
    } catch (err) {
      result.collections[colName] = { count: 0, status: "error", error: err.message };
      result.errors.push({ collection: colName, error: err.message });
      logger.error(`  ❌ ${colName} backup hatası:`, err.message);
    }
  }

  // Metadata yaz
  result.durationMs = Date.now() - startTime;
  const metaRef = admin.database().ref(`backups/${dateKey}/_meta`);
  await metaRef.set({
    timestamp,
    totalDocuments: result.totalDocuments,
    collectionsCount: Object.keys(result.collections).length,
    errors: result.errors.length,
    durationMs: result.durationMs,
    status: result.errors.length === 0 ? "success" : "partial",
  });

  // Eski backupları temizle
  await cleanOldBackups();

  logger.info(
    `✅ Backup tamamlandı: ${result.totalDocuments} doküman, ${result.durationMs}ms, ${result.errors.length} hata`
  );

  return result;
}

/**
 * MAX_BACKUP_DAYS'den eski backupları siler
 */
async function cleanOldBackups() {
  try {
    const ref = admin.database().ref("backups");
    const snapshot = await ref.once("value");
    const data = snapshot.val();
    if (!data) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_BACKUP_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const keysToDelete = Object.keys(data).filter(
      (key) => key < cutoffStr && key !== "_meta"
    );

    for (const key of keysToDelete) {
      await ref.child(key).remove();
      logger.info(`🗑️ Eski backup silindi: ${key}`);
    }
  } catch (err) {
    logger.error("Eski backup temizleme hatası:", err.message);
  }
}

/**
 * Backup listesini getir (tarihler + metadata)
 */
async function listBackups() {
  try {
    const ref = admin.database().ref("backups");
    const snapshot = await ref.once("value");
    const data = snapshot.val();
    if (!data) return [];

    return Object.keys(data)
      .filter((k) => k !== "_meta")
      .sort()
      .reverse()
      .map((dateKey) => {
        const meta = data[dateKey]?._meta || {};
        return {
          date: dateKey,
          ...meta,
        };
      });
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
 */
async function restoreBackup(dateKey, collectionsToRestore = null) {
  const backupData = await getBackupData(dateKey);
  if (!backupData) throw new Error(`${dateKey} tarihli backup bulunamadı`);

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB bağlantısı yok");

  const results = {};
  const targetCollections = collectionsToRestore || COLLECTIONS_TO_BACKUP;

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

      // _id alanlarını ObjectId'ye geri çevir
      const cleanDocs = docs.map((doc) => {
        const clean = { ...doc };
        if (clean._id && typeof clean._id === "string") {
          try {
            clean._id = new mongoose.Types.ObjectId(clean._id);
          } catch {
            // Geçersiz ObjectId ise olduğu gibi bırak
          }
        }
        return clean;
      });

      // Mevcut koleksiyonu temizle ve yeni verileri ekle
      await collection.deleteMany({});
      if (cleanDocs.length > 0) {
        // Batch insert (1000'lik gruplar halinde)
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
