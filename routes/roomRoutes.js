import express from 'express';
import { createRoom, getMyRooms, getPublicRooms, getRoomLeaderboard, joinRoom } from '../controllers/roomController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', protect, getMyRooms);
router.get('/public', protect, getPublicRooms);
router.get('/:roomId/leaderboard', protect, getRoomLeaderboard);
router.post('/create', protect, createRoom);
router.post('/join', protect, joinRoom);

export default router;
