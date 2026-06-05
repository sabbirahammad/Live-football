import express from 'express';
import { getShopItems, buyShopItem, addShopItem, deleteShopItem } from '../controllers/shopController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = express.Router();

// User routes
router.get('/', authenticate, getShopItems);
router.post('/buy/:itemId', authenticate, buyShopItem);

// Admin routes (basic protection can be added later)
router.post('/add', addShopItem);
router.delete('/:itemId', deleteShopItem);

export default router;