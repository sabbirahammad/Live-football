import FantasyTeam from '../models/FantasyTeam.js';
import Room from '../models/Room.js';
import Match from '../models/Match.js';
import Player from '../models/Player.js';
import mongoose from 'mongoose';

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

const populateTeamDetails = (query) =>
  query
    .populate('players')
    .populate('captain')
    .populate('viceCaptain');

const enrichTeamLogos = async (team, match) => {
  if (!team || !match) return team;

  const missingTeamLogos = team.players?.some(player => !player?.teamLogo);
  if (!missingTeamLogos || !match?.fixtureId || !process.env.FOOTBALL_API_KEY) {
    return team;
  }

  try {
    const fixtureRes = await fetch(`https://v3.football.api-sports.io/fixtures?id=${match.fixtureId}`, {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });
    const fixtureData = await fixtureRes.json();
    const fixture = fixtureData?.response?.[0];

    if (!fixture?.teams) return team;

    const logoByTeamName = {
      [fixture.teams.home?.name]: fixture.teams.home?.logo || '',
      [fixture.teams.away?.name]: fixture.teams.away?.logo || '',
    };

    const enrichedPlayers = team.players.map(player => {
      if (player?.teamLogo) return player;
      const playerObj = player.toObject ? player.toObject() : player;
      return {
        ...playerObj,
        teamLogo: logoByTeamName[playerObj.team] || ''
      };
    });

    const teamObj = team.toObject ? team.toObject() : team;
    return { ...teamObj, players: enrichedPlayers };
  } catch (error) {
    console.error('Error enriching team logos:', error);
    return team;
  }
};

// 🔄 প্লেয়ারদের Selection Percentage (sel %) ক্যালকুলেট করার হেল্পার ফাংশন
const updateSelectionPercentage = async (matchId) => {
  try {
    const totalTeams = await FantasyTeam.countDocuments({ match: matchId });
    if (totalTeams === 0) return;

    // এগ্রিগেশন দিয়ে বের করা হচ্ছে কোন প্লেয়ার কতগুলো টিমে আছে
    const playerStats = await FantasyTeam.aggregate([
      { $match: { match: matchId } },
      { $unwind: "$players" },
      { $group: { _id: "$players", count: { $sum: 1 } } }
    ]);

    const bulkOps = playerStats.map(stat => ({
      updateOne: {
        filter: { _id: stat._id },
        update: { $set: { sel: Math.round((stat.count / totalTeams) * 100) } }
      }
    }));

    if (bulkOps.length > 0) await Player.bulkWrite(bulkOps);
  } catch (error) {
    console.error("Error updating selection percentage:", error);
  }
};

// @desc    Save user's fantasy team
// @route   POST /api/teams/save
// @access  Private
export const saveTeam = async (req, res) => {
  const { matchId, players, captain, viceCaptain } = req.body;

  try {
    const match = await resolveMatchFromParam(matchId);
    if (!match) return res.status(404).json({ message: "Match not found in DB. Open Team Builder to sync." });
    const actualMatchId = match._id;

    // 🔒 Security Check: ম্যাচ শুরু হয়ে গেলে বা ৫ মিনিটের কম সময় থাকলে টিম সেভ করা যাবে না
    const timeDiff = new Date(match.matchTime).getTime() - Date.now();
    if (match.status !== 'Upcoming' || timeDiff <= 5 * 60 * 1000) {
      return res.status(400).json({ message: "Match is locked! You cannot modify your team now." });
    }

    // 🔒 Security Check: Team Validation (15 Players, 100 Budget, Max 10 per team)
    if (!players || players.length !== 15) {
      return res.status(400).json({ message: "Invalid team size. Must be exactly 15 players." });
    }
    if (!captain || !viceCaptain || captain === viceCaptain) {
      return res.status(400).json({ message: "Invalid captain or vice-captain selection." });
    }
    if (!players.includes(captain) || !players.includes(viceCaptain)) {
      return res.status(400).json({ message: "Captain and Vice-Captain must be from your selected 15 players." });
    }

    // ডাটাবেস থেকে প্লেয়ারদের আসল ডেটা (Price, Team) এনে ভ্যালিডেট করা হচ্ছে
    const playerDocs = await Player.find({ _id: { $in: players } });
    if (playerDocs.length !== 15) {
      return res.status(400).json({ message: "Some selected players are invalid or do not exist in the database." });
    }

    let totalBudget = 0;
    const teamCounts = {};
    for (const p of playerDocs) {
      totalBudget += (p.price || 7.5);
      teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
      if (teamCounts[p.team] > 10) return res.status(400).json({ message: `Max 10 players allowed from ${p.team}.` });
    }

    if (totalBudget > 100) return res.status(400).json({ message: "Budget exceeded! Maximum allowed is 100M." });

    // চেক করা হচ্ছে এই ইউজারের এই ম্যাচের জন্য আগে থেকেই টিম আছে কি না
    let team = await FantasyTeam.findOne({ user: req.user._id, match: actualMatchId });

    if (team) {
      // থাকলে আপডেট হবে
      team.players = players;
      team.captain = captain;
      team.viceCaptain = viceCaptain;
      team.totalPoints = 0;
      team.awardedPoints = 0;
      team.playerPoints = {};
      await team.save();
    } else {
      // না থাকলে নতুন তৈরি হবে
      team = await FantasyTeam.create({
        user: req.user._id, match: actualMatchId, players, captain, viceCaptain,
        totalPoints: 0, awardedPoints: 0, playerPoints: {}
      });
    }

    // ⚠️ আপডেট: এই ইউজারের যেসব রুম আছে ওই ম্যাচের জন্য, সেগুলোতে team ID আপডেট করা
    await Room.updateMany(
      { match: actualMatchId, 'members.user': req.user._id },
      { $set: { 'members.$[member].team': team._id } },
      { arrayFilters: [{ 'member.user': req.user._id }] }
    );

    // 🔄 ব্যাকগ্রাউন্ডে Selection % আপডেট করা হচ্ছে (ইউজারকে ওয়েট না করিয়ে)
    updateSelectionPercentage(actualMatchId);

    return res.status(200).json({ message: 'Team saved successfully', team });
  } catch (error) {
    console.error('saveTeam error:', {
      message: error.message,
      name: error.name,
      matchId,
      userId: req.user?._id?.toString?.(),
    });
    res.status(500).json({ message: 'Server error saving team', error: error.message });
  }
};

