import mongoose from 'mongoose';
import Match from '../models/Match.js';
import FantasyTeam from '../models/FantasyTeam.js';
import User from '../models/User.js';
import Player from '../models/Player.js';
import Room from '../models/Room.js';
import AllowedLeague from '../models/AllowedLeague.js'; // নতুন মডেল ইম্পোর্ট
import { clearLeaderboardCache } from './leaderboardController.js';

// --- In-Memory Cache Setup ---
let matchCache = {
  data: null,
  lastFetch: 0
};
const CACHE_TTL = 15 * 1000; // 15 seconds cache TTL

// ✅ টপ লিগগুলোর নির্দিষ্ট ID (League ID) তালিকা এবং নামের রেজেক্স
const TOP_LEAGUE_IDS = [1, 2, 3, 4, 5, 9, 15, 39, 61, 78, 135, 140, 31, 32, 33, 34, 35, 10]; 
const TOP_LEAGUES_REGEX = /(premier league|la liga|serie a|bundesliga|ligue 1|uefa champions league|ucl|world cup|fifa world cup|wc qualifiers|international|friendly|friendlies|qualifiers|nations league|euro|copa america|afcon)/i;

// 🚫 বাদ দেওয়া হবে এমন কি-ওয়ার্ড (Lower Divisions & Youth)
const EXCLUDED_LEAGUES_REGEX = /(league[ \-_][b-z]|division[ \-_][2-9]|tier[ \-_][2-9]|serie[ \-_][b-z]|bundesliga[ \-_]2|segunda|u[12][0-9]|youth|reserve|relegation|play-offs|amateur|regional|conference|women|trophy)/i;

export const clearMatchCache = () => {
  matchCache.lastFetch = 0; // ফোর্স রিলোড করার জন্য
};

// ✅ একটি নির্দিষ্ট ম্যাচকে Featured হিসেবে পিন করা (Admin Only)
export const setFeaturedMatch = async (req, res) => {
  const { id } = req.params;
  const { isFeatured } = req.body; // true or false

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid Match ID format' });
  }

  try {
    // যদি নতুন কোনো ম্যাচকে পিন করা হয়, তবে আগের পিন করা ম্যাচটি আন-পিন করে দেওয়া হবে
    if (isFeatured) {
      await Match.updateMany({ isFeatured: true }, { $set: { isFeatured: false } });
    }

    const match = await Match.findByIdAndUpdate(id, { isFeatured }, { new: true });
    clearMatchCache();
    res.status(200).json({ message: isFeatured ? 'Match pinned successfully' : 'Match unpinned', match });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const fetchWithRotation = async (endpoint) => {
  const keys = ((process.env.FOOTBALL_API_KEY || '') + ',' + (process.env.FOOTBALL_API_KEYS || ''))
    .split(',').map(k => k.trim()).filter(Boolean);
  const uniqueKeys = [...new Set(keys)];

  for (const [index, key] of uniqueKeys.entries()) {
    try {
      const res = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
        headers: { 'x-apisports-key': key }
      });
      const data = await res.json();

      if ((!data.errors || Object.keys(data.errors).length === 0) && data.response) {
        return data;
      }

      const errorMsg = data.errors ? JSON.stringify(data.errors) : "No response";
      console.warn(`MatchSync: Key ${index + 1} issue: ${errorMsg}`);
    } catch (err) {
      console.error(`MatchSync: Key ${index + 1} error:`, err.message);
    }
  }
  return { errors: { requests: "All keys exhausted" }, response: [] };
};

