require("dotenv").config();
const mongoose = require("mongoose");
const SupportTicket = require("../src/models/SupportTicket");

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log("MongoDB bağlandı");

  const result = await SupportTicket.updateMany(
    { deletedByAdmin: true },
    { $set: { deletedByAdmin: false }, $unset: { deletedByAdminAt: "" } }
  );
  console.log("Güncellenen ticket sayısı:", result.modifiedCount);

  const all = await SupportTicket.find({}).lean();
  console.log("Mevcut tüm ticketlar:");
  all.forEach((t) => {
    console.log(
      `  id: ${t._id} | status: ${t.status} | deletedByAdmin: ${t.deletedByAdmin} | msg: ${t.message?.slice(0, 30)}`
    );
  });

  await mongoose.disconnect();
  console.log("Bitti.");
}

run().catch(console.error);
