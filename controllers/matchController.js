import Match from '../models/Match.js';
import FantasyTeam from '../models/FantasyTeam.js';
import User from '../models/User.js';
import Player from '../models/Player.js';
import Room from '../models/Room.js';
import { clearLeaderboardCache } from './leaderboardController.js';

// --- In-Memory Cache Setup ---
let matchCache = {
  data: null,
  lastFetch: 0
};
const CACHE_TTL = 15 * 1000; // 15 seconds cache TTL
export const clearMatchCache = () => {
  matchCache.lastFetch = 0; // ফোর্স রিলোড করার জন্য
};

// 📊 ম্যাচ শেষে প্লেয়ারদের ফ্যান্টাসি স্ট্যাটাস (Clean Sheet, Play Time, Position-based goals) আপডেট করা
const processMatchStatistics = async (matchId, fixtureId) => {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) return;

  try {
    console.log(`\n📊 Fetching Final Player Statistics from API-Sports for Match: ${matchId}`);
    const response = await fetch(`https://v3.football.api-sports.io/fixtures/players?fixture=${fixtureId}`, {
      headers: { 'x-apisports-key': apiKey }
    });
    const data = await response.json();

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
  } catch (error) {
    console.error("❌ Error in Auto-Sub:", error);
  }
};

// @desc    Get all matches
// @route   GET /api/matches
// @access  Public
export const getMatches = async (req, res) => {
  try {
    const now = Date.now();
    // ক্যাশে ডেটা থাকলে এবং ১৫ সেকেন্ড পার না হলে সরাসরি ক্যাশ থেকে ডেটা রিটার্ন করা হবে (Lightning Fast ⚡)
    if (matchCache.data && (now - matchCache.lastFetch < CACHE_TTL)) {
      return res.status(200).json(matchCache.data);
    }

    // Remove old dummy matches without fixtureId from database to prevent polluting
    await Match.deleteMany({ fixtureId: null });
    
    // শুধুমাত্র আপনার পছন্দের টপ লিগগুলো ফিল্টার করার জন্য রেজেক্স (Regex)
    const topLeaguesRegex = /premier league|la liga|serie a|bundesliga|ligue 1|uefa champions league|ucl|world cup|fifa world cup|wc qualifiers|international|friendly|qualifiers|nations league|euro|copa america|afcon/i;

    // ডাটাবেস থেকে শুধুমাত্র এই লিগের ম্যাচগুলো আনা হবে
    const matches = await Match.find({
      league: { $regex: topLeaguesRegex }
    }).sort({ matchTime: 1 });

    // নতুন ডেটা ক্যাশে সেভ করা হচ্ছে
    matchCache.data = matches;
    matchCache.lastFetch = now;

    res.status(200).json(matches);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching matches', error: error.message });
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
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) return res.status(400).json({ message: "FOOTBALL_API_KEY not found in .env" });

  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`, {
      headers: { 'x-apisports-key': apiKey }
    });
    const data = await response.json();

    if (data.response && data.response.length > 0) {
      const topLeaguesRegex = /premier league|la liga|serie a|bundesliga|ligue 1|uefa champions league|ucl|world cup|fifa world cup|wc qualifiers|international|friendly|qualifiers|nations league|euro|copa america|afcon/i;
      
      // সিঙ্ক করার সময়ও শুধুমাত্র নির্দিষ্ট লিগের ম্যাচগুলোই ফিল্টার করা হবে
      const filteredResponse = data.response.filter(item => 
        topLeaguesRegex.test(item.league.name)
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
              matchTime: new Date(item.fixture.date), league: item.league.name,
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
  const apiKey = process.env.FOOTBALL_API_KEY;

  console.log(`\n[PROXY REQUEST] Target Resource: ${resource} | Query:`, req.query);

  if (!apiKey) {
    console.error("❌ [PROXY ERROR] FOOTBALL_API_KEY is missing in backend environment variables!");
    return res.status(500).json({ message: "Backend API Key missing" });
  }

  try {
    const queryParams = new URLSearchParams(req.query).toString();
    const url = `https://v3.football.api-sports.io/${resource}${queryParams ? '?' + queryParams : ''}`;

    console.log(`📡 [PROXY] Fetching URL: ${url}`);

    const response = await fetch(url, {
      headers: { 'x-apisports-key': apiKey },
    });

    const data = await response.json();

    // API-Sports এর নিজস্ব কোনো error আছে কি না চেক করে লগে দেখানো
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error("❌ [API-SPORTS ERROR] The external API returned an error:\n", JSON.stringify(data.errors, null, 2));
    } else {
      console.log(`✅ [PROXY SUCCESS] Results found: ${data.results}`);
    }

    res.status(response.status).json(data);
  } catch (error) {
    console.error("❌ [PROXY SERVER ERROR] Fetch failed:", error.message);
    res.status(500).json({ message: 'Server error proxying data', error: error.message });
  }
};
