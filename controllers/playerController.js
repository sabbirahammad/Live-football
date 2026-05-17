import Player from '../models/Player.js';
import Match from '../models/Match.js';

const calculatePlayerPrice = (apiId, pos) => {
  const seed = (apiId * 9301 + 49297) % 233280 / 233280;

  let min;
  let max;
  switch (pos) {
    case 'FWD': min = 8.0; max = 12.0; break;
    case 'MID': min = 6.5; max = 10.0; break;
    case 'DEF': min = 5.0; max = 7.5; break;
    case 'GK': min = 4.0; max = 6.0; break;
    default: min = 6.0; max = 8.0;
  }

  const rawPrice = min + (seed * (max - min));
  return Math.round(rawPrice * 2) / 2;
};

const positionMap = {
  Goalkeeper: 'GK',
  Defender: 'DEF',
  Midfielder: 'MID',
  Attacker: 'FWD',
  G: 'GK',
  D: 'DEF',
  M: 'MID',
  F: 'FWD'
};

const mapStatus = (shortStatus) => (
  ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(shortStatus)
    ? 'Live'
    : ['FT', 'AET', 'PEN'].includes(shortStatus)
      ? 'Finished'
      : 'Upcoming'
);

const fetchApiSportsJson = async (url, apiKey) => {
  const response = await fetch(url, {
    headers: { 'x-apisports-key': apiKey }
  });
  return response.json();
};

const normalizeTeamName = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\b(fc|cf|sc|ac|afc|fk|club|deportivo|sporting|athletic|atletico|united|city|club de futbol)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const teamNameTokens = (value) => normalizeTeamName(value).split(' ').filter(Boolean);

const tokenOverlapScore = (aValue, bValue) => {
  const aTokens = teamNameTokens(aValue);
  const bTokens = teamNameTokens(bValue);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const bSet = new Set(bTokens);
  let hits = 0;
  for (const token of aTokens) {
    if (bSet.has(token)) hits += 1;
  }
  return hits / Math.max(aTokens.length, bTokens.length);
};

const buildSearchVariants = (teamName) => {
  const raw = String(teamName || '').trim();
  const normalized = normalizeTeamName(teamName);
  const tokens = normalized.split(' ').filter(Boolean);
  const variants = new Set([raw, normalized]);

  if (tokens.length > 1) {
    variants.add(tokens.slice(0, 2).join(' '));
    variants.add(tokens.slice(-2).join(' '));
  }
  if (tokens.length > 0) {
    variants.add(tokens[0]);
  }

  return [...variants].filter(v => v && v.length >= 3);
};

const pickBestTeamMatch = (teams = [], teamName) => {
  const normalizedTarget = normalizeTeamName(teamName);
  let best = null;
  let bestScore = 0;

  for (const team of teams) {
    const candidateName = team?.team?.name;
    const normalizedCandidate = normalizeTeamName(candidateName);
    if (!normalizedCandidate) continue;

    if (normalizedCandidate === normalizedTarget) return team;

    let score = tokenOverlapScore(candidateName, teamName);
    if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) {
      score = Math.max(score, 0.9);
    }

    if (score > bestScore) {
      best = team;
      bestScore = score;
    }
  }

  return bestScore >= 0.5 ? best : null;
};

const sameTeams = (fixture, match) => {
  const home = normalizeTeamName(fixture?.teams?.home?.name);
  const away = normalizeTeamName(fixture?.teams?.away?.name);
  const matchHome = normalizeTeamName(match?.homeTeam);
  const matchAway = normalizeTeamName(match?.awayTeam);

  const exactOrder = home === matchHome && away === matchAway;
  const looseOrder = home.includes(matchHome) || matchHome.includes(home) || tokenOverlapScore(home, matchHome) >= 0.5;
  const looseAway = away.includes(matchAway) || matchAway.includes(away) || tokenOverlapScore(away, matchAway) >= 0.5;

  return exactOrder || (looseOrder && looseAway);
};

