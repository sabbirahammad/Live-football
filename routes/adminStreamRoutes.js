import express from 'express';
import { getManualStreams, addManualStream, deleteManualStream, toggleStreamStatus } from '../controllers/adminStreamController.js';

const router = express.Router();

router.get('/:matchId', getManualStreams);
router.post('/', addManualStream);
router.delete('/:streamId', deleteManualStream);
router.put('/toggle/:streamId', toggleStreamStatus);

export default router;