import express from 'express';
import { getMatches, proxyFootballData, simulateLiveEvent, syncMatches } from '../controllers/matchController.js';

const router = express.Router();

router.get('/', getMatches);
router.get('/proxy/:resource', proxyFootballData);
router.post('/simulate', simulateLiveEvent);
router.post('/sync', syncMatches);

export default router;
