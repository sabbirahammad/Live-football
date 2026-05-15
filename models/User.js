import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  profilePicture: { type: String, default: '' },
  shippingAddress: { type: String, default: '' },
  totalPoints: { type: Number, default: 0 },
  weeklyPoints: { type: Number, default: 0 },
  globalRank: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  coinBalance: { type: Number, default: 500 },
  lastDailyClaim: { type: Date },
  claimedTasks: { type: Array, default: [] },
  dailyStreak: { type: Number, default: 0 },
  referredByCode: { type: String, default: null },
  referralBonusPaid: { type: Boolean, default: false },
  referralCount: { type: Number, default: 0 },
  ownedJerseys: [
    {
      jerseyId: { type: String, required: true },
      name: { type: String, required: true },
      country: { type: String, required: true },
      size: { type: String, required: true },
      shippingAddress: { type: String, required: true },
      phoneNumber: { type: String, required: true },
      costCoins: { type: Number, default: 700 },
      claimedAt: { type: Date, default: Date.now },
    },
  ],
  purchaseRequests: [
    {
      packId: { type: String, required: true },
      packTitle: { type: String, required: true },
      paymentMethod: { type: String, enum: ['bkash', 'nagad'], required: true },
      paymentReference: { type: String, required: true },
      amountLabel: { type: String, required: true },
      coins: { type: Number, required: true },
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      submittedAt: { type: Date, default: Date.now },
    },
  ],
}, { timestamps: true });

// Performance Indexes for Leaderboard Sorting
userSchema.index({ totalPoints: -1, coinBalance: -1, _id: 1 });
userSchema.index({ weeklyPoints: -1, totalPoints: -1, coinBalance: -1, _id: 1 });

const User = mongoose.model('User', userSchema);
export default User;
