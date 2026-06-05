import express from 'express';
import { getShopItems, buyShopItem, addShopItem, deleteShopItem } from '../controllers/shopController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// User routes
router.get('/', protect, getShopItems);
router.post('/buy/:itemId', protect, buyShopItem);

// Admin routes (basic protection can be added later)
router.post('/add', addShopItem);
router.delete('/:itemId', deleteShopItem);

export default router;