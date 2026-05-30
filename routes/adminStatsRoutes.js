import express from 'express';
import User from '../models/User.js';
import Room from '../models/Room.js';
import FantasyTeam from '../models/FantasyTeam.js';
import Match from '../models/Match.js';

const router = express.Router();

// Get dashboard statistics
router.get('/', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeRooms = await Room.countDocuments(); // All rooms created
    const fantasyTeams = await FantasyTeam.countDocuments();
    
    // Live matches based on Match schema status enum ('Upcoming', 'Live', 'Finished')
    const liveMatches = await Match.countDocuments({ status: 'Live' });

    res.json({
      totalUsers,
      activeRooms,
      fantasyTeams,
      liveMatches
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ message: 'Server error fetching dashboard stats' });
  }
});

export default router;
