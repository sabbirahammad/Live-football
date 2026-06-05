import mongoose from 'mongoose';

const shopItemSchema = new mongoose.Schema({
  title: { type: String, required: true },
  imageUrl: { type: String, required: true },
  costCoins: { type: Number, default: 50 },
  type: { type: String, default: 'background' }, // could be 'background', 'flag', etc.
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const ShopItem = mongoose.model('ShopItem', shopItemSchema);
export default ShopItem;
