import express from 'express';
import { getPlayers, getPlayersForMatch, syncPlayersForMatch } from '../controllers/playerController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getPlayers);
router.get('/:matchId', getPlayersForMatch);
router.post('/sync/:matchId', protect, syncPlayersForMatch);

export default router;
