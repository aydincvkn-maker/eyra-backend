require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const User = require('../src/models/User');
  const Transaction = require('../src/models/Transaction');
  const Payment = require('../src/models/Payment');

  const userId = '6a023fb0babbeb846a364fae';
  const coins = 500;

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { coins } },
    { new: true, select: 'coins username' }
  );

  await Transaction.create({
    user: userId,
    type: 'purchase',
    amount: coins,
    balanceAfter: user.coins,
    status: 'completed',
    description: 'eyra_coins_500 satin alindi (manuel telafi - RC senkron hatasi)',
    metadata: { manual: true, reason: 'rc_sync_failure', productId: 'eyra_coins_500' }
  });

  console.log('DONE - username:', user.username, '- new coins:', user.coins);
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
