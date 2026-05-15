import express from 'express';
import { getPlayersForMatch, syncPlayersForMatch } from '../controllers/playerController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public route to get players for a team builder
router.get('/:matchId', getPlayersForMatch);

// Protected/Admin route to trigger a sync from the frontend
router.post('/sync/:matchId', protect, syncPlayersForMatch);

export default router;