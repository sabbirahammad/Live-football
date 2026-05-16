import mongoose from 'mongoose';
import User from '../models/User.js';
import FantasyTeam from '../models/FantasyTeam.js';
import Room from '../models/Room.js';
import Match from '../models/Match.js';

// --- In-Memory Cache Setup for Leaderboard ---
let leaderboardCache = {
  global: { data: null, lastFetch: 0 },
  weekly: { data: null, lastFetch: 0 },
  matches: {} // { matchId: { data: null, lastFetch: 0 } }
};
const CACHE_TTL = 10 * 1000; // 10 seconds TTL

export const clearLeaderboardCache = (matchId = null) => {
  if (matchId && leaderboardCache.matches[matchId]) {
    leaderboardCache.matches[matchId].lastFetch = 0;
  } else {
    leaderboardCache.global.lastFetch = 0;
    leaderboardCache.weekly.lastFetch = 0;
    leaderboardCache.matches = {};
  }
};

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

const getCurrentWeekStart = () => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
};

const getValidRoomTeamIds = async () => {
  const rooms = await Room.find({}).select('members.team');
  const validTeamIds = new Set();

  rooms.forEach((room) => {
    room.members.forEach((member) => {
      if (member.team) validTeamIds.add(member.team.toString());
    });
  });

  return Array.from(validTeamIds);
};

const buildUserTotalsFromFinishedTeams = async ({ weeklyOnly = false } = {}) => {
  const validTeamIds = await getValidRoomTeamIds();
  if (validTeamIds.length === 0) return [];

  const weekStart = getCurrentWeekStart();
  const teams = await FantasyTeam.find({
    _id: { $in: validTeamIds },
    totalPoints: { $gt: 0 },
  })
    .select('user totalPoints awardedPoints match')
    .populate('user', 'name profilePicture globalRank coinBalance')
    .populate('match', 'matchTime');

  const totalsMap = new Map();

  teams.forEach((team) => {
    if (!team.user || !team.match) return;
    if (weeklyOnly && (!team.match.matchTime || new Date(team.match.matchTime) < weekStart)) return;

    const effectivePoints = Math.max(
      Number(team.awardedPoints || 0),
      Number(team.totalPoints || 0)
    );
    if (effectivePoints <= 0) return;

    const userId = team.user._id.toString();
    const existing = totalsMap.get(userId) || {
      _id: team.user._id,
      name: team.user.name || 'Unknown User',
      profilePicture: team.user.profilePicture || '',
      globalRank: team.user.globalRank || 0,
      coinBalance: Number(team.user.coinBalance || 0),
      pts: 0,
    };

    existing.pts += effectivePoints;
    totalsMap.set(userId, existing);
  });

  return Array.from(totalsMap.values())
    .sort((a, b) => (
      b.pts - a.pts
      || b.coinBalance - a.coinBalance
      || String(a._id).localeCompare(String(b._id))
    ))
    .map((user, index) => ({ ...user, rank: index + 1 }));
};

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
    const now = Date.now();
    // ক্যাশে ডেটা থাকলে সরাসরি রিটার্ন করা হবে (1ms রেসপন্স টাইম)
    if (leaderboardCache.global.data && (now - leaderboardCache.global.lastFetch < CACHE_TTL)) {
      return res.status(200).json(leaderboardCache.global.data);
    }

    const users = await User.find({ totalPoints: { $gt: 0 } })
      .sort(GLOBAL_SORT)
      .select('name totalPoints globalRank profilePicture coinBalance')
      .limit(50);

    const result = mapUserLeaderboard(users, 'totalPoints');
    leaderboardCache.global.data = result;
    leaderboardCache.global.lastFetch = now;
    res.status(200).json(result);
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

    const now = Date.now();
    const stringMatchId = match._id.toString();
    if (leaderboardCache.matches[stringMatchId]?.data && (now - leaderboardCache.matches[stringMatchId].lastFetch < CACHE_TTL)) {
      return res.status(200).json(leaderboardCache.matches[stringMatchId].data);
    }

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

    const result = mapTeamLeaderboard(teams);
    leaderboardCache.matches[stringMatchId] = { data: result, lastFetch: now };
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching match leaderboard', error: error.message });
  }
};

// @desc    Get weekly leaderboard
// @route   GET /api/leaderboard/weekly
// @access  Public
export const getWeeklyLeaderboard = async (req, res) => {
  try {
    const now = Date.now();
    if (leaderboardCache.weekly.data && (now - leaderboardCache.weekly.lastFetch < CACHE_TTL)) {
      return res.status(200).json(leaderboardCache.weekly.data);
    }

    const users = await User.find({ weeklyPoints: { $gt: 0 } })
      .sort(WEEKLY_SORT)
      .select('name weeklyPoints totalPoints globalRank profilePicture coinBalance')
      .limit(50);

    const result = mapUserLeaderboard(users, 'weeklyPoints');
    leaderboardCache.weekly.data = result;
    leaderboardCache.weekly.lastFetch = now;
    res.status(200).json(result);
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

    const globalUsers = await buildUserTotalsFromFinishedTeams();
    const meGlobal = globalUsers.find((user) => String(user._id) === String(req.user._id));
    return res.status(200).json({
      ...basePayload,
      rank: meGlobal?.rank || '-',
      pts: meGlobal?.pts || 0,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching your leaderboard stats', error: error.message });
  }
};
