import express from 'express';
import { getLeaderboard, getMatchLeaderboard, getMyLeaderboardStats, getWeeklyLeaderboard } from '../controllers/leaderboardController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getLeaderboard);
router.get('/me', protect, getMyLeaderboardStats);
router.get('/weekly', getWeeklyLeaderboard);
router.get('/match/:matchId', getMatchLeaderboard);

export default router;
