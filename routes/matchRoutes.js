import express from 'express';
import { getMatches, manualCleanup, proxyFootballData, simulateLiveEvent, syncMatches, getAllowedLeagues, addAllowedLeague, removeAllowedLeague } from '../controllers/matchController.js';

const router = express.Router();

router.get('/', getMatches);
router.get('/proxy/:resource', proxyFootballData);
router.post('/simulate', simulateLiveEvent);
router.post('/sync', syncMatches);
router.post('/cleanup', manualCleanup);

// Manual League Allowance Routes
router.get('/allowed-leagues', getAllowedLeagues);
router.post('/allowed-leagues', addAllowedLeague);
router.delete('/allowed-leagues/:id', removeAllowedLeague);

export default router;
