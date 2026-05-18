import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import Match from '../models/Match.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export const checkStreamHealth = async (req, res) => {
  try {
    // You can later add logic to check if your IPTV scraper is active
    res.status(200).json({ ok: true, message: 'Stream service is ready' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Stream service error' });
  }
};

export const getMatchStreams = async (req, res) => {
  const { matchId } = req.params;
  
  try {
    const match = await resolveMatchFromParam(matchId);

    if (!match) {
      return res.status(404).json({ available: false, message: 'Match not found' });
    }

    // __dirname ব্যবহার করে একেবারে সঠিক Absolute Path তৈরি করা হলো
    const pythonScriptPath = path.join(__dirname, '../../IPTV-SCRAPPER-main (1)/IPTV-SCRAPPER-main/iptv_scraper/cli.py');
    
    // স্ক্রিপ্ট না পেলে ডামি লিংক না দেখিয়ে এরর দেখাবে
    if (!fs.existsSync(pythonScriptPath)) {
      return res.status(200).json({
        available: false,
        message: 'Python scraper is missing on the server.',
        streams: []
      });
    }

    const searchTeam = match.homeTeam; 
    // Command: python cli.py --live-match -c "TeamName" -n 2
    const command = `python "${pythonScriptPath}" --live-match -c "${searchTeam}" -n 2`;
    console.log(`📡 Fetching live stream: ${command}`);

    exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
      // পাইথনের আউটপুট থেকে .m3u8 বা .ts লিংগুলো এক্সট্রাক্ট করা
      const urlRegex = /(https?:\/\/[^\s]+(?:\.m3u8|\.ts)[^\s]*)/g;
      const foundLinks = [];
      let urlMatch;
      
      while ((urlMatch = urlRegex.exec(stdout)) !== null) {
        foundLinks.push(urlMatch[0]);
      }

      const uniqueLinks = [...new Set(foundLinks)];
      if (uniqueLinks.length > 0) {
        const streams = uniqueLinks.map((url, index) => ({ url: url, quality: 'Auto', language: `Live Stream ${index + 1}` }));
        return res.status(200).json({ available: true, message: 'Streams fetched successfully', streams });
      } else {
        return res.status(200).json({ available: false, message: 'No live streams found right now. Try again at kick-off.', streams: [] });
      }
    });
  } catch (error) {
    console.error("Stream error details:", error);
    res.status(500).json({ available: false, message: 'Error fetching streams' });
  }
};

export const refreshMatchStreams = async (req, res) => {
  const { matchId } = req.params;
  
  try {
    // For now, call the same GET function. In the future, this can force a scraper re-run.
    return getMatchStreams(req, res);
  } catch (error) {
    res.status(500).json({ available: false, message: 'Error refreshing streams' });
  }
};