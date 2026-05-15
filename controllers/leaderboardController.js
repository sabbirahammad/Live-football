import User from '../models/User.js';
import FantasyTeam from '../models/FantasyTeam.js';
import Room from '../models/Room.js';
import Match from '../models/Match.js';

const GLOBAL_SORT = { totalPoints: -1, coinBalance: -1, _id: 1 };
const WEEKLY_SORT = { weeklyPoints: -1, totalPoints: -1, coinBalance: -1, _id: 1 };
const MATCH_SORT = { totalPoints: -1, createdAt: 1, _id: 1 };

const mapUserLeaderboard = (users, pointsKey) =>
  users.map((user, index) => ({
    _id: user._id,
    name: user.name,
    profilePicture: user.profilePicture || '',
    globalRank: user.globalRank || 0,
    rank: index + 1,
    pts: user[pointsKey] || 0,
  }));

const mapTeamLeaderboard = (teams) =>
  teams.map((team, index) => ({
    _id: team.user?._id || `team-${team._id}`,
    teamId: team._id,
    name: team.user?.name || 'Unknown User',
    profilePicture: team.user?.profilePicture || '',
    globalRank: team.user?.globalRank || 0,
    rank: index + 1,
    pts: team.totalPoints || 0,
  }));

const getGlobalRankQuery = (user) => ({
  $or: [
    { totalPoints: { $gt: user.totalPoints || 0 } },
    { totalPoints: user.totalPoints || 0, coinBalance: { $gt: user.coinBalance || 0 } },
    { totalPoints: user.totalPoints || 0, coinBalance: user.coinBalance || 0, _id: { $lt: user._id } },
  ],
});

const getWeeklyRankQuery = (user) => ({
  $or: [
    { weeklyPoints: { $gt: user.weeklyPoints || 0 } },
    { weeklyPoints: user.weeklyPoints || 0, totalPoints: { $gt: user.totalPoints || 0 } },
    { weeklyPoints: user.weeklyPoints || 0, totalPoints: user.totalPoints || 0, coinBalance: { $gt: user.coinBalance || 0 } },
    { weeklyPoints: user.weeklyPoints || 0, totalPoints: user.totalPoints || 0, coinBalance: user.coinBalance || 0, _id: { $lt: user._id } },
  ],
});

const getMatchRankQuery = (team) => ({
  match: team.match,
  $or: [
    { totalPoints: { $gt: team.totalPoints || 0 } },
    { totalPoints: team.totalPoints || 0, createdAt: { $lt: team.createdAt } },
    { totalPoints: team.totalPoints || 0, createdAt: team.createdAt, _id: { $lt: team._id } },
  ],
});

const resolveMatchFromParam = async (matchId) => {
  const rawMatchId = String(matchId || '').trim();
  let match = null;

  if (/^\d+$/.test(rawMatchId)) {
    match = await Match.findOne({ fixtureId: Number(rawMatchId) });
  }

  if (!match && mongoose.isValidObjectId(rawMatchId)) {
    match = await Match.findById(matchId);
  }

  return match;
};

export const updateGlobalRanks = async () => {
  try {
    const users = await User.find({}).sort(GLOBAL_SORT).select('_id');
    if (users.length === 0) return;

    const bulkOps = users.map((user, index) => ({
      updateOne: {
        filter: { _id: user._id },
        update: { $set: { globalRank: index + 1 } }
      }
    }));

    await User.bulkWrite(bulkOps);
  } catch (error) {
    console.error('Error updating global ranks:', error);
  }
};

// @desc    Get global leaderboard
// @route   GET /api/leaderboard
// @access  Public
export const getLeaderboard = async (req, res) => {
  try {
    const users = await User.find({ totalPoints: { $gt: 0 } })
      .sort(GLOBAL_SORT)
      .select('name totalPoints globalRank profilePicture coinBalance')
      .limit(50);

    res.status(200).json(mapUserLeaderboard(users, 'totalPoints'));
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching leaderboard', error: error.message });
  }
};

