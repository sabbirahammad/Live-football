import express from 'express';
import { checkStreamHealth, getMatchStreams, refreshMatchStreams, reportStreamTelemetry } from '../controllers/streamController.js';

const router = express.Router();

router.get('/health', checkStreamHealth);
router.post('/telemetry', reportStreamTelemetry);
router.get('/:matchId', getMatchStreams);
router.post('/refresh/:matchId', refreshMatchStreams);

export default router;