// 📊 ম্যাচ শেষে প্লেয়ারদের ফ্যান্টাসি স্ট্যাটাস (Clean Sheet, Play Time, Position-based goals) আপডেট করা
const processMatchStatistics = async (matchId, fixtureId) => {
  try {
    console.log(`\n📊 Fetching Final Player Statistics from API-Sports for Match: ${matchId}`);
    const data = await fetchWithRotation(`fixtures/players?fixture=${fixtureId}`);

    if (data.response && data.response.length > 0) {
      const matchPlayers = []; // BPS ট্র্যাক করার জন্য

      for (const teamData of data.response) {
        for (const p of teamData.players) {
          const apiId = p.player.id;
          const stats = p.statistics[0];
          if (!stats) continue;

          const pos = stats.games.position; // "Attacker", "Midfielder", "Defender", "Goalkeeper"
          const minutes = stats.games.minutes || 0;
          const conceded = stats.goals.conceded || 0;
          const goals = stats.goals.total || 0;
          const assists = stats.goals.assists || 0;
          const saves = stats.goalkeepers?.saves || 0;
          const penSaved = stats.penalty?.saved || 0;
          const yellow = stats.cards.yellow || 0;
          const red = stats.cards.red || 0;
          const penMissed = stats.penalty?.missed || 0;
          const passAccuracy = stats.passes?.accuracy || 0;
          const keyPasses = stats.passes?.key || 0;
          const tackles = stats.tackles?.total || 0;
          const interceptions = stats.tackles?.interceptions || 0;

          let extraPoints = 0;
          let bps = 0; // Bonus Points System Score

          // ১. খেলার সময় (Playing Time Points)
          if (minutes > 0 && minutes < 60) { extraPoints += 1; bps += 3; }
          else if (minutes >= 60) { extraPoints += 2; bps += 6; }

          // BPS: Goals & Assists
          if (goals > 0) bps += (goals * (pos === "Attacker" ? 24 : pos === "Midfielder" ? 18 : 12));
          if (assists > 0) bps += (assists * 9);

          // ২. ক্লিন শিট এবং গোল হজম (Clean Sheet & Goals Conceded)
          if (pos === "Goalkeeper" || pos === "Defender") {
            if (minutes >= 60 && conceded === 0) { extraPoints += 4; bps += 12; }
            if (conceded >= 2) extraPoints -= Math.floor(conceded / 2); // প্রতি ২ গোলের জন্য -১ পয়েন্ট
            if (conceded > 0) bps -= (conceded * 3); // BPS Deduction for goals conceded
          } else if (pos === "Midfielder") {
            if (minutes >= 60 && conceded === 0) extraPoints += 1;
          }

          // ৩. সেভস এবং পেনাল্টি সেভ (GK Actions)
          if (pos === "Goalkeeper") {
            if (saves > 0) { extraPoints += Math.floor(saves / 3); bps += (saves * 2); }
            if (penSaved > 0) { extraPoints += (5 * penSaved); bps += (penSaved * 15); }
          }

          // BPS: Cards Deductions
          if (yellow > 0) bps -= (yellow * 3);
          if (red > 0) bps -= (red * 9);
          if (penMissed > 0) bps -= (penMissed * 6); // Penalty miss major deduction

          // BPS: Advanced Stats (Modern Fantasy Standard)
          if (passAccuracy >= 80) bps += 2;
          else if (passAccuracy >= 70) bps += 1;
          if (keyPasses > 0) bps += (keyPasses * 1);
          if (tackles > 0) bps += (tackles * 2);
          if (interceptions > 0) bps += (interceptions * 2);

          matchPlayers.push({ apiId, extraPoints, bps });
        }
      }

      // 🌟 Bonus Points System (BPS) Allocation 🌟
      // BPS অনুযায়ী প্লেয়ারদের ডিসেন্ডিং অর্ডারে সাজানো
      matchPlayers.sort((a, b) => b.bps - a.bps);

      // সেরা ৩ জনকে যথাক্রমে +৩, +২, +১ ফ্যান্টাসি পয়েন্ট দেওয়া
      if (matchPlayers.length > 0 && matchPlayers[0].bps > 0) matchPlayers[0].extraPoints += 3;
      if (matchPlayers.length > 1 && matchPlayers[1].bps > 0) matchPlayers[1].extraPoints += 2;
      if (matchPlayers.length > 2 && matchPlayers[2].bps > 0) matchPlayers[2].extraPoints += 1;

      // ডাটাবেসে প্লেয়ারের পয়েন্ট আপডেট করা
      for (const mp of matchPlayers) {
        if (mp.extraPoints !== 0) {
          const playerDoc = await Player.findOneAndUpdate({ apiId: mp.apiId }, { $inc: { pts: mp.extraPoints } });
          
          // এই ম্যাচের টিমেও পয়েন্টগুলো যোগ করা (যাতে টিমের টোটাল পয়েন্ট ঠিক থাকে)
          if (playerDoc) {
            const teams = await FantasyTeam.find({ match: matchId, players: playerDoc._id });
            for (const team of teams) {
              if (!(team.playerPoints instanceof Map)) {
                team.playerPoints = new Map(Object.entries(team.playerPoints || {}));
              }
              const currentMatchPts = Number(team.playerPoints.get(playerDoc._id.toString()) || 0);
              team.playerPoints.set(playerDoc._id.toString(), currentMatchPts + mp.extraPoints);
              team.markModified('playerPoints');
              await team.save();
            }
          }
        }
      }
    }
    console.log(`✅ FPL Match Statistics & BPS (Top 3 Bonus) applied successfully!`);
  } catch (error) {
    console.error(`❌ Error processing match stats for fixture ${fixtureId}:`, error);
  }
};

