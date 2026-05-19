/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const connectDB = require('../src/config/db');
const User = require('../src/models/User');

(async () => {
  try {
    await connectDB();
    const users = await User.find({
      $or: [
        { email: { $regex: 'aydincvkn', $options: 'i' } },
        { username: { $regex: 'aydincvkn', $options: 'i' } },
      ],
    }).select('_id email username role accountScope isOwner authProvider createdAt').lean();
    console.log(`Bulunan: ${users.length}`);
    users.forEach((u) => console.log(u));
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
