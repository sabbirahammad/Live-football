import express from 'express';
import { protect, admin } from '../middleware/authMiddleware.js';
import {
  getPendingPurchaseRequests,
  updatePurchaseRequestStatus,
} from '../controllers/adminPaymentController.js';

const router = express.Router();

// All routes here are protected by 'admin' middleware
router.get('/requests/pending', protect, admin, getPendingPurchaseRequests);
router.put('/requests/:userId/:requestId', protect, admin, updatePurchaseRequestStatus);

export default router;