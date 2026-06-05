import express from 'express';
// লজিক যেহেতু authController এ আছে, এখান থেকে ইম্পোর্ট করা ভালো অথবা shopController এ মুভ করা ভালো
import { getShopOverview as getShopItems, purchaseShopBackground as buyShopItem } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// User routes
router.get('/', protect, getShopItems);
router.post('/buy/:itemId', protect, buyShopItem);

// Admin routes (basic protection can be added later)
router.post('/add', addShopItem);
router.delete('/:itemId', deleteShopItem);

export default router;