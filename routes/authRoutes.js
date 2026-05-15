import express from 'express';
import {
  registerUser,
  loginUser,
  getUserProfile,
  getUserProfileDashboard,
  claimTaskReward,
  getShopOverview,
  updateProfilePicture,
  exchangeShopJersey,
  createShopPurchaseRequest,
  deleteUserProfile,
  markNotificationsRead,
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/profile/dashboard', protect, getUserProfileDashboard);
router.post('/tasks/claim', protect, claimTaskReward);
router.get('/shop', protect, getShopOverview);
router.get('/profile', protect, getUserProfile);
router.put('/profile-picture', protect, updateProfilePicture);
router.delete('/profile', protect, deleteUserProfile);
router.post('/shop/exchange-jersey', protect, exchangeShopJersey);
router.post('/shop/purchase-request', protect, createShopPurchaseRequest);
router.put('/notifications/read', protect, markNotificationsRead);

export default router;
