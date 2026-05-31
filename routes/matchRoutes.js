import express from 'express';
import { getMatches, manualCleanup, proxyFootballData, simulateLiveEvent, syncMatches } from '../controllers/matchController.js';

const router = express.Router();

router.get('/', getMatches);
router.get('/proxy/:resource', proxyFootballData);
router.post('/simulate', simulateLiveEvent);
router.post('/sync', syncMatches);
router.post('/cleanup', manualCleanup);


export default router;
