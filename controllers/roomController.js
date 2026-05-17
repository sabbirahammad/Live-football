import Room from '../models/Room.js';
import FantasyTeam from '../models/FantasyTeam.js';
import Match from '../models/Match.js';

const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// @desc    Create a new challenge room
// @route   POST /api/rooms/create
// @access  Private
export const createRoom = async (req, res) => {
  const { name, matchId, privacy, maxPlayers, challengeType, reward } = req.body;

  try {
    let match = await Match.findOne({ fixtureId: Number(matchId) });
    if (!match && matchId.length === 24) match = await Match.findById(matchId);

    if (!match && !isNaN(matchId)) {
      const apiKey = process.env.FOOTBALL_API_KEY;
      if (apiKey) {
        console.log(`Auto-syncing Match ${matchId} to DB for room creation...`);
        const fixtureRes = await fetch(`https://v3.football.api-sports.io/fixtures?id=${matchId}`, {
          headers: { 'x-apisports-key': apiKey }
        });
        const fixtureData = await fixtureRes.json();
        if (fixtureData.response && fixtureData.response.length > 0) {
          const item = fixtureData.response[0];
          match = await Match.create({
            fixtureId: item.fixture.id,
            homeTeam: item.teams.home.name,
            awayTeam: item.teams.away.name,
            homeLogo: item.teams.home.logo || '',
            awayLogo: item.teams.away.logo || '',
            homeTeamApiId: item.teams.home.id,
            awayTeamApiId: item.teams.away.id,
            matchTime: new Date(item.fixture.date),
            league: item.league.name,
            status: ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(item.fixture.status.short)
              ? 'Live'
              : ['FT', 'AET', 'PEN'].includes(item.fixture.status.short)
                ? 'Finished'
                : 'Upcoming'
          });
        }
      }
    }

    if (!match) return res.status(404).json({ message: 'Match not found in DB and auto-sync failed' });
    const actualMatchId = match._id;

    const userTeam = await FantasyTeam.findOne({ user: req.user._id, match: actualMatchId });

    const room = await Room.create({
      name,
      match: actualMatchId,
      privacy,
      maxPlayers,
      challengeType,
      reward,
      code: generateCode(),
      createdBy: req.user._id,
      members: [{ user: req.user._id, team: userTeam ? userTeam._id : null }],
    });

    res.status(201).json(room);
  } catch (error) {
    res.status(500).json({ message: 'Server error creating room', error: error.message });
  }
};

// @desc    Join a challenge room with a code
// @route   POST /api/rooms/join
// @access  Private
export const joinRoom = async (req, res) => {
  const { code } = req.body;

  try {
    const room = await Room.findOne({ code: code.toUpperCase() });
    if (!room) {
      return res.status(404).json({ message: 'Room not found with this code' });
    }

    if (room.members.some(member => member.user.equals(req.user._id))) {
      return res.status(400).json({ message: 'You are already in this room' });
    }

    const userTeam = await FantasyTeam.findOne({ user: req.user._id, match: room.match });
    room.members.push({ user: req.user._id, team: userTeam ? userTeam._id : null });
    await room.save();

    res.status(200).json(room);
  } catch (error) {
    res.status(500).json({ message: 'Server error joining room', error: error.message });
  }
};

// @desc    Get user's rooms
// @route   GET /api/rooms
// @access  Private
export const getMyRooms = async (req, res) => {
  try {
    const rooms = await Room.find({ 'members.user': req.user._id })
      .populate('match')
      .sort('-createdAt');
    res.status(200).json(rooms);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching rooms', error: error.message });
  }
};

// @desc    Get public rooms that the user is not a member of
// @route   GET /api/rooms/public
// @access  Private
export const getPublicRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      privacy: 'Public',
      'members.user': { $ne: req.user._id }
    })
      .populate('match')
      .sort('-createdAt')
      .limit(10);
    res.status(200).json(rooms);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching public rooms', error: error.message });
  }
};

// @desc    Get live leaderboard for a specific room
// @route   GET /api/rooms/:roomId/leaderboard
// @access  Private
export const getRoomLeaderboard = async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate({ path: 'members.user', select: 'name profilePicture' })
      .populate({ path: 'members.team', select: 'totalPoints' });

    if (!room) return res.status(404).json({ message: 'Room not found' });

    const leaderboard = room.members
      .map(member => ({
        _id: member.user?._id,
        name: member.user?.name || 'Unknown',
        profilePicture: member.user?.profilePicture || null,
        pts: member.team?.totalPoints || 0
      }))
      .sort((a, b) => b.pts - a.pts)
      .map((user, index) => ({ ...user, rank: index + 1 }));

    res.status(200).json(leaderboard);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching leaderboard', error: error.message });
  }
};
