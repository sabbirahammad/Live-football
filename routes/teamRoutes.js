import express from 'express';
import { saveTeam, getMyTeam, getMyTeamsMap, getUserTeamByMatch, getTeamByIdForView } from '../controllers/teamController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/save', protect, saveTeam);
router.get('/my-teams', protect, getMyTeamsMap);
router.get('/my-team/:matchId', protect, getMyTeam);
router.get('/:teamId/view', protect, getTeamByIdForView);
router.get('/user/:userId/match/:matchId', protect, getUserTeamByMatch);

export default router;
