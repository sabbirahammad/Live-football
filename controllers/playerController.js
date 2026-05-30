import Player from '../models/Player.js';
import Match from '../models/Match.js';

// একাধিক API কী হ্যান্ডেল করার জন্য হেল্পার
const getApiKeys = () => {
  const primary = process.env.FOOTBALL_API_KEY || '';
  const multiple = process.env.FOOTBALL_API_KEYS || '';
  const combined = `${primary},${multiple}`;
  return [...new Set(combined.split(',').map(k => k.trim()).filter(Boolean))];
};

// কমন ফেচ লজিক যা কী রোটেশন সাপোর্ট করে
const fetchWithRotation = async (endpoint) => {
  const keys = getApiKeys();
  for (let key of keys) {
    const res = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
      headers: { 'x-apisports-key': key }
    });
    const data = await res.json();
    // যদি লিমিট শেষ না হয়, তবে ডেটা রিটার্ন করবে
    if (!(data.errors && data.errors.requests)) return data;
    console.log(`API Key ${key.slice(0, 5)}... reached limit, trying next...`);
  }
  return { errors: { requests: "All API keys reached their daily limit." } };
};

// Helper function to generate realistic and consistent player prices based on their position
const calculatePlayerPrice = (apiId, pos) => {
  // Deterministic pseudo-random number between 0 and 1 based on player ID
  // This ensures a specific player (e.g., Messi) always gets the exact same price every time we sync
  const seed = (apiId * 9301 + 49297) % 233280 / 233280;
  
  let min, max;
  switch (pos) {
    case 'FWD': min = 8.0; max = 12.0; break; // Attackers are expensive
    case 'MID': min = 6.5; max = 10.0; break; // Midfielders are medium-high
    case 'DEF': min = 5.0; max = 7.5; break;  // Defenders are medium
    case 'GK': min = 4.0; max = 6.0; break;   // Goalkeepers are cheap
    default: min = 6.0; max = 8.0;
  }
  
  // Calculate price and round to nearest 0.5 (e.g., 8.0, 8.5, 11.5)
  const rawPrice = min + (seed * (max - min));
  return Math.round(rawPrice * 2) / 2;
};

// @desc    Get all players
// @route   GET /api/players
// @access  Public
export const getPlayers = async (req, res) => {
  try {
    const players = await Player.find({});
    res.status(200).json(players);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching players', error: error.message });
  }
};

