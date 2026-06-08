import mongoose from 'mongoose';
import Match from '../models/Match.js';
import ManualStream from '../models/ManualStream.js';
import AppConfig from '../models/AppConfig.js';
import {
  clearLiveStreamCache,
  getLiveStreamsForMatch,
  getStreamScraperHealth,
} from '../services/streamScraperService.js';
import fetch from 'node-fetch'; // Add this for checking global links

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

// Helper to quickly check if a stream link is alive
const checkStreamAlive = async (url) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch (err) {
    return false;
  }
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
    
    // Fetch AppConfig for Global Links and Fallback Auto Link
    const config = await AppConfig.findOne();
    const globalStreamLinksStr = config?.globalStreamLinks || '';
    const fallbackAutoLink = config?.fallbackAutoLink || '';
    
    // ১. & ২. অ্যাডমিন প্যানেল থেকে দেওয়া অ্যাকটিভ লিংকগুলো খুঁজে বের করা (1st priority = isBest, 2nd = others)
    const manualStreams = await ManualStream.find({ 
      matchId: fixtureKey, 
      isActive: true 
    }).sort({ isBest: -1, createdAt: -1 });

    // অ্যাডমিন লিংকগুলোকে অ্যাপের স্ট্রাকচার অনুযায়ী ফরম্যাট করা
    const formattedManualStreams = manualStreams.map((stream, index) => ({
      title: stream.isBest ? '⭐ Play Best Stream (Admin)' : `Admin Server ${index + 1} (${stream.quality} - ${stream.language})`,
      url: stream.streamUrl,
      source: 'admin',
      rankScore: stream.isBest ? 1000 : 500, // ১st & ২nd priority
      isAlive: true,
    }));
    
    // ৩. Global Stream Links - চেক করে অ্যাড করা
    const globalStreams = [];
    if (globalStreamLinksStr.trim() !== '') {
      const links = globalStreamLinksStr.split(',').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const isAlive = await checkStreamAlive(link);
        if (isAlive) {
          globalStreams.push({
            title: `Global Server ${i + 1} (Auto Checked)`,
            url: link,
            source: 'global',
            rankScore: 300, // 3rd priority
            isAlive: true
          });
        }
      }
    }

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

    const hasAnyAdminOrGlobalStream = formattedManualStreams.length > 0 || globalStreams.length > 0;

    if (!health.ok && !hasAnyAdminOrGlobalStream) {
      // যদি স্ক্র্যাপার অফ থাকে এবং অন্য কোনো লিংক না থাকে
    } else if (health.ok && !hasAnyAdminOrGlobalStream) {
      result = await getLiveStreamsForMatch(match);
    }
    
    // ৪. Auto Link (Fallback) - যদি কোনো লিংক না থাকে (বা সব কাজ শেষ হওয়ার পর Fallback হিসেবে)
    const finalStreams = [...formattedManualStreams, ...globalStreams, ...(result.streams || [])];
    
    // যদি একদম কোনো লিংক না থাকে, আর Fallback Auto Link দেওয়া থাকে
    if (finalStreams.length === 0 && fallbackAutoLink.trim() !== '') {
      finalStreams.push({
        title: 'Auto Link (Fallback Server)',
        url: fallbackAutoLink.trim(),
        source: 'fallback',
        rankScore: 100, // 4th priority
        isAlive: true
      });
    }

    result.streams = finalStreams;
    result.streamCount = result.streams.length;
    
    if (result.streamCount > 0) {
      result.available = true;
      result.state = 'ready';
    } else if (!health.ok && !hasAnyAdminOrGlobalStream) {
       return res.status(503).json({
        available: false,
        message: 'Live stream scraper is not ready yet and no admin/global streams found.',
        health,
        streams: [],
      });
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
  // Use the exact same logic for refresh as getMatchStreams
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

    const config = await AppConfig.findOne();
    const globalStreamLinksStr = config?.globalStreamLinks || '';
    const fallbackAutoLink = config?.fallbackAutoLink || '';

    const manualStreams = await ManualStream.find({ 
      matchId: fixtureKey, 
      isActive: true 
    }).sort({ isBest: -1, createdAt: -1 });
    
    const formattedManualStreams = manualStreams.map((stream, index) => ({
      title: stream.isBest ? '⭐ Play Best Stream (Admin)' : `Admin Server ${index + 1} (${stream.quality} - ${stream.language})`,
      url: stream.streamUrl, source: 'admin', rankScore: stream.isBest ? 1000 : 500, isAlive: true,
    }));
    
    const globalStreams = [];
    if (globalStreamLinksStr.trim() !== '') {
      const links = globalStreamLinksStr.split(',').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const isAlive = await checkStreamAlive(link);
        if (isAlive) {
          globalStreams.push({
            title: `Global Server ${i + 1} (Auto Checked)`,
            url: link,
            source: 'global',
            rankScore: 300,
            isAlive: true
          });
        }
      }
    }

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

    const hasAnyAdminOrGlobalStream = formattedManualStreams.length > 0 || globalStreams.length > 0;

    if (!health.ok && !hasAnyAdminOrGlobalStream) {
      // do nothing
    } else if (health.ok && !hasAnyAdminOrGlobalStream) {
      await clearLiveStreamCache(match.fixtureId || match._id);
      result = await getLiveStreamsForMatch(match, { forceRefresh: true });
    }
    
    const finalStreams = [...formattedManualStreams, ...globalStreams, ...(result.streams || [])];
    
    if (finalStreams.length === 0 && fallbackAutoLink.trim() !== '') {
      finalStreams.push({
        title: 'Auto Link (Fallback Server)',
        url: fallbackAutoLink.trim(),
        source: 'fallback',
        rankScore: 100,
        isAlive: true
      });
    }

    result.streams = finalStreams;
    result.streamCount = result.streams.length;
    
    if (result.streamCount > 0) {
      result.available = true;
      result.state = 'ready';
    } else if (!health.ok && !hasAnyAdminOrGlobalStream) {
      return res.status(503).json({
        available: false,
        message: 'Live stream scraper is not ready yet and no admin streams found.',
        health,
        streams: [],
      });
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