const resolveFixtureByDate = async (match, apiKey) => {
  if (!match?.matchTime) return null;

  const baseDate = new Date(match.matchTime);
  const offsets = [-2, -1, 0, 1, 2];

  for (const offset of offsets) {
    const probeDate = new Date(baseDate);
    probeDate.setUTCDate(probeDate.getUTCDate() + offset);
    const y = probeDate.getUTCFullYear();
    const m = String(probeDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(probeDate.getUTCDate()).padStart(2, '0');
    const dateParam = `${y}-${m}-${d}`;

    const fixtureData = await fetchApiSportsJson(`https://v3.football.api-sports.io/fixtures?date=${dateParam}`, apiKey);
    const matchedFixture = (fixtureData?.response || []).find(item => sameTeams(item, match));
    if (matchedFixture?.teams?.home?.id && matchedFixture?.teams?.away?.id) {
      return matchedFixture;
    }
  }

  return null;
};

const createMatchFromFixture = async (matchId, apiKey) => {
  const fixtureData = await fetchApiSportsJson(`https://v3.football.api-sports.io/fixtures?id=${matchId}`, apiKey);
  const item = fixtureData?.response?.[0];
  if (!item) return null;

  return Match.create({
    fixtureId: item.fixture.id,
    homeTeam: item.teams.home.name,
    awayTeam: item.teams.away.name,
    homeLogo: item.teams.home.logo || '',
    awayLogo: item.teams.away.logo || '',
    homeTeamApiId: item.teams.home.id,
    awayTeamApiId: item.teams.away.id,
    matchTime: new Date(item.fixture.date),
    league: item.league.name,
    status: mapStatus(item.fixture.status.short)
  });
};

const resolveTeamIdsForMatch = async (match, apiKey) => {
  if (match.homeTeamApiId && match.awayTeamApiId) {
    return {
      homeTeamId: match.homeTeamApiId,
      awayTeamId: match.awayTeamApiId
    };
  }

  if (match.fixtureId) {
    const fixtureData = await fetchApiSportsJson(`https://v3.football.api-sports.io/fixtures?id=${match.fixtureId}`, apiKey);
    const fixture = fixtureData?.response?.[0];
    if (fixture?.teams?.home?.id && fixture?.teams?.away?.id) {
      match.homeTeamApiId = fixture.teams.home.id;
      match.awayTeamApiId = fixture.teams.away.id;
      match.homeLogo = fixture.teams.home.logo || match.homeLogo;
      match.awayLogo = fixture.teams.away.logo || match.awayLogo;
      await match.save();
      return {
        homeTeamId: match.homeTeamApiId,
        awayTeamId: match.awayTeamApiId
      };
    }
  }

  const datedFixture = await resolveFixtureByDate(match, apiKey);
  if (datedFixture?.teams?.home?.id && datedFixture?.teams?.away?.id) {
    match.fixtureId = datedFixture.fixture?.id || match.fixtureId;
    match.homeTeamApiId = datedFixture.teams.home.id;
    match.awayTeamApiId = datedFixture.teams.away.id;
    match.homeLogo = datedFixture.teams.home.logo || match.homeLogo;
    match.awayLogo = datedFixture.teams.away.logo || match.awayLogo;
    await match.save();
    return {
      homeTeamId: match.homeTeamApiId,
      awayTeamId: match.awayTeamApiId
    };
  }

  const searchTeamWithVariants = async (teamName) => {
    const variants = buildSearchVariants(teamName);
    const results = [];
    for (const variant of variants) {
      const response = await fetchApiSportsJson(`https://v3.football.api-sports.io/teams?search=${encodeURIComponent(variant)}`, apiKey);
      if (Array.isArray(response?.response)) {
        results.push(...response.response);
      }
    }
    return pickBestTeamMatch(results, teamName);
  };

  const [homeTeam, awayTeam] = await Promise.all([
    searchTeamWithVariants(match.homeTeam),
    searchTeamWithVariants(match.awayTeam)
  ]);

  if (!homeTeam?.team?.id || !awayTeam?.team?.id) {
    return null;
  }

  match.homeTeamApiId = homeTeam.team.id;
  match.awayTeamApiId = awayTeam.team.id;
  match.homeLogo = homeTeam.team.logo || match.homeLogo;
  match.awayLogo = awayTeam.team.logo || match.awayLogo;
  await match.save();

  return {
    homeTeamId: match.homeTeamApiId,
    awayTeamId: match.awayTeamApiId
  };
};

const syncPlayersForExistingMatch = async (match, apiKey) => {
  const teamIds = await resolveTeamIdsForMatch(match, apiKey);
  if (!teamIds?.homeTeamId || !teamIds?.awayTeamId) {
    return null;
  }

  const requests = [
    fetchApiSportsJson(`https://v3.football.api-sports.io/players/squads?team=${teamIds.homeTeamId}`, apiKey),
    fetchApiSportsJson(`https://v3.football.api-sports.io/players/squads?team=${teamIds.awayTeamId}`, apiKey),
    match.fixtureId
      ? fetchApiSportsJson(`https://v3.football.api-sports.io/injuries?fixture=${match.fixtureId}`, apiKey)
      : Promise.resolve({ response: [] })
  ];

  const [homeSquadData, awaySquadData, injuryData] = await Promise.all(requests);

  const injuredPlayerIds = new Set();
  if (injuryData?.response) {
    injuryData.response.forEach(inj => {
      if (inj.player?.id) injuredPlayerIds.add(inj.player.id);
    });
  }

  const squads = [];
  if (homeSquadData?.response?.length > 0) squads.push(homeSquadData.response[0]);
  if (awaySquadData?.response?.length > 0) squads.push(awaySquadData.response[0]);

  if (squads.length === 0) {
    return [];
  }

  const bulkOps = [];
  const playerApiIds = [];

  for (const teamData of squads) {
    for (const p of teamData.players || []) {
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
  }

  const playerDocs = await Player.find({ apiId: { $in: playerApiIds } });
  match.players = playerDocs.map(p => p._id);
  await match.save();
  return playerDocs;
};

export const getPlayers = async (req, res) => {
  try {
    const players = await Player.find({});
    res.status(200).json(players);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching players', error: error.message });
  }
};

export const getPlayersForMatch = async (req, res) => {
  try {
    const matchId = req.params.matchId;
    let match = null;

    if (!isNaN(matchId)) {
      match = await Match.findOne({ fixtureId: Number(matchId) }).populate('players');
    } else if (matchId.length === 24) {
      match = await Match.findById(matchId).populate('players');
    }

    if (!match && !isNaN(matchId) && process.env.FOOTBALL_API_KEY) {
      console.log(`Auto-syncing Match ${matchId} to DB...`);
      match = await createMatchFromFixture(matchId, process.env.FOOTBALL_API_KEY);
      if (match) {
        match = await Match.findById(match._id).populate('players');
      }
    }

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    if (match.players.length === 0 && process.env.FOOTBALL_API_KEY) {
      console.log(`Auto-syncing players for match: ${match.homeTeam} vs ${match.awayTeam}`);
      const playerDocs = await syncPlayersForExistingMatch(match, process.env.FOOTBALL_API_KEY);
      if (Array.isArray(playerDocs) && playerDocs.length > 0) {
        return res.status(200).json(playerDocs);
      }
    }

    res.status(200).json(match.players);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching players', error: error.message });
  }
};

export const syncPlayersForMatch = async (req, res) => {
  const { matchId } = req.params;
  const apiKey = process.env.FOOTBALL_API_KEY;

  if (!apiKey) {
    return res.status(400).json({ message: "FOOTBALL_API_KEY not found in .env" });
  }

  try {
    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: 'Match not found.' });
    }

    console.log(`Syncing players for match: ${match.homeTeam} vs ${match.awayTeam}`);
    const playerDocs = await syncPlayersForExistingMatch(match, apiKey);

    if (playerDocs === null) {
      return res.status(404).json({ message: 'Could not resolve team IDs for this match from API.' });
    }

    if (playerDocs.length === 0) {
      return res.status(404).json({ message: 'No squad data found for these teams from API.' });
    }

    res.status(200).json({
      message: `Synced ${playerDocs.length} players for match ${match.homeTeam} vs ${match.awayTeam}`,
      players: playerDocs
    });
  } catch (error) {
    console.error("Error syncing players:", error);
    res.status(500).json({ message: 'Server error syncing players', error: error.message });
  }
};
