import LiveMatch from '../models/LiveMatch.js';
import Match from '../models/Match.js';
import Player from '../models/Player.js';
import FantasyTeam from '../models/FantasyTeam.js';
import Room from '../models/Room.js';
import { processAutoSubsAndRewards } from '../controllers/matchController.js';
import { clearLeaderboardCache } from '../controllers/leaderboardController.js';

const LIVE_SHORT_CODES = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE']; // No change
const FINISHED_SHORT_CODES = ['FT', 'AET', 'PEN']; // No change
const TOP_LEAGUES_REGEX = /(premier league|la liga|serie a|bundesliga|ligue 1|uefa champions league|ucl|world cup|fifa world cup|wc qualifiers|international|qualifiers|nations league|euro|copa america|afcon)/i; // 'friendly' removed for consistency with EXCLUDED_LEAGUES_REGEX
const TOP_LEAGUE_IDS = [1, 2, 3, 4, 5, 9, 15, 39, 61, 78, 135, 140, 31, 32, 33, 34, 35, 10]; // Consistent with matchController

// 🚫 বাদ দেওয়া হবে এমন কি-ওয়ার্ড (Exclusion logic consistent with matchController)
const EXCLUDED_LEAGUES_REGEX = /(league b|league c|league d|division 2|division 3|division 4|serie b|2\. bundesliga|segunda|u19|u20|u21|u23|youth|reserve|relegation|play-offs|amateur|regional|conference|women|cup|trophy)/i; // More comprehensive

const getApiKeys = () => {
  const keys = (process.env.FOOTBALL_API_KEY || '') + ',' + (process.env.FOOTBALL_API_KEYS || '');
  return [...new Set(keys.split(',').map(k => k.trim()).filter(Boolean))];
};

const fetchWithRotation = async (endpoint) => {
  const keys = getApiKeys();
  for (const [index, key] of keys.entries()) {
    try {
      const res = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
        headers: { 'x-apisports-key': key }
      });
      const data = await res.json();

      if ((!data.errors || Object.keys(data.errors).length === 0) && data.response) {
        return data;
      }

      console.warn(`LiveService: Key ${index + 1} issue detected, trying next...`);
    } catch (err) {
      console.error(`LiveService: Error with key ${index + 1}:`, err.message);
    }
  }
  return { errors: { requests: "All API keys reached their daily limit." } };
};

const LIVE_POINT_RULES = {
  GoalDefault: 4, // Will be overridden dynamically based on position
  OwnGoal: -2,
  CardYellow: -2,
  CardRed: -5,
  VarRed: -5,
  PenaltyMissed: -3,
};

const getTeamPlayerPoints = (team, playerId) => {
  const key = playerId?.toString?.() || String(playerId || '');
  if (!key) return 0;
  if (team.playerPoints instanceof Map) return Number(team.playerPoints.get(key) || 0);
  return Number(team.playerPoints?.[key] || 0);
};

const setTeamPlayerPoints = (team, playerId, value) => {
  const key = playerId?.toString?.() || String(playerId || '');
  if (!key) return;
  if (!(team.playerPoints instanceof Map)) {
    team.playerPoints = new Map(Object.entries(team.playerPoints || {}));
  }
  team.playerPoints.set(key, Number(value) || 0);
  team.markModified('playerPoints');
};

