const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'userController.js');
let content = fs.readFileSync(filePath, 'utf-8');

// getFemaleUsers fonksiyonunun gender filtering kısmını düzelt
const oldCode = `      if (currentUser && currentUser.gender === "male") {
        // Erkekler SADECE kadınları görebilir
        query.gender = "female";
      } else if (currentUser && currentUser.gender === "female") {
        // Kadınlar hem erkekleri hem de kadınları görebilir
        query.gender = { $in: ["male", "female"] };
      }
    } else {
      // Misafir kullanıcılar sadece kadınları görebilir
      query.gender = "female";
    }`;

const newCode = `      if (currentUser && currentUser.gender === "male") {
        // Erkekler SADECE kadınları görebilir
        query.gender = "female";
      } else if (currentUser && currentUser.gender === "female") {
        // Kadınlar hem erkekleri hem de kadınları görebilir
        query.gender = { $in: ["male", "female"] };
      } else {
        // "other" cinsiyet veya bilinmeyen: SADECE kadınları görebilir (misafir gibi davran)
        query.gender = "female";
      }
    } else {
      // Anonim/misafir kullanıcılar: sadece kadınları görebilir
      query.gender = "female";
    }

    // ✅ Guest kullanıcıları ve banned olanları hariç tut
    if (!query.isGuest) {
      query.isGuest = { $ne: true };
    }`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('✅ userController.js başarıyla güncellendi - Gender filtering düzeltildi');
} else {
  console.log('⚠️ Eski kod bulunamadı - Manual kontrol gerekebilir');
}
