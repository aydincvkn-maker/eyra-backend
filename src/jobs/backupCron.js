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

// Yedeklenecek koleksiyonlar (tum Mongoose modelleri)
const COLLECTIONS_TO_BACKUP = [
  "users",
  "livestreams",
  "follows",
  "visitors",
  "callhistories",
  "missions",
  "missionprogresses",
  "notifications",
  "transactions",
  "withdrawals",
  "adminmessages",
  "reports",
  "supporttickets",
  "gifts",
  "messages",
  "payments",
  "paymentevents",
  "salarypayments",
  "spinrewards",
  "systemsettings",
  "verifications",
];

const MAX_BACKUP_DAYS = 7;
const BACKUPS_ROOT = "backups";
const BACKUP_INDEX_ROOT = "backup_index";

// 24-hex ObjectId regex (referans alanlarını tespit etmek için)
const OBJECTID_RE = /^[a-f\d]{24}$/i;

let cronJob = null;

/**
 * Mongoose connection uzerinden native MongoDB Db nesnesini guvenlice al
 * Mongoose 9'da connection.db bazen undefined donebilir — getClient() fallback
 */
function getDb() {
  if (mongoose.connection.db) return mongoose.connection.db;
  // Fallback: native client uzerinden DB'ye eris
  const client = mongoose.connection.getClient();
  if (client) return client.db();
  throw new Error("MongoDB baglantisi yok (readyState=" + mongoose.connection.readyState + ")");
}

/**
 * Tek bir koleksiyonun tüm dokümanlarını çeker
 * _id sıralı cursor kullanır — skip/limit'siz güvenilir okuma
 */
async function dumpCollection(collectionName) {
  const db = getDb();
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

function createBackupId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function parseBackupTimestamp(rawTimestamp, fallbackKey = "") {
  if (typeof rawTimestamp === "string") {
    const direct = Date.parse(rawTimestamp);
    if (Number.isFinite(direct)) {
      return direct;
    }

    const legacy = rawTimestamp.replace(
      /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
      "$1:$2:$3.$4"
    );
    const legacyParsed = Date.parse(legacy);
    if (Number.isFinite(legacyParsed)) {
      return legacyParsed;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(fallbackKey)) {
    return Date.parse(`${fallbackKey}T00:00:00.000Z`);
  }

  return Number.NaN;
}

function buildMetaPayload(result, extra = {}) {
  return {
    backupId: result.backupId,
    date: result.date,
    timestamp: result.timestamp,
    totalDocuments: result.totalDocuments,
    collectionsCount: Object.keys(result.collections).length,
    errors: result.errors.length,
    durationMs: result.durationMs,
    status: result.errors.length === 0 ? "success" : "partial",
    trigger: extra.trigger || "manual",
    reason: extra.reason || null,
  };
}

async function removeDocsMissingFromBackup(collection, backupIds) {
  const backupIdSet = new Set(backupIds.map((value) => String(value)));
  const staleIds = [];
  const cursor = collection.find({}, { projection: { _id: 1 } });

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc?._id) continue;
    if (!backupIdSet.has(String(doc._id))) {
      staleIds.push(doc._id);
    }
  }

  const batchSize = 1000;
  for (let i = 0; i < staleIds.length; i += batchSize) {
    await collection.deleteMany({ _id: { $in: staleIds.slice(i, i + batchSize) } });
  }
}

