import mongoose from 'mongoose';
import Match from '../models/Match.js';
import {
  clearLiveStreamCache,
  getLiveStreamsForMatch,
  getStreamScraperHealth,
} from '../services/streamScraperService.js';

const resolveMatchFromParam = async (matchId) => {
  const rawMatchId = String(matchId || '').trim();
  let match = null;

  if (/^\d+$/.test(rawMatchId)) {
    match = await Match.findOne({ fixtureId: Number(rawMatchId) });
  }

  if (!match && mongoose.isValidObjectId(rawMatchId)) {
    match = await Match.findById(rawMatchId);
  }

  return match;
};

export const checkStreamHealth = async (_req, res) => {
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

export const getMatchStreams = async (req, res) => {
  try {
    const health = await getStreamScraperHealth();
    if (!health.ok) {
      return res.status(503).json({
        available: false,
        message: 'Live stream scraper is not ready yet.',
        health,
        streams: [],
      });
    }

    const match = await resolveMatchFromParam(req.params.matchId);
    if (!match) {
      return res.status(404).json({
        available: false,
        message: 'Match not found for stream lookup.',
        streams: [],
      });
    }

    const result = await getLiveStreamsForMatch(match);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      available: false,
      message: 'Failed to fetch live streams.',
      error: error.message,
      streams: [],
    });
  }
};

export const refreshMatchStreams = async (req, res) => {
  try {
    const health = await getStreamScraperHealth();
    if (!health.ok) {
      return res.status(503).json({
        available: false,
        message: 'Live stream scraper is not ready yet.',
        health,
        streams: [],
      });
    }

    const match = await resolveMatchFromParam(req.params.matchId);
    if (!match) {
      return res.status(404).json({
        available: false,
        message: 'Match not found for stream refresh.',
        streams: [],
      });
    }

    await clearLiveStreamCache(match.fixtureId || match._id);
    const result = await getLiveStreamsForMatch(match, { forceRefresh: true });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      available: false,
      message: 'Failed to refresh live streams.',
      error: error.message,
      streams: [],
    });
  }
};

export const reportStreamTelemetry = async (req, res) => {
  try {
    const { matchId, url, success, errorMsg } = req.body;
    if (!url) {
      return res.status(400).json({ ok: false, message: 'URL is required' });
    }

    console.log(`[Telemetry] Stream ${success ? 'SUCCESS' : 'FAILED'} | Match: ${matchId || 'N/A'} | URL: ${url}`);
    if (!success) {
      console.log(`[Telemetry] Reason: ${errorMsg}`);
    }

    // Phase 4: Here we can import StreamDomainHealth and update domain stats directly 
    // based on real client playback telemetry.

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
