// src/jobs/salaryCron.js
/**
 * Haftalık Maaş Cron İşi
 *
 * Her Pazartesi 00:05 UTC'de çalışır.
 * Geçen haftanın (Pzt→Pzr) performansına göre maaş hesaplar ve öder.
 *
 * Kullanım:
 *   const salaryCron = require('./jobs/salaryCron');
 *   salaryCron.start();   // Cron'u başlat
 *   salaryCron.stop();    // Cron'u durdur (graceful shutdown için)
 *   salaryCron.runNow();  // Manuel tetikle (test/admin için)
 */

const cron = require("node-cron");
const { processAllWeeklySalaries } = require("../services/salaryService");

let scheduledTask = null;
let isRunning = false;

/**
 * Maaş işleme cron'unu başlat
 * Schedule: Her Pazartesi 00:05 UTC
 * Cron expression: "5 0 * * 1" → dakika:5, saat:0, gün:*, ay:*, haftanın günü:1(Pazartesi)
 */
function start() {
  if (scheduledTask) {
    console.log("[SALARY-CRON] Zaten çalışıyor, tekrar başlatılmadı");
    return;
  }

  // Her Pazartesi 00:05 UTC
  scheduledTask = cron.schedule("5 0 * * 1", async () => {
    if (isRunning) {
      console.log("[SALARY-CRON] Önceki işlem hâlâ devam ediyor, atlanıyor");
      return;
    }

    isRunning = true;
    console.log(`[SALARY-CRON] Haftalık maaş işleme tetiklendi — ${new Date().toISOString()}`);

    try {
      const results = await processAllWeeklySalaries();
      console.log(`[SALARY-CRON] Tamamlandı — ${results.paid} ödeme, $${results.totalUSD} toplam`);
    } catch (err) {
      console.error("[SALARY-CRON] HATA:", err);
    } finally {
      isRunning = false;
    }
  }, {
    timezone: "UTC",
    scheduled: true,
  });

  console.log("[SALARY-CRON] Haftalık maaş cron başlatıldı (Her Pazartesi 00:05 UTC)");
}

/**
 * Cron'u durdur — graceful shutdown için
 */
function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[SALARY-CRON] Durduruldu");
  }
}

/**
 * Manuel tetikleme — admin/test için
 * @param {Date} [referenceDate] - Farklı bir tarih bazında hesaplama (test için)
 */
async function runNow(referenceDate) {
  if (isRunning) {
    return { error: true, message: "Maaş işleme zaten devam ediyor" };
  }

  isRunning = true;
  console.log(`[SALARY-CRON] Manuel tetikleme — ${new Date().toISOString()}`);

  try {
    const results = await processAllWeeklySalaries(referenceDate);
    return { success: true, results };
  } catch (err) {
    console.error("[SALARY-CRON] Manuel tetikleme HATA:", err);
    return { error: true, message: err.message };
  } finally {
    isRunning = false;
  }
}

module.exports = { start, stop, runNow };
