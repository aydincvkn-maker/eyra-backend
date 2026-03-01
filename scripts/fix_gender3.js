const fs = require('fs');

const filePath = './userController.js';
const content = fs.readFileSync(filePath, 'utf-8');

// Daha kısa pattern - lines 75-76'dan sonra yeni else ekle
const searchStr = `      } else if (currentUser && currentUser.gender === "female") {
        // Kadınlar hem erkekleri hem de kadınları görebilir
        query.gender = { $in: ["male", "female"] };
      }
    } else {`;

const replaceStr = `      } else if (currentUser && currentUser.gender === "female") {
        // Kadınlar hem erkekleri hem de kadınları görebilir
        query.gender = { $in: ["male", "female"] };
      } else {
        // "other" cinsiyet veya bilinmeyen: SADECE kadınları görebilir (misafir gibi davran)
        query.gender = "female";
      }
    } else {`;

const newContent = content.replace(searchStr, replaceStr);

if (newContent !== content) {
  // Şimdi isGuest kontrolünü ekle
  const searchStr2 = `    const users = await User.find(query)
      .select("-password -refreshToken")`;
  
  const replaceStr2 = `    // ✅ Guest kullanıcıları hariç tut
    query.isGuest = { $ne: true };

    const users = await User.find(query)
      .select("-password -refreshToken")`;
  
  const finalContent = newContent.replace(searchStr2, replaceStr2);
  
  fs.writeFileSync(filePath, finalContent, 'utf-8');
  console.log('✅ userController.js başarıyla güncellendi');
  console.log('✨ Değişiklikler:');
  console.log('   ✓ "other" gender için SADECE female görebilir');
  console.log('   ✓ isGuest kontrolü eklendi');
} else {
  console.log('⚠️ Arama paterni bulunamadı - dosya manuel kontrol gerekebilir');
  console.log('Content length:', content.length);
}