//  অটো-সাব এবং পয়েন্ট ডিস্ট্রিবিউশন লজিক
export const processAutoSubsAndRewards = async (matchId) => {
  try {
    console.log(`🔄 Processing Auto-Subs for Match: ${matchId}`);

    // অটো-সাব এবং পয়েন্ট ডিস্ট্রিবিউশনের ঠিক আগেই ক্লিন শিট ও অন্যান্য স্ট্যাটস আপডেট করে নেওয়া হচ্ছে
    const currentMatch = await Match.findById(matchId);
    if (currentMatch && currentMatch.fixtureId) {
      await processMatchStatistics(matchId, currentMatch.fixtureId);
    }

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
        if ((startingGK.pts || 0) === 0 && (benchGK.pts || 0) > 0) {
          starters[startingGkIndex] = benchGK;
          bench[benchGkIndex] = startingGK; // Swap
          hasChanges = true;
        }
      }

      // 2. Sub Outfield Players
      for (let i = 0; i < starters.length; i++) {
        const starter = starters[i];
        if (!starter || starter.pos === 'GK' || (starter.pts || 0) > 0) continue;

        for (let j = 0; j < bench.length; j++) {
          const sub = bench[j];
          if (!sub || sub.pos === 'GK' || (sub.pts || 0) === 0) continue;

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
        // গ্লোবাল পয়েন্ট (p.pts) এর বদলে এই ম্যাচের স্পেসিফিক পয়েন্ট (playerPoints) নিতে হবে
        let pts = Number(team.playerPoints?.get(p._id.toString()) || 0);
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

    // 5. Prize Distribution for Rooms with Entry Fees
    const roomsToDistribute = await Room.find({ match: matchId, entryFeeAmount: { $gt: 0 }, isPrizeDistributed: false });

    for (const room of roomsToDistribute) {
      if (room.prizePool <= 0) {
        room.isPrizeDistributed = true;
        await room.save();
        continue;
      }

      const roomLeaderboard = await Room.findById(room._id)
        .populate({ path: 'members.user', select: 'name profilePicture coinBalance notifications' })
        .populate({ path: 'members.team', select: 'totalPoints' });

      if (!roomLeaderboard) continue;

      const sortedMembers = roomLeaderboard.members
        .filter(m => m.team && m.user) // Only consider members with a team and valid user
        .sort((a, b) => (b.team?.totalPoints || 0) - (a.team?.totalPoints || 0));

      // Dynamic distribution based on player count
      const is1v1 = room.challengeType === '1v1';
      const prizeDistribution = is1v1 
        ? { '1st': 1.0, '2nd': 0, '3rd': 0 } 
        : { '1st': 0.5, '2nd': 0.3, '3rd': 0.2 };

      // Distribute prizes to top 3, or fewer if less than 3 players
      if (sortedMembers.length > 0) {
        const firstPlace = sortedMembers[0];
        const firstPlacePrize = Math.round(room.prizePool * (prizeDistribution['1st'] || 0));
        
        if (firstPlace.user) {
          firstPlace.user.coinBalance = (firstPlace.user.coinBalance || 0) + firstPlacePrize;
          firstPlace.user.notifications.push({
            title: "🏆 Challenge Won!",
            message: `You won ${firstPlacePrize} coins in "${room.name}"! Points: ${firstPlace.team?.totalPoints || 0}`,
            isRead: false,
            createdAt: new Date()
          });
          if (is1v1) firstPlace.user.wins = (firstPlace.user.wins || 0) + 1;
          await firstPlace.user.save();
        }

        // Second Place (Only if not 1v1 and has at least 2 players)
        if (!is1v1 && sortedMembers.length > 1) {
          const secondPlace = sortedMembers[1];
          const secondPlacePrize = Math.round(room.prizePool * (prizeDistribution['2nd'] || 0));
          if (secondPlace.user) {
            secondPlace.user.coinBalance = (secondPlace.user.coinBalance || 0) + secondPlacePrize;
            secondPlace.user.notifications.push({
              title: "🥈 Challenge Runner-up!",
              message: `You secured 2nd place in "${room.name}" and won ${secondPlacePrize} coins!`,
              isRead: false,
              createdAt: new Date()
            });
            await secondPlace.user.save();
          }
        }

        // Third Place (Only if not 1v1 and has at least 3 players)
        if (!is1v1 && sortedMembers.length > 2) {
          const thirdPlace = sortedMembers[2];
          const thirdPlacePrize = Math.round(room.prizePool * (prizeDistribution['3rd'] || 0));
          if (thirdPlace.user) {
            thirdPlace.user.coinBalance = (thirdPlace.user.coinBalance || 0) + thirdPlacePrize;
            thirdPlace.user.notifications.push({
              title: "🥉 Challenge Third Place!",
              message: `You secured 3rd place in "${room.name}" and won ${thirdPlacePrize} coins!`,
              isRead: false,
              createdAt: new Date()
            });
            await thirdPlace.user.save();
          }
        }
      }
      room.isPrizeDistributed = true;
      await room.save();
      console.log(`✅ Prizes distributed for room: ${room.name}`);
    }
  } catch (error) {
    console.error("❌ Error in Auto-Sub:", error);
  }
};

// @desc    Get all matches
// @route   GET /api/matches
// @access  Public
export const getMatches = async (req, res) => {
  const { admin, q } = req.query; // অ্যাডমিন প্যানেল থেকে আসলে ?admin=true থাকবে, সার্চের জন্য q
  try {
    const now = Date.now();
    
    // পাবলিক অ্যাপের রিকোয়েস্ট এবং সার্চ না থাকলে ক্যাশ ব্যবহার করা হবে
    if (!admin && !q && matchCache.data && (now - matchCache.lastFetch < CACHE_TTL)) {
      return res.status(200).json(matchCache.data);
    }

    // ম্যানুয়ালি এলাউ করা আইডিগুলো আনা
    const manualLeagues = await AllowedLeague.find().select('leagueId');
    const manualIds = manualLeagues.map(l => l.leagueId);

    // Note: deleteMany removed from here. 
    // Heavy write operations should never run inside a high-frequency GET route.
    // Use the /api/matches/cleanup route or a cron job instead.

    // ফিল্টার তৈরি করা
    let matchFilter = admin ? {} : {
      $or: [{ league: { $regex: TOP_LEAGUES_REGEX } }, { leagueId: { $in: manualIds } }]
    };

    // যদি সার্চ কুয়েরি থাকে, তবে ফিল্টারে যোগ করা হবে
    if (q) {
      const searchQuery = {
        $or: [
          { homeTeam: { $regex: q, $options: 'i' } },
          { awayTeam: { $regex: q, $options: 'i' } },
          { league: { $regex: q, $options: 'i' } }
        ]
      };
      matchFilter = admin ? searchQuery : { $and: [matchFilter, searchQuery] };
    }

    const matches = await Match.find(matchFilter).sort({ isFeatured: -1, matchTime: 1 });

    if (!admin) {
      matchCache.data = matches;
      matchCache.lastFetch = now;
    }

    res.status(200).json(matches);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching matches', error: error.message });
  }
};

// @desc    Search/Suggest matches for admin live streams page
// @route   GET /api/matches/search
// @access  Admin/Private
export const searchMatches = async (req, res) => {
  const { q } = req.query;
  try {
    if (!q || q.trim() === '') return res.status(200).json([]);
    
    // লাইভ এবং আপকামিং ম্যাচগুলো সার্চ করা হচ্ছে
    let matches = await Match.find({
      $or: [
        { homeTeam: { $regex: q, $options: 'i' } },
        { awayTeam: { $regex: q, $options: 'i' } },
        { league: { $regex: q, $options: 'i' } }
      ],
      status: { $ne: 'Finished' } // শেষ হয়ে যাওয়া ম্যাচগুলো সাজেশনে আসবে না
    }).limit(15);

    // সাজেশন প্রায়োরিটি: ১. লাইভ ম্যাচ, ২. সার্চ টেক্সট দিয়ে শুরু হওয়া টিম
    matches.sort((a, b) => {
      if (a.status === 'Live' && b.status !== 'Live') return -1;
      if (a.status !== 'Live' && b.status === 'Live') return 1;
      
      const aStarts = a.homeTeam.toLowerCase().startsWith(q.toLowerCase()) || a.awayTeam.toLowerCase().startsWith(q.toLowerCase());
      const bStarts = b.homeTeam.toLowerCase().startsWith(q.toLowerCase()) || b.awayTeam.toLowerCase().startsWith(q.toLowerCase());
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      return new Date(a.matchTime) - new Date(b.matchTime);
    });

    res.status(200).json(matches.slice(0, 10));
  } catch (error) {
    res.status(500).json({ message: 'Search suggestion failed', error: error.message });
  }
};

// --- Manual Allowed Leagues Management ---

export const getAllowedLeagues = async (req, res) => {
  try {
    const leagues = await AllowedLeague.find().sort({ addedAt: -1 });
    res.status(200).json(leagues);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addAllowedLeague = async (req, res) => {
  const { leagueId, name } = req.body;
  try {
    const exists = await AllowedLeague.findOne({ leagueId });
    if (exists) return res.status(400).json({ message: 'League already allowed' });

    const league = await AllowedLeague.create({ leagueId, name });
    clearMatchCache();
    res.status(201).json(league);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const removeAllowedLeague = async (req, res) => {
  try {
    await AllowedLeague.findByIdAndDelete(req.params.id);
    clearMatchCache();
    res.status(200).json({ message: 'League removed from manual allowance' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Manual cleanup of database (Delete old and lower tier matches)
// @desc    Manual cleanup of database (Delete old and lower tier matches)
// @route   POST /api/matches/cleanup
// @access  Admin/Private
export const manualCleanup = async (req, res) => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const result = await Match.deleteMany({
      $or: [
        { fixtureId: null },
        { league: { $not: TOP_LEAGUES_REGEX } },
        { league: { $regex: EXCLUDED_LEAGUES_REGEX } },
        { status: 'Finished', matchTime: { $lt: yesterday } }
      ]
    });

    clearMatchCache();
    res.status(200).json({ 
      success: true, 
      message: 'Database cleanup completed successfully', 
      deletedCount: result.deletedCount 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Cleanup failed', error: error.message });
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

  // ডাটাবেসে প্লেয়ারের পয়েন্ট লাইভ আপডেট করা হচ্ছে
  if (event.playerId && event.numPts) {
    await Player.findByIdAndUpdate(event.playerId, { $inc: { pts: event.numPts } });

    // ২. এই প্লেয়ার যেসব ফ্যান্টাসি টিমে আছে, তাদের totalPoints লাইভ আপডেট করা (Real-time Match Leaderboard এর জন্য)
    const teams = await FantasyTeam.find({ players: event.playerId });
    for (const team of teams) {
      // চেক করা হচ্ছে প্লেয়ারটি মূল একাদশে (প্রথম ১১ জন) আছে কি না (বেঞ্চ প্লেয়ার পয়েন্ট পাবে না)
      const starters = team.players.length === 15 ? team.players.slice(0, 11) : team.players;
      const isStarter = starters.some(pId => pId.toString() === event.playerId.toString());
      
      if (isStarter) {
        let ptsToAdd = event.numPts;
        if (team.captain && team.captain.toString() === event.playerId.toString()) ptsToAdd *= 2;
        else if (team.viceCaptain && team.viceCaptain.toString() === event.playerId.toString()) ptsToAdd *= 1.5;
        
        team.totalPoints = (team.totalPoints || 0) + ptsToAdd;
        await team.save();
      }
    }
  }

  // Socket.io দিয়ে নির্দিষ্ট রুমের সব ইউজারের কাছে লাইভ ইভেন্ট পাঠানো হচ্ছে
  io.to(roomId).emit("live_event", event);
  
  // গ্লোবাল লিডারবোর্ড রিয়েল-টাইম রিফ্রেশ করার জন্য সিগন্যাল পাঠানো
  io.emit("refresh_global_leaderboard");
  
  // ক্যাশ ক্লিয়ার করা যাতে লাইভ ইভেন্টের পর সাথে সাথে নতুন স্কোর পাওয়া যায়
  clearMatchCache();
  clearLeaderboardCache();

  res.status(200).json({ success: true, message: "Live event triggered successfully", event });
};

// @desc    Manually sync real matches from API-Football
// @route   POST /api/matches/sync
// @access  Public
export const syncMatches = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await fetchWithRotation(`fixtures?date=${today}`);

    if (data.response && data.response.length > 0) {
      const manualLeagues = await AllowedLeague.find().select('leagueId');
      const manualIds = manualLeagues.map(l => l.leagueId);

      // ✅ আইডি এবং নাম—উভয়ভাবেই ফিল্টার করা হচ্ছে যাতে ভুল ম্যাচ না ঢুকে
      const filteredResponse = data.response.filter(item =>
        manualIds.includes(item.league.id) || 
        ((TOP_LEAGUE_IDS.includes(item.league.id) || TOP_LEAGUES_REGEX.test(item.league.name)) && 
        !EXCLUDED_LEAGUES_REGEX.test(item.league.name))
      );

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
              if (io) io.emit("match_finished");
            }
            existingMatch.status = status;
            existingMatch.homeLogo = item.teams.home.logo || existingMatch.homeLogo;
            existingMatch.awayLogo = item.teams.away.logo || existingMatch.awayLogo;
            existingMatch.homeTeamApiId = item.teams.home.id || existingMatch.homeTeamApiId;
            existingMatch.awayTeamApiId = item.teams.away.id || existingMatch.awayTeamApiId;
            existingMatch.homeScore = item.goals.home || 0;
            existingMatch.awayScore = item.goals.away || 0;
            existingMatch.minute = item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : "0'";
            await existingMatch.save();
          } else {
            await Match.create({
              fixtureId: item.fixture.id, homeTeam: item.teams.home.name,
              awayTeam: item.teams.away.name, homeLogo: item.teams.home.logo || '',
              homeTeamApiId: item.teams.home.id,
              awayTeamApiId: item.teams.away.id,
              awayLogo: item.teams.away.logo || '', homeScore: item.goals.home || 0,
              awayScore: item.goals.away || 0, status: status,
              matchTime: new Date(item.fixture.date), league: item.league.name, leagueId: item.league.id,
              minute: item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : "0'",
              roomsCount: Math.floor(Math.random() * 10) + 1
            });
          }
        }
        
        for (const mId of finishedMatchIds) {
          await processAutoSubsAndRewards(mId);
        }
        
        // ক্যাশ ক্লিয়ার করা
        clearMatchCache();
        clearLeaderboardCache();

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

// @desc    Proxy requests to API-Sports and log errors
// @route   GET /api/matches/proxy/:resource
// @access  Public
export const proxyFootballData = async (req, res) => {
  const { resource } = req.params;

  console.log(`\n[PROXY REQUEST] Target Resource: ${resource} | Query:`, req.query);

  try {
    const queryParams = new URLSearchParams(req.query).toString();
    const endpoint = `${resource}${queryParams ? '?' + queryParams : ''}`;

    console.log(`📡 [PROXY] Fetching Resource: ${resource}`);

    const data = await fetchWithRotation(endpoint);

    // API-Sports এর নিজস্ব কোনো error আছে কি না চেক করে লগে দেখানো
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error("❌ [API-SPORTS ERROR] The external API returned an error:\n", JSON.stringify(data.errors, null, 2));
    } else {
      console.log(`✅ [PROXY SUCCESS] Results found: ${data.results}`);
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("❌ [PROXY SERVER ERROR] Fetch failed:", error.message);
    res.status(500).json({ message: 'Server error proxying data', error: error.message });
  }
};