async function resolveBackupId(backupKey) {
  if (!backupKey) return null;

  const directRef = admin.database().ref(`${BACKUP_INDEX_ROOT}/${backupKey}`);
  const directSnapshot = await directRef.once("value");
  if (directSnapshot.exists()) {
    return backupKey;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(backupKey)) {
    return null;
  }

  const backups = await listBackups();
  const latestMatch = backups.find((backup) => backup.date === backupKey);
  return latestMatch?.id || null;
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
async function runBackup(options = {}) {
  const startTime = Date.now();
  const now = options.now instanceof Date ? options.now : new Date();
  const timestamp = now.toISOString();
  const backupId = createBackupId(now);
  const dateKey = timestamp.slice(0, 10);

  logger.info(`🔄 Backup başlıyor: ${backupId}`);

  // Debug: Mongoose baglanti durumu
  const readyState = mongoose.connection.readyState;
  let dbName = "N/A";
  try { dbName = getDb().databaseName; } catch { /* */ }
  logger.info(`  DB durum: readyState=${readyState}, dbName=${dbName}`);

  if (readyState !== 1) {
    throw new Error(`MongoDB bagli degil (readyState=${readyState}). Backup iptal.`);
  }

  const result = {
    backupId,
    timestamp,
    date: dateKey,
    collections: {},
    totalDocuments: 0,
    errors: [],
    durationMs: 0,
  };

  for (const colName of COLLECTIONS_TO_BACKUP) {
    try {
      const db = getDb();
      const collection = db.collection(colName);
      const docs = await collection.find({}).sort({ _id: 1 }).toArray();
      const count = docs.length;

      const ref = admin.database().ref(`${BACKUPS_ROOT}/${backupId}/${colName}`);
      await ref.set(null);

      if (count === 0) {
        await ref.set({});
        result.collections[colName] = { count: 0, status: "empty" };
        continue;
      }

      result.collections[colName] = { count: docs.length, status: "ok" };
      result.totalDocuments += docs.length;

      if (count > 0) {
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

  const metaPayload = buildMetaPayload(result, options);

  await admin.database().ref(`${BACKUPS_ROOT}/${backupId}/_meta`).set(metaPayload);
  await admin.database().ref(`${BACKUP_INDEX_ROOT}/${backupId}`).set(metaPayload);

  await cleanOldBackups();

  logger.info(
    `✅ Backup tamamlandı: ${result.totalDocuments} doküman, ${result.durationMs}ms, ${result.errors.length} hata`
  );

  return {
    ...result,
    status: metaPayload.status,
  };
}

/**
 * MAX_BACKUP_DAYS'den eski backupları siler
 * Hafif backup_index node'u üzerinden çalışır (tüm veriyi çekmez)
 */
async function cleanOldBackups() {
  try {
    const indexRef = admin.database().ref(BACKUP_INDEX_ROOT);
    const snapshot = await indexRef.once("value");
    const data = snapshot.val();
    if (!data) return;

    const cutoffMs = Date.now() - MAX_BACKUP_DAYS * 24 * 60 * 60 * 1000;
    const keysToDelete = Object.entries(data)
      .filter(([key, meta]) => {
        const parsed = parseBackupTimestamp(meta?.timestamp, key);
        return Number.isFinite(parsed) && parsed < cutoffMs;
      })
      .map(([key]) => key);

    for (const key of keysToDelete) {
      await admin.database().ref(`${BACKUPS_ROOT}/${key}`).remove();
      await admin.database().ref(`${BACKUP_INDEX_ROOT}/${key}`).remove();
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
    const indexRef = admin.database().ref(BACKUP_INDEX_ROOT);
    const snapshot = await indexRef.once("value");
    const data = snapshot.val();
    if (!data) return [];

    return Object.entries(data)
      .map(([backupId, meta]) => ({
        id: backupId,
        date: meta?.date || String(backupId).slice(0, 10),
        ...(meta || {}),
      }))
      .sort((left, right) => {
        const leftTs = parseBackupTimestamp(left.timestamp, String(left.id));
        const rightTs = parseBackupTimestamp(right.timestamp, String(right.id));
        if (Number.isFinite(leftTs) && Number.isFinite(rightTs)) {
          return rightTs - leftTs;
        }
        return String(right.id).localeCompare(String(left.id));
      });
  } catch (err) {
    logger.error("Backup listeleme hatası:", err.message);
    return [];
  }
}

/**
 * Belirli bir günün backupını Firebase'den çeker
 */
async function getBackupData(backupKey) {
  try {
    const resolvedBackupId = await resolveBackupId(backupKey);
    if (!resolvedBackupId) {
      return null;
    }

    const ref = admin.database().ref(`${BACKUPS_ROOT}/${resolvedBackupId}`);
    const snapshot = await ref.once("value");
    return {
      backupId: resolvedBackupId,
      data: snapshot.val(),
    };
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
async function restoreBackup(backupKey, collectionsToRestore = null) {
  const backupSnapshot = await getBackupData(backupKey);
  if (!backupSnapshot?.data) throw new Error(`${backupKey} anahtarlı backup bulunamadı`);

  const { backupId, data: backupData } = backupSnapshot;

  const safetyBackup = await runBackup({
    trigger: "restore_guard",
    reason: `pre_restore:${backupId}`,
  });
  if (safetyBackup.errors.length > 0) {
    throw new Error(
      `Restore iptal edildi. Koruma yedeği eksik alındı (${safetyBackup.backupId}).`
    );
  }

  const db = getDb();

  const results = {
    backupId,
    restoredFrom: backupId,
    safetyBackupId: safetyBackup.backupId,
    collections: {},
    errors: [],
  };

  const allowed = new Set(COLLECTIONS_TO_BACKUP);
  const targetCollections = (collectionsToRestore || COLLECTIONS_TO_BACKUP).filter(
    (c) => allowed.has(c)
  );

  for (const colName of targetCollections) {
    const colData = backupData[colName];

    try {
      const collection = db.collection(colName);

      if (!colData || colName === "_meta") {
        await collection.deleteMany({});
        results.collections[colName] = { status: "restored", count: 0 };
        logger.info(`  ✅ ${colName}: 0 doküman geri yüklendi`);
        continue;
      }

      const docs = Object.values(colData);
      const cleanDocs = docs.map((doc) => restoreObjectIds(doc));
      const backupIds = cleanDocs
        .map((doc) => doc?._id)
        .filter((value) => value !== undefined && value !== null);

      if (cleanDocs.length > 0) {
        const batchSize = 500;
        for (let i = 0; i < cleanDocs.length; i += batchSize) {
          const batch = cleanDocs.slice(i, i + batchSize);
          const operations = batch.map((doc) => ({
            replaceOne: {
              filter: { _id: doc._id },
              replacement: doc,
              upsert: true,
            },
          }));
          await collection.bulkWrite(operations, { ordered: false });
        }
      }

      if (backupIds.length > 0) {
        await removeDocsMissingFromBackup(collection, backupIds);
      } else {
        await collection.deleteMany({});
      }

      results.collections[colName] = { status: "restored", count: cleanDocs.length };
      logger.info(`  ✅ ${colName}: ${cleanDocs.length} doküman geri yüklendi`);
    } catch (err) {
      results.collections[colName] = { status: "error", error: err.message };
      results.errors.push({ collection: colName, error: err.message });
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
      await runBackup({
        trigger: "cron",
        reason: "scheduled:03:00UTC",
      });
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
