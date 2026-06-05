import ShopItem from '../models/ShopItem.js';
import User from '../models/User.js';

export const getShopItems = async (req, res) => {
  try {
    const items = await ShopItem.find({ isActive: true });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching shop items', error: error.message });
  }
};

export const buyShopItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.user.id; // from authenticate middleware

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const item = await ShopItem.findById(itemId);
    if (!item) return res.status(404).json({ message: 'Item not found' });

    // Check if user already owns it
    if (user.unlockedBackgrounds.includes(item.imageUrl)) {
      return res.status(400).json({ message: 'You already own this item' });
    }

    // Check if user has enough coins
    if (user.coinBalance < item.costCoins) {
      return res.status(400).json({ message: 'Not enough coins' });
    }

    // Deduct coins and add item
    user.coinBalance -= item.costCoins;
    user.unlockedBackgrounds.push(item.imageUrl);
    await user.save();

    res.json({ message: 'Item purchased successfully', user, item });
  } catch (error) {
    res.status(500).json({ message: 'Error purchasing item', error: error.message });
  }
};

export const addShopItem = async (req, res) => {
  try {
    const { title, imageUrl, costCoins, type } = req.body;
    const newItem = new ShopItem({ title, imageUrl, costCoins, type });
    await newItem.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(500).json({ message: 'Error adding shop item', error: error.message });
  }
};

export const deleteShopItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    await ShopItem.findByIdAndDelete(itemId);
    res.json({ message: 'Item deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting shop item', error: error.message });
  }
};