// @desc    Get all players for a specific match from DB
// @route   GET /api/players/:matchId
// @access  Public
export const getPlayersForMatch = async (req, res) => {
  try {
    const matchId = req.params.matchId;
    let match;

    if (!isNaN(matchId)) {
      match = await Match.findOne({ fixtureId: Number(matchId) }).populate('players');
    } else if (matchId.length === 24) {
      match = await Match.findById(matchId).populate('players');
    }

    // Auto-sync Match from API-Football if not in MongoDB
    if (!match && !isNaN(matchId)) {
      console.log(`Auto-syncing Match ${matchId} to DB...`);
      const fixtureData = await fetchWithRotation(`fixtures?id=${matchId}`);
      
      if (fixtureData.errors && Object.keys(fixtureData.errors).length > 0) {
        if (fixtureData.errors.requests) {
          return res.status(429).json({ message: `API-Sports Error: ${Object.values(fixtureData.errors)[0]}` });
        }
      }

      if (fixtureData.response && fixtureData.response.length > 0) {
        const item = fixtureData.response[0];
        match = await Match.create({
          fixtureId: item.fixture.id,
          homeTeam: item.teams.home.name,
          awayTeam: item.teams.away.name,
          homeLogo: item.teams.home.logo || '',
          awayLogo: item.teams.away.logo || '',
          matchTime: new Date(item.fixture.date),
          league: item.league.name,
          status: ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(item.fixture.status.short) ? 'Live' :
            ['FT', 'AET', 'PEN'].includes(item.fixture.status.short) ? 'Finished' : 'Upcoming'
        });
      }
    }

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // Auto-sync players if empty
    if (match.players.length === 0 && match.fixtureId) {
        console.log(`Auto-syncing players for fixture ID: ${match.fixtureId}`);
        
        let homeTeamId = match.homeTeamApiId;
        let awayTeamId = match.awayTeamApiId;

        if (!homeTeamId || !awayTeamId) {
          const fixtureData = await fetchWithRotation(`fixtures?id=${match.fixtureId}`);

          if (fixtureData.errors && Object.keys(fixtureData.errors).length > 0) {
            return res.status(429).json({ message: `API-Sports Error: ${Object.values(fixtureData.errors)[0]}` });
          }

          if (fixtureData.response && fixtureData.response.length > 0) {
            homeTeamId = fixtureData.response[0].teams.home.id;
            awayTeamId = fixtureData.response[0].teams.away.id;
            
            match.homeTeamApiId = homeTeamId;
            match.awayTeamApiId = awayTeamId;
            await match.save();
          } else {
            return res.status(404).json({ message: 'Match details not found from API.' });
          }
        }

        if (homeTeamId && awayTeamId) {
          const calendarYear = new Date().getFullYear();
          const footballSeason = new Date().getMonth() >= 7 ? calendarYear : calendarYear - 1;

          // ২. Home, Away টিমের স্কোয়াড এবং ইনজুরি লিস্ট আনা (রোটেশনসহ)
          const [homeSquadRes, awaySquadRes, injuryRes] = await Promise.all([
            fetchWithRotation(`players/squads?team=${homeTeamId}`),
            fetchWithRotation(`players/squads?team=${awayTeamId}`),
            fetchWithRotation(`injuries?fixture=${match.fixtureId}`)
          ]);
          
          let homeSquadData = homeSquadRes;
          let awaySquadData = awaySquadRes;
          const injuryData = injuryRes;

          // Fallback 1: ফুটবল সিজন অনুযায়ী প্লেয়ারদের খোঁজা
          if (!homeSquadData.response || homeSquadData.response.length === 0) {
            const fb = await fetchWithRotation(`players?team=${homeTeamId}&season=${footballSeason}`);
            if (fb.response?.length > 0) homeSquadData = { response: [{ team: fb.response[0].statistics[0].team, players: fb.response.map(x => x.player) }] };
          }
          // Fallback 2: ক্যালেন্ডার ইয়ার অনুযায়ী খোঁজা (ইন্টারন্যাশনাল ম্যাচের জন্য কার্যকরী)
          if (!homeSquadData.response || homeSquadData.response.length === 0) {
            const fb = await fetchWithRotation(`players?team=${homeTeamId}&season=${calendarYear}`);
            if (fb.response?.length > 0) homeSquadData = { response: [{ team: fb.response[0].statistics[0].team, players: fb.response.map(x => x.player) }] };
          }

          if (!awaySquadData.response || awaySquadData.response.length === 0) {
            const fb = await fetchWithRotation(`players?team=${awayTeamId}&season=${footballSeason}`);
            if (fb.response?.length > 0) awaySquadData = { response: [{ team: fb.response[0].statistics[0].team, players: fb.response.map(x => x.player) }] };
          }
          if (!awaySquadData.response || awaySquadData.response.length === 0) {
            const fb = await fetchWithRotation(`players?team=${awayTeamId}&season=${calendarYear}`);
            if (fb.response?.length > 0) awaySquadData = { response: [{ team: fb.response[0].statistics[0].team, players: fb.response.map(x => x.player) }] };
          }

          const injuredPlayerIds = new Set();
          if (injuryData.response) {
            injuryData.response.forEach(inj => {
              if (inj.player && inj.player.id) injuredPlayerIds.add(inj.player.id);
            });
          }

          const squads = [];
          if (homeSquadData.response && homeSquadData.response.length > 0) squads.push(homeSquadData.response[0]);
          if (awaySquadData.response && awaySquadData.response.length > 0) squads.push(awaySquadData.response[0]);

          if (squads.length > 0) {
            const positionMap = { 
              'Goalkeeper': 'GK', 'Defender': 'DEF', 'Midfielder': 'MID', 'Attacker': 'FWD',
              'G': 'GK', 'D': 'DEF', 'M': 'MID', 'F': 'FWD' 
            };
          const bulkOps = [];
          const playerApiIds = [];

            for (const teamData of squads) {
              for (const p of teamData.players) {
                playerApiIds.push(p.id);
                const mappedPos = positionMap[p.position] || positionMap[p.pos] || 'MID';
              bulkOps.push({
                updateOne: {
                  filter: { apiId: p.id },
                  update: {
                    $set: {
                      apiId: p.id,
                      name: p.name,
                        pos: mappedPos,
                        price: calculatePlayerPrice(p.id, mappedPos),
                        teamApiId: teamData.team.id,
                        team: teamData.team.name,
                        teamLogo: teamData.team.logo || '',
                        isInjured: injuredPlayerIds.has(p.id),
                      img: p.photo,
                    }
                  },
                  upsert: true
                }
              });
            }
          }

          if (bulkOps.length > 0) {
            await Player.bulkWrite(bulkOps);
            console.log(`Bulk write successful for ${bulkOps.length} players.`);
          }

          const playerDocs = await Player.find({ apiId: { $in: playerApiIds } });
          const playerObjectIds = playerDocs.map(p => p._id);

          match.players = playerObjectIds;
          await match.save();

          // সিঙ্ক হওয়ার পর সরাসরি অবজেক্টগুলোই পাঠাবো
          return res.status(200).json(playerDocs);
        }
    }

    // যদি সিঙ্ক না লাগে, ডাটাবেস থেকে সব প্লেয়ার অবজেক্ট খুঁজে পাঠাবো (id নয়)
    const existingPlayers = await Player.find({ _id: { $in: match.players } });
    res.status(200).json(existingPlayers);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching players', error: error.message });
  }
};

// @desc    Sync players for a match from API-Football and save to DB
// @route   POST /api/players/sync/:matchId
// @access  Private
export const syncPlayersForMatch = async (req, res) => {
  const { matchId } = req.params;

  try {
    const match = await Match.findById(matchId);
    if (!match || !match.fixtureId) {
      return res.status(404).json({ message: 'Match or fixture ID not found.' });
    }

    console.log(`Syncing players for fixture ID: ${match.fixtureId}`);

    let homeTeamId = match.homeTeamApiId;
    let awayTeamId = match.awayTeamApiId;

    if (!homeTeamId || !awayTeamId) {
      const fixtureData = await fetchWithRotation(`fixtures?id=${match.fixtureId}`);

      if (fixtureData.errors && Object.keys(fixtureData.errors).length > 0) {
        return res.status(429).json({ message: `API-Sports Error: ${Object.values(fixtureData.errors)[0]}` });
      }

      if (!fixtureData.response || fixtureData.response.length === 0) {
        return res.status(404).json({ message: 'Match details not found from API.' });
      }

      homeTeamId = fixtureData.response[0].teams.home.id;
      awayTeamId = fixtureData.response[0].teams.away.id;
      match.homeTeamApiId = homeTeamId;
      match.awayTeamApiId = awayTeamId;
      await match.save();
    }

    if (!homeTeamId || !awayTeamId) {
      return res.status(400).json({ message: "Could not resolve team IDs for this match from API." });
    }

    const currentYear = new Date().getFullYear();
    const season = new Date().getMonth() >= 7 ? currentYear : currentYear - 1;

    const [homeSquadData, awaySquadData, injuryData] = await Promise.all([
      fetchWithRotation(`players/squads?team=${homeTeamId}`),
      fetchWithRotation(`players/squads?team=${awayTeamId}`),
      fetchWithRotation(`injuries?fixture=${match.fixtureId}`)
    ]);

    if (!homeSquadData.response || homeSquadData.response.length === 0) {
      const fb = await fetchWithRotation(`players?team=${homeTeamId}&season=${season}`);
      if (fb.response?.length > 0) homeSquadData = { response: [{ team: fb.response[0].statistics[0].team, players: fb.response.map(x => x.player) }] };
    }
    if (!awaySquadData.response || awaySquadData.response.length === 0) {
      const fb = await fetchWithRotation(`players?team=${awayTeamId}&season=${season}`);
      if (fb.response?.length > 0) awaySquadData = { response: [{ team: fb.response[0].statistics[0].team, players: fb.response.map(x => x.player) }] };
    }

    const injuredPlayerIds = new Set();
    if (injuryData.response) {
      injuryData.response.forEach(inj => {
        if (inj.player && inj.player.id) injuredPlayerIds.add(inj.player.id);
      });
    }

    const squads = [];
    if (homeSquadData.response && homeSquadData.response.length > 0) squads.push(homeSquadData.response[0]);
    if (awaySquadData.response && awaySquadData.response.length > 0) squads.push(awaySquadData.response[0]);

    const positionMap = { 
      'Goalkeeper': 'GK', 'Defender': 'DEF', 'Midfielder': 'MID', 'Attacker': 'FWD',
      'G': 'GK', 'D': 'DEF', 'M': 'MID', 'F': 'FWD' 
    };
    const bulkOps = [];
    const playerApiIds = [];

    for (const teamData of squads) {
      for (const p of teamData.players) {
        playerApiIds.push(p.id);
        const mappedPos = positionMap[p.position] || positionMap[p.pos] || 'MID';
        bulkOps.push({
          updateOne: {
            filter: { apiId: p.id },
            update: {
              $set: {
                apiId: p.id,
                name: p.name,
                pos: mappedPos,
                price: calculatePlayerPrice(p.id, mappedPos),
                teamApiId: teamData.team.id,
                team: teamData.team.name,
                teamLogo: teamData.team.logo || '',
                isInjured: injuredPlayerIds.has(p.id),
                img: p.photo,
              }
            },
            upsert: true
          }
        });
      }
    }

    if (bulkOps.length > 0) {
      await Player.bulkWrite(bulkOps);
      console.log(`Bulk write successful for ${bulkOps.length} players.`);
    }

    // Get the IDs of the players we just saved/updated
    const playerDocs = await Player.find({ apiId: { $in: playerApiIds } });
    const playerObjectIds = playerDocs.map(p => p._id);

    // Update the match document with the player ObjectIDs
    match.players = playerObjectIds;
    await match.save();

    res.status(200).json({ 
      message: `Synced ${playerObjectIds.length} players for match ${match.homeTeam} vs ${match.awayTeam}`, 
      players: playerDocs 
    });

  } catch (error) {
    console.error("Error syncing players:", error);
    res.status(500).json({ message: 'Server error syncing players', error: error.message });
  }
};
