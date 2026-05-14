const fs = require('fs');
let content = fs.readFileSync('c:/Users/Casper/Desktop/eyra-backend/src/controllers/userController.js', 'utf8');

const oldStr = '    await User.findByIdAndDelete(userId);\r\n\r\n    logger.info';
const insert = [
  '',
  '    // Firebase Auth kullanicisini da sil - email ve/veya telefon numarasina gore',
  '    try {',
  '      const admin = require("firebase-admin");',
  '      if (admin.apps.length) {',
  '        const firebaseDeletePromises = [];',
  '        if (user.email) {',
  '          firebaseDeletePromises.push(',
  '            admin.auth().getUserByEmail(user.email)',
  '              .then((fbUser) => admin.auth().deleteUser(fbUser.uid))',
  '              .catch((e) => logger.warn("Firebase email silme basarisiz (" + user.email + "): " + e.message))',
  '          );',
  '        }',
  '        if (user.phone) {',
  '          firebaseDeletePromises.push(',
  '            admin.auth().getUserByPhoneNumber(user.phone)',
  '              .then((fbUser) => admin.auth().deleteUser(fbUser.uid))',
  '              .catch(() => {})',
  '          );',
  '        }',
  '        await Promise.all(firebaseDeletePromises);',
  '      }',
  '    } catch (_) {}',
  '',
  '    logger.info',
].join('\r\n');

const newStr = '    await User.findByIdAndDelete(userId);\r\n' + insert;

if (content.includes(oldStr)) {
  content = content.replace(oldStr, newStr);
  fs.writeFileSync('c:/Users/Casper/Desktop/eyra-backend/src/controllers/userController.js', content, 'utf8');
  console.log('OK');
} else {
  console.log('NOT FOUND');
}
