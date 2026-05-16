import Match from '../models/Match.js';
import FantasyTeam from '../models/FantasyTeam.js';
import User from '../models/User.js';
import Room from '../models/Room.js';

const API_FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';

const getStoredPlayerPoints = (team, playerId) => {
  const key = playerId?.toString?.() || String(playerId || '');
  if (!key) return 0;
  if (team.playerPoints instanceof Map) return Number(team.playerPoints.get(key) || 0);
  return Number(team.playerPoints?.[key] || 0);
};

const setStoredPlayerPoints = (team, playerId, value) => {
  const key = playerId?.toString?.() || String(playerId || '');
  if (!key) return;
  if (!(team.playerPoints instanceof Map)) {
    team.playerPoints = new Map(Object.entries(team.playerPoints || {}));
  }
  team.playerPoints.set(key, Number(value) || 0);
  team.markModified('playerPoints');
};

const getApiFootballKey = () => {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) {
    const error = new Error('FOOTBALL_API_KEY not found in .env');
    error.statusCode = 400;
    throw error;
  }
  return apiKey;
};

const apiFootballRequest = async (resource, query = {}) => {
  const apiKey = getApiFootballKey();
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  const url = `${API_FOOTBALL_BASE_URL}/${resource}${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: { 'x-apisports-key': apiKey }
  });
  const data = await response.json();
  if (!response.ok) {
    return { ok: false, status: response.status, data };
  }
  return { ok: true, status: response.status, data };
};

//  অটো-সাব এবং পয়েন্ট ডিস্ট্রিবিউশন লজিক
export const processAutoSubsAndRewards = async (matchId) => {
  try {
    console.log(`🔄 Processing Auto-Subs for Match: ${matchId}`);

    // ১. এই ম্যাচের সব রুম খুঁজে বের করে সেগুলোতে থাকা টিমের ID গুলো কালেক্ট করা
    const rooms = await Room.find({ match: matchId });
    const validTeamIds = new Set();
    rooms.forEach(room => {
      room.members.forEach(member => {
        if (member.team) validTeamIds.add(member.team.toString());
      });
    });

    const teams = await FantasyTeam.find({ match: matchId }).populate('players');

    const MIN_DEF = 3, MAX_DEF = 5;
    const MIN_MID = 2, MAX_MID = 5;
    const MIN_FWD = 1, MAX_FWD = 3;

    for (const team of teams) {
      if (!team.players || team.players.length !== 15) continue;

      let starters = team.players.slice(0, 11);
      let bench = team.players.slice(11);
      let hasChanges = false;

      // 1. Sub Goalkeeper
      const startingGkIndex = starters.findIndex(p => p && p.pos === 'GK');
      const benchGkIndex = bench.findIndex(p => p && p.pos === 'GK');

      if (startingGkIndex !== -1 && benchGkIndex !== -1) {
        const startingGK = starters[startingGkIndex];
        const benchGK = bench[benchGkIndex];
        if (getStoredPlayerPoints(team, startingGK._id) === 0 && getStoredPlayerPoints(team, benchGK._id) > 0) {
          starters[startingGkIndex] = benchGK;
          bench[benchGkIndex] = startingGK; // Swap
          hasChanges = true;
        }
      }

      // 2. Sub Outfield Players
      for (let i = 0; i < starters.length; i++) {
        const starter = starters[i];
        if (!starter || starter.pos === 'GK' || getStoredPlayerPoints(team, starter._id) > 0) continue;

        for (let j = 0; j < bench.length; j++) {
          const sub = bench[j];
          if (!sub || sub.pos === 'GK' || getStoredPlayerPoints(team, sub._id) === 0) continue;

          const tempStarters = [...starters];
          tempStarters[i] = sub;
          const defCount = tempStarters.filter(p => p.pos === 'DEF').length;
          const midCount = tempStarters.filter(p => p.pos === 'MID').length;
          const fwdCount = tempStarters.filter(p => p.pos === 'FWD').length;

          if (defCount >= MIN_DEF && defCount <= MAX_DEF && midCount >= MIN_MID && midCount <= MAX_MID && fwdCount >= MIN_FWD && fwdCount <= MAX_FWD) {
            starters[i] = sub;
            bench[j] = starter; // Swap
            hasChanges = true;
            break; 
          }
        }
      }

      // 3. Recalculate Final Points
      // চেক করা হচ্ছে অরিজিনাল ক্যাপ্টেন মূল একাদশে (Starters) আছে কি না
      const isCapInStarters = starters.some(p => p && team.captain && p._id.equals(team.captain));
      
      // ক্যাপ্টেন সাবস্টিটিউট হয়ে গেলে, ভাইস-ক্যাপ্টেন অটোমেটিকভাবে নতুন ক্যাপ্টেন হবে (x2)
      const activeCaptainId = isCapInStarters ? team.captain : team.viceCaptain;
      const activeViceId = isCapInStarters ? team.viceCaptain : null;

      let totalPoints = 0;
      for (const p of starters) {
        if (!p) continue;
        let pts = getStoredPlayerPoints(team, p._id);
        if (activeCaptainId && p._id.equals(activeCaptainId)) pts *= 2;
        else if (activeViceId && p._id.equals(activeViceId)) pts *= 1.5;
        totalPoints += pts;
      }

      team.totalPoints = Math.round(totalPoints);
      if (hasChanges) {
        team.players = [...starters, ...bench].map(p => p._id || p); // Populate হওয়া ডেটাকে সেফলি ObjectId তে কনভার্ট করা
      }
      await team.save();

      // 4. ইউজারের মূল একাউন্টে পয়েন্ট (Coin) যোগ করা (শুধুমাত্র রুমে থাকলে)
      if (validTeamIds.has(team._id.toString())) {
        await User.findByIdAndUpdate(team.user, { $inc: { coinBalance: Math.round(totalPoints), totalPoints: Math.round(totalPoints), weeklyPoints: Math.round(totalPoints) } });
      }
    }
    console.log(`✅ Auto-Subs & Rewards finished for Match: ${matchId}`);
  } catch (error) {
    console.error("❌ Error in Auto-Sub:", error);
  }
};

// @desc    Get all matches
// @route   GET /api/matches
// @access  Public
export const getMatches = async (req, res) => {
  try {
    // Remove old dummy matches without fixtureId from database to prevent polluting
    await Match.deleteMany({ fixtureId: null });
    
    // Get matches from DB (which are synced when users open Team Builder or create rooms)
    const matches = await Match.find({}).sort({ matchTime: 1 });

    res.status(200).json(matches);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching matches', error: error.message });
  }
};

// @desc    Proxy selected API-Football resources through backend
// @route   GET /api/matches/proxy/:resource
// @access  Public
export const proxyFootballData = async (req, res) => {
  const { resource } = req.params;
  if (!['fixtures', 'status'].includes(resource)) {
    return res.status(400).json({ message: 'Unsupported proxy resource' });
  }

  try {
    const result = await apiFootballRequest(resource, req.query);
    if (!result.ok) {
      return res.status(result.status).json(result.data);
    }
    res.status(200).json(result.data);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ message: error.message || 'Server error proxying football data' });
  }
};

// @desc    Simulate a live event (For testing socket.io)
// @route   POST /api/matches/simulate
// @access  Public
export const simulateLiveEvent = async (req, res) => {
  const io = req.app.get("io");
  const { roomId, event } = req.body;
  
  if (!roomId || !event) {
    return res.status(400).json({ message: "Room ID and event data are required" });
  }
  const room = await Room.findById(roomId).select('match');
  if (!room) {
    return res.status(404).json({ message: "Room not found" });
  }

  // ডাটাবেসে প্লেয়ারের পয়েন্ট লাইভ আপডেট করা হচ্ছে
  if (event.playerId && event.numPts) {

    // ২. এই প্লেয়ার যেসব ফ্যান্টাসি টিমে আছে, তাদের totalPoints লাইভ আপডেট করা (Real-time Match Leaderboard এর জন্য)
    const teams = await FantasyTeam.find({ match: room.match, players: event.playerId });
    for (const team of teams) {
      const currentPlayerPoints = getStoredPlayerPoints(team, event.playerId);
      setStoredPlayerPoints(team, event.playerId, currentPlayerPoints + event.numPts);
      // চেক করা হচ্ছে প্লেয়ারটি মূল একাদশে (প্রথম ১১ জন) আছে কি না (বেঞ্চ প্লেয়ার পয়েন্ট পাবে না)
      const starters = team.players.length === 15 ? team.players.slice(0, 11) : team.players;
      const isStarter = starters.some(pId => pId.toString() === event.playerId.toString());
      
      if (isStarter) {
        let ptsToAdd = event.numPts;
        if (team.captain && team.captain.toString() === event.playerId.toString()) ptsToAdd *= 2;
        else if (team.viceCaptain && team.viceCaptain.toString() === event.playerId.toString()) ptsToAdd *= 1.5;
        
        team.totalPoints = (team.totalPoints || 0) + ptsToAdd;
      }
      await team.save();
    }
  }

  // Socket.io দিয়ে নির্দিষ্ট রুমের সব ইউজারের কাছে লাইভ ইভেন্ট পাঠানো হচ্ছে
  io.to(roomId).emit("live_event", event);
  
  // গ্লোবাল লিডারবোর্ড রিয়েল-টাইম রিফ্রেশ করার জন্য সিগন্যাল পাঠানো
  io.emit("refresh_global_leaderboard");
  
  res.status(200).json({ success: true, message: "Live event triggered successfully", event });
};

// @desc    Manually sync real matches from API-Football
// @route   POST /api/matches/sync
// @access  Public
export const syncMatches = async (req, res) => {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) return res.status(400).json({ message: "FOOTBALL_API_KEY not found in .env" });

  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`, {
      headers: { 'x-apisports-key': apiKey }
    });
    const data = await response.json();

    if (data.response && data.response.length > 0) {
      const topLeagueIds = [2, 3, 4, 9, 15, 39, 61, 66, 78, 135, 140];
      const filteredResponse = data.response.filter(item => topLeagueIds.includes(item.league.id));

      if (filteredResponse.length > 0) {
        const finishedMatchIds = [];
        const io = req.app.get("io");
        
        for (const item of filteredResponse) {
          let status = 'Upcoming';
          const shortStatus = item.fixture.status.short;
          if (['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(shortStatus)) status = 'Live';
          else if (['FT', 'AET', 'PEN'].includes(shortStatus)) status = 'Finished';

          const existingMatch = await Match.findOne({ fixtureId: item.fixture.id });

          if (existingMatch) {
            if (existingMatch.status !== 'Finished' && status === 'Finished') {
              finishedMatchIds.push(existingMatch._id);
              if (io) io.emit("match_finished", { matchId: String(existingMatch._id) });
            }
            existingMatch.status = status;
            existingMatch.homeLogo = item.teams.home.logo || existingMatch.homeLogo;
            existingMatch.awayLogo = item.teams.away.logo || existingMatch.awayLogo;
            existingMatch.homeScore = item.goals.home || 0;
            existingMatch.awayScore = item.goals.away || 0;
            existingMatch.minute = item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : "0'";
            await existingMatch.save();
          } else {
            await Match.create({
              fixtureId: item.fixture.id, homeTeam: item.teams.home.name,
              awayTeam: item.teams.away.name, homeLogo: item.teams.home.logo || '',
              awayLogo: item.teams.away.logo || '', homeScore: item.goals.home || 0,
              awayScore: item.goals.away || 0, status: status,
              matchTime: new Date(item.fixture.date), league: item.league.name,
              minute: item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : "0'",
              roomsCount: Math.floor(Math.random() * 10) + 1
            });
          }
        }
        
        for (const mId of finishedMatchIds) {
          await processAutoSubsAndRewards(mId);
        }
        
        res.status(200).json({ message: "Top matches synced successfully!", autoSubbed: finishedMatchIds.length });
      } else {
        res.status(404).json({ message: "No top matches found for today" });
      }
    } else {
      res.status(404).json({ message: "No matches found for today" });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error syncing matches', error: error.message });
  }
};
