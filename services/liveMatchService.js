import axios from 'axios';
import LiveMatch from '../models/LiveMatch.js';
import Match from '../models/Match.js';
import { processAutoSubsAndRewards } from '../controllers/matchController.js';

const LIVE_SHORT_CODES = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'];
const FINISHED_SHORT_CODES = ['FT', 'AET', 'PEN'];
const TOP_LEAGUE_IDS = [2, 3, 4, 9, 15, 39, 61, 66, 78, 135, 140];

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
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_API_KEY not found in .env');

  const date = options.date || new Date().toISOString().split('T')[0];
  const response = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
    headers: { 'x-apisports-key': apiKey }
  });
  const data = await response.json();

  if (!data.response || data.response.length === 0) {
    return { synced: 0, finalized: 0, message: 'No matches found for the requested date' };
  }

  const filteredResponse = data.response.filter(item => TOP_LEAGUE_IDS.includes(item.league.id));
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
    const response = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: {
        'x-apisports-key': process.env.FOOTBALL_API_KEY
      }
    });

    const matches = response.data.response;

    if (matches && matches.length > 0) {
      for (const match of matches) {
        await LiveMatch.findOneAndUpdate(
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
      }

      console.log(`Successfully updated ${matches.length} live matches in Database.`);
      if (io) io.emit('live_matches_update', matches);
    } else {
      console.log('No live matches at the moment.');
    }

    const syncResult = await syncMatchesFromApi(io);
    console.log(`Match sync result: ${syncResult.synced} synced, ${syncResult.finalized} finalized.`);
  } catch (error) {
    console.error('Error fetching live matches:', error.message);
  }
};