// @desc    Get user's fantasy team for a specific match
// @route   GET /api/teams/my-team/:matchId
// @access  Private
export const getMyTeam = async (req, res) => {
  const { matchId } = req.params;
  const { roomId } = req.query;
  
  try {
    const match = await resolveMatchFromParam(matchId);

    let team = null;

    if (match) {
      team = await populateTeamDetails(
        FantasyTeam.findOne({ user: req.user._id, match: match._id })
      );
    }

    if (!team && roomId) {
      const room = await Room.findById(roomId).populate({
        path: 'members.team',
        populate: [{ path: 'players' }, { path: 'captain' }, { path: 'viceCaptain' }]
      });

      const myMember = room?.members?.find(member => member.user?.toString() === req.user._id.toString());
      if (myMember?.team) {
        team = myMember.team;
      }
    }

    if (!team) {
      return res.status(404).json({ message: match ? 'Team not found for this match' : 'Match/team not found' });
    }

    res.status(200).json(await enrichTeamLogos(team, match));
  } catch (error) {
    console.error('getMyTeam error:', {
      message: error.message,
      name: error.name,
      matchId,
      roomId,
      userId: req.user?._id?.toString?.(),
    });
    res.status(500).json({ message: 'Server error fetching team', error: error.message });
  }
};

// @desc    Get a leaderboard-visible user's fantasy team for a specific match
// @route   GET /api/teams/user/:userId/match/:matchId
// @access  Private
export const getUserTeamByMatch = async (req, res) => {
  const { userId, matchId } = req.params;

  try {
    const match = await resolveMatchFromParam(matchId);
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const team = await populateTeamDetails(
      FantasyTeam.findOne({ user: userId, match: match._id })
    );

    if (!team) {
      return res.status(404).json({ message: 'Team not found for this user and match' });
    }

    const isLeaderboardVisible = await Room.exists({ match: match._id, 'members.team': team._id });
    if (!isLeaderboardVisible) {
      return res.status(404).json({ message: 'Team is not available for leaderboard view' });
    }

    res.status(200).json(await enrichTeamLogos(team, match));
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching user team', error: error.message });
  }
};

// @desc    Get a leaderboard-visible fantasy team by team ID
// @route   GET /api/teams/:teamId/view
// @access  Private
export const getTeamByIdForView = async (req, res) => {
  const { teamId } = req.params;

  try {
    const team = await populateTeamDetails(
      FantasyTeam.findById(teamId).populate('match')
    );

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const isLeaderboardVisible = await Room.exists({ match: team.match?._id || team.match, 'members.team': team._id });
    if (!isLeaderboardVisible) {
      return res.status(404).json({ message: 'Team is not available for leaderboard view' });
    }

    // 🔒 Security: Prevent viewing teams before the match starts to avoid team copying
    if (team.match?.status === 'Upcoming') {
      return res.status(403).json({ message: 'Teams are hidden until the match starts to prevent copying!' });
    }

    res.status(200).json(await enrichTeamLogos(team, team.match));
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching team by ID', error: error.message });
  }
};
