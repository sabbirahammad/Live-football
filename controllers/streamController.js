import Match from '../models/Match.js';
import { clearLiveStreamCache, getLiveStreamsForMatch, getStreamScraperHealth } from '../services/streamScraperService.js';

const findMatchByParam = async (matchIdOrFixtureId) => {
  if (!matchIdOrFixtureId) return null;

  if (/^\d+$/.test(String(matchIdOrFixtureId))) {
    const byFixture = await Match.findOne({ fixtureId: Number(matchIdOrFixtureId) });
    if (byFixture) return byFixture;
  }

  if (String(matchIdOrFixtureId).length === 24) {
    return Match.findById(matchIdOrFixtureId);
  }

  return null;
};

export const getStreamsForMatch = async (req, res) => {
  try {
    const health = await getStreamScraperHealth();
    if (!health.ok) {
      return res.status(503).json({
        message: 'Live stream scraper is not ready yet.',
        health,
      });
    }

    const match = await findMatchByParam(req.params.fixtureId);
    if (!match) {
      return res.status(404).json({ message: 'Match not found for stream lookup.' });
    }

    const result = await getLiveStreamsForMatch(match);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      message: 'Failed to fetch live streams.',
      error: error.message,
    });
  }
};

export const refreshStreamsForMatch = async (req, res) => {
  try {
    const health = await getStreamScraperHealth();
    if (!health.ok) {
      return res.status(503).json({
        message: 'Live stream scraper is not ready yet.',
        health,
      });
    }

    const match = await findMatchByParam(req.params.fixtureId);
    if (!match) {
      return res.status(404).json({ message: 'Match not found for stream refresh.' });
    }

    clearLiveStreamCache(match.fixtureId || match._id);
    const result = await getLiveStreamsForMatch(match, { forceRefresh: true });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      message: 'Failed to refresh live streams.',
      error: error.message,
    });
  }
};

export const getStreamHealth = async (_req, res) => {
  try {
    const health = await getStreamScraperHealth();
    return res.status(health.ok ? 200 : 503).json(health);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      source: 'iptv-scraper',
      message: 'Failed to evaluate stream scraper health.',
      error: error.message,
    });
  }
};
