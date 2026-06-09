import express from 'express';
import {
  registerUser,
  loginUser,
  getUserProfile,
  getUserProfileDashboard,
  claimTaskReward,
  getShopOverview,
  updateProfilePicture,
  updateUserProfile,
  exchangeShopJersey,
  createShopPurchaseRequest,
  deleteUserProfile,
  markNotificationsRead,
  purchaseShopBackground,
  setActiveBackground,
  adminAddShopBackground
} from '../controllers/authController.js';
import { protect, admin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/profile/dashboard', protect, getUserProfileDashboard);
router.post('/tasks/claim', protect, claimTaskReward);
router.get('/shop', protect, getShopOverview);
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, updateUserProfile);
router.put('/profile-picture', protect, updateProfilePicture);
router.delete('/profile', protect, deleteUserProfile);
router.post('/shop/exchange-jersey', protect, exchangeShopJersey);
router.post('/shop/purchase-request', protect, createShopPurchaseRequest);
router.put('/notifications/read', protect, markNotificationsRead);
router.post('/shop/purchase-background', protect, purchaseShopBackground);
router.put('/profile/background', protect, setActiveBackground);
router.post('/admin/shop/background', protect, admin, adminAddShopBackground);

export default router;
