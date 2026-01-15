const fs = require('fs');

const filePath = './userController.js';
const content = fs.readFileSync(filePath, 'utf-8');

// Problematic section - find and replace exactly
const searchStr = `      }
    } else {
      // Misafir kullanıcılar sadece kadınları görebilir
      query.gender = "female";
    }

    const users = await User.find(query)`;

const replaceStr = `      } else {
        // "other" cinsiyet veya bilinmeyen: SADECE kadınları görebilir (misafir gibi davran)
        query.gender = "female";
      }
    } else {
      // Anonim/misafir kullanıcılar: sadece kadınları görebilir
      query.gender = "female";
    }

    // ✅ Guest kullanıcıları hariç tut
    query.isGuest = { $ne: true };

    const users = await User.find(query)`;

const newContent = content.replace(searchStr, replaceStr);

if (newContent !== content) {
  fs.writeFileSync(filePath, newContent, 'utf-8');
  console.log('✅ userController.js başarıyla güncellendi');
  console.log('✨ Gender filtering düzeltildi:');
  console.log('   - "other" gender için SADECE female görebilir');
  console.log('   - isGuest kontrolü eklendi');
} else {
  console.log('⚠️ Arama paterni bulunamadı');
  console.log('Dosya manuel kontrol gerekebilir');
}
