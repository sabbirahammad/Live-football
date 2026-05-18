import express from 'express';
import { getStreamHealth, getStreamsForMatch, refreshStreamsForMatch } from '../controllers/streamController.js';

const router = express.Router();

router.get('/health', getStreamHealth);
router.get('/:fixtureId', getStreamsForMatch);
router.post('/refresh/:fixtureId', refreshStreamsForMatch);

export default router;
