import mongoose from 'mongoose';
import Match from '../models/Match.js';
import ManualStream from '../models/ManualStream.js';
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
    const match = await resolveMatchFromParam(req.params.matchId);
    if (!match) {
      return res.status(404).json({
        available: false,
        message: 'Match not found for stream lookup.',
        streams: [],
      });
    }

    const fixtureKey = String(match.fixtureId || match._id);
    
    // ১. অ্যাডমিন প্যানেল থেকে দেওয়া অ্যাকটিভ লিংকগুলো খুঁজে বের করা
    const manualStreams = await ManualStream.find({ 
      matchId: fixtureKey, 
      isActive: true 
    }).sort({ isBest: -1, createdAt: -1 });

    // অ্যাডমিন লিংকগুলোকে অ্যাপের স্ট্রাকচার অনুযায়ী ফরম্যাট করা
    const formattedManualStreams = manualStreams.map((stream, index) => ({
      title: stream.isBest ? '⭐ Play Best Stream (Admin)' : `Admin Server ${index + 1} (${stream.quality} - ${stream.language})`,
      url: stream.streamUrl,
      source: 'admin',
      rankScore: stream.isBest ? 1000 : 500, // স্ক্র্যাপ করা লিংকের চেয়ে র‍্যাংক বেশি দেওয়া হলো যাতে সবার উপরে থাকে
      isAlive: true,
    }));

    const health = await getStreamScraperHealth();
    let result = {
      fixtureId: match.fixtureId || null,
      matchId: String(match._id),
      matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
      status: match.status,
      league: match.league,
      available: false,
      source: 'iptv-scraper',
      streams: [],
      streamCount: 0,
      state: 'empty',
    };

    // যদি স্ক্র্যাপার অফ থাকে এবং অ্যাডমিনও কোনো লিংক না দেয়, তবেই শুধু এরর দেখাবে
    if (!health.ok && formattedManualStreams.length === 0) {
      return res.status(503).json({
        available: false,
        message: 'Live stream scraper is not ready yet and no admin streams found.',
        health,
        streams: [],
      });
    } else if (health.ok && formattedManualStreams.length === 0) {
      // যদি অ্যাডমিনের লিংক না থাকে, তবেই শুধু স্ক্র্যাপার ২৫ সেকেন্ড সময় নিয়ে লিংক খুঁজবে। 
      // অ্যাডমিনের লিংক থাকলে অ্যাপ জিরো লোডিং টাইমে সাথে সাথে ওপেন হবে!
      result = await getLiveStreamsForMatch(match);
    }
    
    // ২. অ্যাডমিন লিংক এবং স্ক্র্যাপ করা লিংক এক সাথে জুড়ে দেওয়া
    result.streams = [...formattedManualStreams, ...(result.streams || [])];
    result.streamCount = result.streams.length;
    if (formattedManualStreams.length > 0) {
      result.available = true;
      result.state = 'ready';
    }

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
    const match = await resolveMatchFromParam(req.params.matchId);
    if (!match) {
      return res.status(404).json({
        available: false,
        message: 'Match not found for stream refresh.',
        streams: [],
      });
    }

    const fixtureKey = String(match.fixtureId || match._id);

    const manualStreams = await ManualStream.find({ 
      matchId: fixtureKey, 
      isActive: true 
    }).sort({ isBest: -1, createdAt: -1 });
    
    const formattedManualStreams = manualStreams.map((stream, index) => ({
      title: stream.isBest ? '⭐ Play Best Stream (Admin)' : `Admin Server ${index + 1} (${stream.quality} - ${stream.language})`,
      url: stream.streamUrl, source: 'admin', rankScore: stream.isBest ? 1000 : 500, isAlive: true,
    }));
    
    const health = await getStreamScraperHealth();
    let result = {
      fixtureId: match.fixtureId || null,
      matchId: String(match._id),
      matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
      status: match.status,
      league: match.league,
      available: false,
      source: 'iptv-scraper',
      streams: [],
      streamCount: 0,
      state: 'empty',
    };

    if (!health.ok && formattedManualStreams.length === 0) {
      return res.status(503).json({
        available: false,
        message: 'Live stream scraper is not ready yet and no admin streams found.',
        health,
        streams: [],
      });
    } else if (health.ok && formattedManualStreams.length === 0) {
      await clearLiveStreamCache(match.fixtureId || match._id);
      result = await getLiveStreamsForMatch(match, { forceRefresh: true });
    }
    
    result.streams = [...formattedManualStreams, ...(result.streams || [])];
    result.streamCount = result.streams.length;
    if (formattedManualStreams.length > 0) {
      result.available = true;
      result.state = 'ready';
    }

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
