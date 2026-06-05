import express from 'express';
import { getUpdateInfo, updateAppConfig } from '../controllers/appConfigController.js';
import { protect, admin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/update', getUpdateInfo);
router.put('/update', protect, admin, updateAppConfig);

export default router;