const normalizePointEvent = (rawEvent) => {
  const type = String(rawEvent?.type || '').trim();
  const detail = String(rawEvent?.detail || '').trim();
  const elapsed = rawEvent?.time?.elapsed;
  const extra = rawEvent?.time?.extra;
  const player = rawEvent?.player || {};
  const assist = rawEvent?.assist || {};
  const team = rawEvent?.team || {};
  const minute = elapsed ? `${elapsed}${extra ? `+${extra}` : ''}'` : "0'";
  const comments = String(rawEvent?.comments || '').trim();
  const outputs = [];

  // 🚫 টাইব্রেকার (Penalty Shootout) এর গোল বা মিস ফ্যান্টাসি পয়েন্টে কাউন্ট হবে না
  if (/shootout/i.test(detail) || /shootout/i.test(comments)) {
    return outputs;
  }

  if (type === 'Goal' && player.id) {
    // Check for Own Goal
    if (/own/i.test(detail) || /own goal/i.test(comments)) {
      outputs.push({
        dedupeKey: `own-goal:${player.id}:${elapsed}:${extra || ''}:${detail}`,
        playerApiId: player.id,
        playerName: player.name || 'Player',
        teamName: team.name || 'Team',
        minute,
        type: 'own_goal',
        numPts: LIVE_POINT_RULES.OwnGoal,
        icon: '🤦‍♂️',
        ptsLabel: `${LIVE_POINT_RULES.OwnGoal}`
      });
    } else {
      outputs.push({
        dedupeKey: `goal:${player.id}:${elapsed}:${extra || ''}:${detail}:${assist.id || ''}`,
        playerApiId: player.id,
        playerName: player.name || 'Player',
        teamName: team.name || 'Team',
        minute,
        type: 'goal',
        numPts: 'DYNAMIC_GOAL', // Will be calculated in applyPointEventToTeams
        icon: '⚽',
        ptsLabel: 'DYNAMIC_LABEL'
      });
    }
    if (assist.id) {
      outputs.push({
        dedupeKey: `assist:${assist.id}:${player.id}:${elapsed}:${extra || ''}`,
        playerApiId: assist.id,
        playerName: assist.name || 'Player',
        teamName: team.name || 'Team',
        minute,
        type: 'assist',
        numPts: 3, // FPL Standard: 3 points for assist
        icon: '🎯',
        ptsLabel: '+3'
      });
    }
  }

  if (type === 'Card' && player.id) {
    const isRed = /red/i.test(detail);
    const numPts = isRed ? LIVE_POINT_RULES.CardRed : LIVE_POINT_RULES.CardYellow;
    outputs.push({
      dedupeKey: `card:${player.id}:${elapsed}:${extra || ''}:${detail}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: isRed ? 'red' : 'yellow',
      numPts,
      icon: isRed ? '🟥' : '🟨',
      ptsLabel: `${numPts}`
    });
  }

  if (type === 'Var' && /red/i.test(detail) && player.id) {
    outputs.push({
      dedupeKey: `var-red:${player.id}:${elapsed}:${extra || ''}:${detail}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: 'red',
      numPts: LIVE_POINT_RULES.VarRed,
      icon: '🟥',
      ptsLabel: `${LIVE_POINT_RULES.VarRed}`
    });
  }

  if (type === 'Penalty' && /missed/i.test(detail) && player.id) {
    outputs.push({
      dedupeKey: `penalty-missed:${player.id}:${elapsed}:${extra || ''}:${detail}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: 'miss',
      numPts: LIVE_POINT_RULES.PenaltyMissed,
      icon: '❌',
      ptsLabel: `${LIVE_POINT_RULES.PenaltyMissed}`
    });
  }

  return outputs;
};

const applyPointEventToTeams = async (matchId, pointEvent, io) => {
  const player = await Player.findOne({ apiId: pointEvent.playerApiId }).select('_id');
  if (!player) return false;

  // Resolve Dynamic Goal Points based on Position
  if (pointEvent.numPts === 'DYNAMIC_GOAL') {
    const pos = player.pos;
    let goalPts = 4; // FWD
    if (pos === 'MID') goalPts = 5;
    else if (pos === 'DEF' || pos === 'GK') goalPts = 6;
    
    pointEvent.numPts = goalPts;
    pointEvent.ptsLabel = `+${goalPts}`;
  }

  const teams = await FantasyTeam.find({ match: matchId, players: player._id });
  if (teams.length === 0) return false;

  for (const team of teams) {
    const currentPoints = getTeamPlayerPoints(team, player._id);
    setTeamPlayerPoints(team, player._id, currentPoints + pointEvent.numPts);

    const starters = team.players.length === 15 ? team.players.slice(0, 11) : team.players;
    const isStarter = starters.some(pId => pId.toString() === player._id.toString());

    if (isStarter) {
      let appliedPoints = pointEvent.numPts;
      if (team.captain?.toString() === player._id.toString()) appliedPoints *= 2;
      else if (team.viceCaptain?.toString() === player._id.toString()) appliedPoints *= 1.5;
      team.totalPoints = Number(team.totalPoints || 0) + appliedPoints;
    }

    await team.save();
  }

  const rooms = await Room.find({ match: matchId }).select('_id');
  const roomEvent = {
    id: `${matchId}:${pointEvent.dedupeKey}`,
    type: pointEvent.type,
    player: pointEvent.playerName,
    team: pointEvent.teamName,
    pts: pointEvent.ptsLabel,
    numPts: pointEvent.numPts,
    min: pointEvent.minute,
    icon: pointEvent.icon,
    playerId: String(player._id)
  };

  rooms.forEach(room => io?.to(String(room._id)).emit('live_event', roomEvent));
  io?.emit('refresh_global_leaderboard');
  clearLeaderboardCache(matchId);
  return true;
};

const processLiveFantasyEvents = async (liveMatchDoc, appMatch, io) => {
  const processedKeys = new Set(liveMatchDoc.processedEventKeys || []);
  const incomingEvents = Array.isArray(liveMatchDoc.events) ? liveMatchDoc.events : [];
  let hasNewProcessedKeys = false;

  for (const rawEvent of incomingEvents) {
    const pointEvents = normalizePointEvent(rawEvent);
    for (const pointEvent of pointEvents) {
      if (processedKeys.has(pointEvent.dedupeKey)) continue;
      processedKeys.add(pointEvent.dedupeKey);
      hasNewProcessedKeys = true;
      await applyPointEventToTeams(appMatch._id, pointEvent, io);
    }
  }

  if (hasNewProcessedKeys) {
    liveMatchDoc.processedEventKeys = Array.from(processedKeys);
    await liveMatchDoc.save();
  }
};

const mapFixtureStatus = (shortStatus) => {
  if (LIVE_SHORT_CODES.includes(shortStatus)) return 'Live';
  if (FINISHED_SHORT_CODES.includes(shortStatus)) return 'Finished';
  return 'Upcoming';
};

const upsertAppMatch = async (item, io) => {
  const status = mapFixtureStatus(item.fixture.status.short);
  const existingMatch = await Match.findOne({ fixtureId: item.fixture.id });
  let finishedMatchId = null;

  if (existingMatch) {
    if (existingMatch.status !== 'Finished' && status === 'Finished') {
      finishedMatchId = existingMatch._id;
      if (io) io.emit('match_finished', { matchId: existingMatch._id });
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
    return finishedMatchId;
  }

  const createdMatch = await Match.create({
    fixtureId: item.fixture.id,
    homeTeam: item.teams.home.name,
    awayTeam: item.teams.away.name,
    homeLogo: item.teams.home.logo || '',
    awayLogo: item.teams.away.logo || '',
    homeTeamApiId: item.teams.home.id,
    awayTeamApiId: item.teams.away.id,
    homeScore: item.goals.home || 0,
    awayScore: item.goals.away || 0,
    status,
    matchTime: new Date(item.fixture.date),
    league: item.league.name,
    minute: item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : "0'",
    roomsCount: 0
  });

  return status === 'Finished' ? createdMatch._id : null;
};

export const syncMatchesFromApi = async (io, options = {}) => {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dates = options.date
    ? [options.date]
    : [today, tomorrow].map((d) => d.toISOString().split('T')[0]);

  const responses = await Promise.all(
    dates.map(async (date) => {
      const data = await fetchWithRotation(`fixtures?date=${date}`);
      return Array.isArray(data.response) ? data.response : [];
    })
  );

  const mergedResponse = responses.flat();
  if (mergedResponse.length === 0) {
    return { synced: 0, finalized: 0, message: 'No matches found for the requested dates' };
  }

  const dedupedResponse = Array.from(
    new Map(mergedResponse.map((item) => [item.fixture.id, item])).values()
  );
  const filteredResponse = dedupedResponse.filter(item => 
    TOP_LEAGUE_IDS.includes(item.league.id) || 
    (TOP_LEAGUES_REGEX.test(item.league.name) && !EXCLUDED_LEAGUES_REGEX.test(item.league.name))
  );
  const finishedMatchIds = [];

  for (const item of filteredResponse) {
    const finishedMatchId = await upsertAppMatch(item, io);
    if (finishedMatchId) finishedMatchIds.push(String(finishedMatchId));
  }

  const uniqueFinishedIds = [...new Set(finishedMatchIds)];
  for (const matchId of uniqueFinishedIds) {
    await processAutoSubsAndRewards(matchId);
  }

  return {
    synced: filteredResponse.length,
    finalized: uniqueFinishedIds.length,
    message: filteredResponse.length > 0 ? 'Matches synced successfully' : 'No top matches found for the requested date'
  };
};

export const fetchAndSaveLiveMatches = async (io) => {
  try {
    console.log('Fetching live matches from api-sports...');
    const data = await fetchWithRotation('fixtures?live=all');
    const matches = data.response;

    if (matches && matches.length > 0) {
      for (const match of matches) {
        const liveMatchDoc = await LiveMatch.findOneAndUpdate(
          { fixtureId: match.fixture.id },
          {
            fixtureId: match.fixture.id,
            league: match.league,
            teams: match.teams,
            goals: match.goals,
            fixture: match.fixture,
            score: match.score,
            events: match.events,
            lastUpdated: new Date()
          },
          { upsert: true, new: true }
        );

        const appMatch = await Match.findOne({ fixtureId: match.fixture.id });
        if (appMatch) {
          await processLiveFantasyEvents(liveMatchDoc, appMatch, io);
        }
      }

      console.log(`Successfully updated ${matches.length} live matches in Database.`);
      if (io) io.emit('live_matches_update', matches);
    } else {
      console.log('No live matches at the moment.');
    }
  } catch (error) {
    console.error('Error fetching live-only endpoint:', error.response?.data || error.message);
  }

  try {
    const syncResult = await syncMatchesFromApi(io);
    console.log(`Match sync result: ${syncResult.synced} synced, ${syncResult.finalized} finalized.`);
  } catch (error) {
    console.error('Error syncing dated fixtures:', error.response?.data || error.message);
  }
};
