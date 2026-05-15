import express from 'express';
import { getMatches, simulateLiveEvent, syncMatches } from '../controllers/matchController.js';

const router = express.Router();

router.get('/', getMatches);
router.post('/simulate', simulateLiveEvent);
router.post('/sync', syncMatches);

export default router;
