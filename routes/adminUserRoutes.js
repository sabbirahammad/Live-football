import express from 'express';
import User from '../models/User.js';

const router = express.Router();

// Get all users (Admin only route theoretically)
router.get('/', async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Server error fetching users' });
  }
});

export default router;
