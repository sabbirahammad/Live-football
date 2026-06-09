import express from 'express';
import { getMatches, manualCleanup, proxyFootballData, simulateLiveEvent, syncMatches, getAllowedLeagues, addAllowedLeague, removeAllowedLeague, setFeaturedMatch } from '../controllers/matchController.js';
import { protect, admin } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getMatches);
router.get('/proxy/:resource', proxyFootballData);
router.post('/simulate', simulateLiveEvent);
router.post('/sync', syncMatches);
router.post('/cleanup', manualCleanup);
router.put('/featured/:id', setFeaturedMatch);

// Manual League Allowance Routes
router.get('/allowed-leagues', getAllowedLeagues);
router.post('/allowed-leagues', addAllowedLeague);
router.delete('/allowed-leagues/:id', removeAllowedLeague);

export default router;
