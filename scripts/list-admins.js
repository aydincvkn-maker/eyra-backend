require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const connectDB = require('../src/config/db');
const User = require('../src/models/User');
(async () => {
  await connectDB();
  const admins = await User.find({ role: { $in: ['admin', 'super_admin', 'moderator'] } }).select('username role email').lean();
  admins.forEach(u => console.log(`[${u.role}] ${u.username} - ${u.email}`));
  process.exit(0);
})();