// @desc    Get match-specific leaderboard
// @route   GET /api/leaderboard/match/:matchId
// @access  Public
export const getMatchLeaderboard = async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = await resolveMatchFromParam(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    // ১. এই ম্যাচের সব রুম খুঁজে বের করে সেগুলোতে থাকা টিমের ID গুলো কালেক্ট করা
    const rooms = await Room.find({ match: match._id });
    const validTeamIds = new Set();
    rooms.forEach(room => {
      room.members.forEach(member => {
        if (member.team) validTeamIds.add(member.team.toString());
      });
    });

    // ২. শুধুমাত্র রুমে থাকা টিমগুলো লিডারবোর্ডে পাঠানো
    const teams = await FantasyTeam.find({ match: match._id, _id: { $in: Array.from(validTeamIds) } })
      .sort(MATCH_SORT)
      .limit(50)
      .populate('user', 'name profilePicture globalRank');

    res.status(200).json(mapTeamLeaderboard(teams));
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching match leaderboard', error: error.message });
  }
};

// @desc    Get weekly leaderboard
// @route   GET /api/leaderboard/weekly
// @access  Public
export const getWeeklyLeaderboard = async (req, res) => {
  try {
    const users = await User.find({ weeklyPoints: { $gt: 0 } })
      .sort(WEEKLY_SORT)
      .select('name weeklyPoints totalPoints globalRank profilePicture coinBalance')
      .limit(50);

    res.status(200).json(mapUserLeaderboard(users, 'weeklyPoints'));
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching weekly leaderboard', error: error.message });
  }
};

// @desc    Get current user's leaderboard stats
// @route   GET /api/leaderboard/me
// @access  Private
export const getMyLeaderboardStats = async (req, res) => {
  try {
    const tab = req.query.tab || 'global';
    const basePayload = {
      _id: req.user._id,
      name: req.user.name,
      profilePicture: req.user.profilePicture || '',
      globalRank: req.user.globalRank || 0,
      rank: '-',
      pts: 0,
    };

    if (tab === 'weekly') {
      const higherUsers = await User.countDocuments(getWeeklyRankQuery(req.user));
      return res.status(200).json({
        ...basePayload,
        rank: higherUsers + 1,
        pts: req.user.weeklyPoints || 0,
      });
    }

    if (tab === 'match') {
      const { matchId } = req.query;
      if (!matchId) return res.status(400).json({ message: 'matchId is required for match leaderboard stats' });

      const match = await resolveMatchFromParam(matchId);
      if (!match) return res.status(404).json({ message: 'Match not found' });

      const team = await FantasyTeam.findOne({ user: req.user._id, match: match._id }).select('match totalPoints createdAt');
      if (!team) return res.status(200).json(basePayload);

      // ইউজার কোনো রুমে জয়েন করেছে কিনা চেক করা
      const isInRoom = await Room.exists({ match: match._id, 'members.team': team._id });
      if (!isInRoom) {
        return res.status(200).json({ ...basePayload, rank: 'No Room', pts: team.totalPoints || 0 });
      }

      const rooms = await Room.find({ match: match._id });
      const validTeamIds = new Set();
      rooms.forEach(room => {
        room.members.forEach(member => {
          if (member.team) validTeamIds.add(member.team.toString());
        });
      });

      const matchRankQuery = getMatchRankQuery(team);
      const higherTeams = await FantasyTeam.countDocuments({
        _id: { $in: Array.from(validTeamIds) },
        match: matchRankQuery.match,
        $or: matchRankQuery.$or
      });

      return res.status(200).json({
        ...basePayload,
        rank: higherTeams + 1,
        pts: team.totalPoints || 0,
      });
    }

    const higherUsers = await User.countDocuments(getGlobalRankQuery(req.user));
    return res.status(200).json({
      ...basePayload,
      rank: higherUsers + 1,
      pts: req.user.totalPoints || 0,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching your leaderboard stats', error: error.message });
  }
};
