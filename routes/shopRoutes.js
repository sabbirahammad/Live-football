import express from 'express';
// Import the admin-specific function and alias it to match your route usage
import { getShopOverview as getShopItems, purchaseShopBackground as buyShopItem, adminAddShopBackground as addShopItem } from '../controllers/authController.js';
import { protect, admin } from '../middleware/authMiddleware.js';

const router = express.Router();

// User routes
router.get('/', protect, getShopItems);
router.post('/buy/:itemId', protect, buyShopItem);

// Admin routes - protected by both 'protect' and 'admin' middleware
router.post('/add', protect, admin, addShopItem);

export default router;