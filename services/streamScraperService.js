import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import Match from '../models/Match.js';
import StreamCache from '../models/StreamCache.js';
import StreamDomainHealth from '../models/StreamDomainHealth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');

const DEFAULT_SCRAPER_DIR = path.join(backendRoot, 'tools', 'iptv-scraper');
const CACHE_DIR = path.join(backendRoot, '.stream-cache');
const STREAM_CACHE_TTL = 5 * 60 * 1000;
const MAX_STREAMS = Number(process.env.IPTV_STREAM_MAX_STREAMS || 6);
const MAX_SEARCH_TERMS = Number(process.env.IPTV_STREAM_MAX_SEARCH_TERMS || 2);
const SCRAPER_TIMEOUT_MS = Number(process.env.IPTV_SCRAPER_TIMEOUT_MS || 12000);
const TOTAL_SCRAPE_TIMEOUT_MS = Number(process.env.IPTV_TOTAL_SCRAPE_TIMEOUT_MS || 25000);
const HEALTH_CHECK_TIMEOUT = 20 * 1000;
const PREFETCH_INTERVAL_MS = Number(process.env.IPTV_PREFETCH_INTERVAL_MS || 180000);
const PREFETCH_MATCH_LIMIT = Number(process.env.IPTV_PREFETCH_MATCH_LIMIT || 6);
const STREAM_VALIDATION_TIMEOUT_MS = Number(process.env.IPTV_STREAM_VALIDATION_TIMEOUT_MS || 2500);
const MAX_VALIDATE_STREAMS = Number(process.env.IPTV_MAX_VALIDATE_STREAMS || 2);
const PREFETCH_REFRESH_LIVE_AFTER_MS = Number(process.env.IPTV_PREFETCH_REFRESH_LIVE_AFTER_MS || 120000);
const HEALTH_CACHE_TTL_MS = Number(process.env.IPTV_HEALTH_CACHE_TTL_MS || 60000);

const streamCache = new Map();
const inFlightStreamLookups = new Map();
let prefetchIntervalHandle = null;
let prefetchInFlight = false;
let cachedHealthSnapshot = null;
let cachedHealthAt = 0;
const PRIORITY_LEAGUE_HINTS = [
  'premier league',
  'uefa',
  'champions league',
  'la liga',
  'laliga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'europa',
  'fa cup',
  'copa del rey',
  'super cup',
  'world cup',
  'euro',
  'mls',
];

const safeSlug = (value) =>
  String(value || 'match')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'match';

const dedupeStreams = (streams) => {
  const seen = new Set();
  const uniqueStreams = [];

  for (const stream of streams) {
    if (!stream?.url || seen.has(stream.url)) continue;
    seen.add(stream.url);
    uniqueStreams.push(stream);
  }

  return uniqueStreams;
};

const getFixtureKey = (matchOrId) => String(matchOrId?.fixtureId || matchOrId?._id || matchOrId);

const getStreamDomain = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
};

const mapCacheRecordToResponse = (record) => ({
  fixtureId: record.fixtureId || null,
  matchId: String(record.matchId || ''),
  matchLabel: record.matchLabel,
  status: record.status,
  league: record.league,
  available: record.available,
  source: record.source,
  searchedTerms: record.searchedTerms || [],
  matchedSearchTerm: record.matchedSearchTerm || null,
  streams: record.streams || [],
  streamCount: record.streamCount || 0,
  state: record.state,
  cached: true,
  cachedAt: new Date(record.cachedAt).getTime(),
  runtime: record.runtime || null,
  errors: record.errors || [],
  diagnostics: record.diagnostics || {},
  message: record.message || '',
});

const getStreamScore = (stream) => {
  const title = String(stream?.title || '').toLowerCase();
  const url = String(stream?.url || '').toLowerCase();
  let score = 0;

  if (title.includes('bein')) score += 12;
  if (title.includes('sky')) score += 10;
  if (title.includes('espn')) score += 10;
  if (title.includes('dazn')) score += 10;
  if (title.includes('sport')) score += 8;
  if (title.includes('live')) score += 4;
  if (title.includes('hd')) score += 3;

  if (url.includes('.m3u8')) score += 5;
  if (url.includes('/hls/')) score += 4;
  if (url.includes('/live/')) score += 4;
  if (url.includes('albaplayer')) score += 3;
  if (url.includes('yallla') || url.includes('yalla')) score += 2;

  if (url.startsWith('https://')) score += 1;

  return score;
};

const rankStreams = (streams) =>
  [...streams]
    .map((stream) => ({
      ...stream,
      domain: stream.domain || getStreamDomain(stream.url),
      rankScore: getStreamScore(stream) + Number(stream.healthScore || 0),
    }))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, MAX_STREAMS);

const getDomainHealthMap = async (streams) => {
  const domains = [...new Set(streams.map((stream) => getStreamDomain(stream.url)).filter(Boolean))];
  if (domains.length === 0) return new Map();

  const records = await StreamDomainHealth.find({ domain: { $in: domains } }).lean();
  return new Map(records.map((record) => [record.domain, record]));
};

const computeDomainHealthScore = (record) => {
  const successWeight = Number(record.successCount || 0) * 2;
  const failurePenalty = Number(record.failureCount || 0) * 1.5;
  const streakPenalty = Number(record.consecutiveFailures || 0) * 2;
  const latencyPenalty = Math.min(6, Math.round(Number(record.avgLatencyMs || 0) / 1000));
  return Math.max(-10, Math.min(20, successWeight - failurePenalty - streakPenalty - latencyPenalty));
};

const enrichStreamsWithDomainHealth = async (streams) => {
  const healthMap = await getDomainHealthMap(streams);
  return streams.map((stream) => {
    const domain = getStreamDomain(stream.url);
    const record = healthMap.get(domain);
    return {
      ...stream,
      domain,
      healthScore: record ? Number(record.healthScore || 0) : 0,
    };
  });
};

const validateStreamUrl = async (stream) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_VALIDATION_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const url = String(stream?.url || '');
    const isPlaylist = url.toLowerCase().includes('.m3u8');
    const response = await fetch(url, {
      method: isPlaylist ? 'GET' : 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: isPlaylist ? { Range: 'bytes=0-512' } : undefined,
    });

    let looksPlayable = response.ok;
    if (response.ok && isPlaylist) {
      const body = await response.text();
      looksPlayable = body.includes('#EXTM3U') || body.includes('#EXTINF') || body.length > 0;
    }

    return {
      ...stream,
      isValidated: true,
      isAlive: looksPlayable,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch (_error) {
    return {
      ...stream,
      isValidated: true,
      isAlive: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const updateDomainHealth = async (stream) => {
  const domain = stream.domain || getStreamDomain(stream.url);
  if (!domain) return;

  const current = await StreamDomainHealth.findOne({ domain }).lean();
  const successCount = Number(current?.successCount || 0) + (stream.isAlive ? 1 : 0);
  const failureCount = Number(current?.failureCount || 0) + (stream.isAlive ? 0 : 1);
  const previousLatency = Number(current?.avgLatencyMs || 0);
  const previousChecks = Number(current?.successCount || 0) + Number(current?.failureCount || 0);
  const nextChecks = previousChecks + 1;
  const avgLatencyMs = Math.round(((previousLatency * previousChecks) + Number(stream.latencyMs || 0)) / Math.max(1, nextChecks));
  const consecutiveFailures = stream.isAlive ? 0 : Number(current?.consecutiveFailures || 0) + 1;

  const nextRecord = {
    domain,
    successCount,
    failureCount,
    consecutiveFailures,
    avgLatencyMs,
    lastCheckedAt: new Date(),
    ...(stream.isAlive ? { lastSuccessAt: new Date() } : { lastFailureAt: new Date() }),
  };

  nextRecord.healthScore = computeDomainHealthScore(nextRecord);

  await StreamDomainHealth.findOneAndUpdate(
    { domain },
    { $set: nextRecord },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const validateAndRankStreams = async (streams) => {
  const enriched = await enrichStreamsWithDomainHealth(streams);
  const initiallyRanked = rankStreams(enriched);
  const validatedTop = await Promise.all(
    initiallyRanked.slice(0, MAX_VALIDATE_STREAMS).map(validateStreamUrl)
  );

  await Promise.all(validatedTop.map(updateDomainHealth));

  const validatedByUrl = new Map(validatedTop.map((stream) => [stream.url, stream]));
  const merged = initiallyRanked.map((stream) => validatedByUrl.get(stream.url) || stream);
  const finalRanked = rankStreams(merged).sort((a, b) => {
    const aliveA = a.isAlive === true ? 1 : a.isAlive === false ? -1 : 0;
    const aliveB = b.isAlive === true ? 1 : b.isAlive === false ? -1 : 0;
    if (aliveA !== aliveB) return aliveB - aliveA;
    return Number(b.rankScore || 0) - Number(a.rankScore || 0);
  });

  const healthyStreams = finalRanked.filter((stream) => stream.isAlive !== false);
  const selected = (healthyStreams.length > 0 ? healthyStreams : finalRanked).slice(0, MAX_STREAMS);

  return {
    streams: selected,
    validation: {
      checkedCount: validatedTop.length,
      aliveCount: validatedTop.filter((stream) => stream.isAlive).length,
      failedCount: validatedTop.filter((stream) => stream.isAlive === false).length,
    },
  };
};

const normalizeSearchValue = (value) =>
  String(value || '')
    .replace(/\bFC\b/gi, '')
    .replace(/\bCF\b/gi, '')
    .replace(/\bSC\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

const getMatchDayHints = (match) => {
  if (!match?.matchTime) return [];

  const now = new Date();
  const matchDate = new Date(match.matchTime);
  const diffMs = matchDate.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours > -8 && diffHours < 8) return ['today'];
  if (diffHours >= 8 && diffHours < 32) return ['tomorrow'];
  return [];
};

const isPriorityMatch = (match) => {
  const league = normalizeSearchValue(match?.league).toLowerCase();
  const teamsText = `${normalizeSearchValue(match?.homeTeam)} ${normalizeSearchValue(match?.awayTeam)}`.toLowerCase();

  return PRIORITY_LEAGUE_HINTS.some((hint) => league.includes(hint) || teamsText.includes(hint));
};

const buildSearchTerms = (match) => {
  const homeTeam = normalizeSearchValue(match.homeTeam);
  const awayTeam = normalizeSearchValue(match.awayTeam);
  const league = normalizeSearchValue(match.league);
  const dayHints = getMatchDayHints(match);

  const rawTerms = [
    `${homeTeam} vs ${awayTeam}`,
    `${homeTeam} ${awayTeam}`,
    `${league} ${homeTeam} ${awayTeam}`,
    `${league} ${homeTeam}`,
    `${league} ${awayTeam}`,
    ...dayHints.map((hint) => `${hint} ${homeTeam} vs ${awayTeam}`),
    ...dayHints.map((hint) => `${hint} ${league}`),
    homeTeam,
    awayTeam,
    league,
  ];

  return rawTerms
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term, index, arr) => arr.indexOf(term) === index)
    .slice(0, MAX_SEARCH_TERMS);
};

const resolveScraperPaths = async () => {
  const scraperDir = process.env.IPTV_SCRAPER_DIR
    ? path.resolve(process.env.IPTV_SCRAPER_DIR)
    : DEFAULT_SCRAPER_DIR;

  const cliModuleDir = path.join(scraperDir, 'iptv_scraper');
  const cliPath = path.join(cliModuleDir, 'cli.py');

  await fs.access(scraperDir);
  await fs.access(cliPath);

  return { scraperDir, cliPath };
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const listFilesRecursive = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return listFilesRecursive(fullPath);
    return [fullPath];
  }));

  return nested.flat();
};

const parseM3uContent = (content, sourceLabel) => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const streams = [];
  let pendingTitle = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      pendingTitle = line.split(',').slice(1).join(',').trim() || 'Live Stream';
      continue;
    }

    if (line.startsWith('#')) continue;

    streams.push({
      title: pendingTitle || 'Live Stream',
      url: line,
      source: sourceLabel,
    });
    pendingTitle = null;
  }

  return dedupeStreams(streams);
};

const parseGeneratedStreams = async (runDir, sourceLabel) => {
  const files = await listFilesRecursive(runDir);
  const m3uFiles = files.filter((file) => file.toLowerCase().endsWith('.m3u'));

  if (m3uFiles.length === 0) {
    return [];
  }

  const parsedGroups = await Promise.all(
    m3uFiles.map(async (filePath) => {
      const content = await fs.readFile(filePath, 'utf8');
      return parseM3uContent(content, sourceLabel);
    })
  );

  const deduped = dedupeStreams(parsedGroups.flat());
  if (deduped.length === 0) return [];

  const { streams } = await validateAndRankStreams(deduped);
  return streams;
};

const runCommand = ({ command, args, cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`Scraper timed out after ${timeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Scraper exited with code ${code}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });

const getPythonCandidates = () => {
  const configured = process.env.IPTV_SCRAPER_PYTHON || process.env.PYTHON_BIN;
  const candidates = configured ? [configured] : ['python', 'py'];
  return candidates.filter(Boolean);
};

const buildPythonEnv = (scraperDir = null) => ({
  ...process.env,
  ...(scraperDir ? { PYTHONPATH: scraperDir } : {}),
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
});

const classifyError = (message = '') => {
  const normalized = String(message).toLowerCase();

  if (normalized.includes('no module named')) return 'missing_dependency';
  if (normalized.includes('no python runtime') || normalized.includes('not recognized')) return 'python_missing';
  if (normalized.includes('timed out')) return 'timeout';
  if (normalized.includes('cannot find') || normalized.includes('enoent')) return 'scraper_missing';

  return 'scraper_error';
};

const runScraperForTerm = async ({ searchTerm, outputName }) => {
  const { scraperDir } = await resolveScraperPaths();
  await ensureDir(CACHE_DIR);

  const runDir = path.join(CACHE_DIR, `${Date.now()}-${safeSlug(outputName)}`);
  await ensureDir(runDir);

  const env = buildPythonEnv(scraperDir);

  const baseArgs = ['-m', 'iptv_scraper.cli', '--live-match', '-c', searchTerm, '-n', String(MAX_STREAMS), '-o', outputName, '--auto-save'];
  const candidates = getPythonCandidates();

  let lastError = null;

  for (const command of candidates) {
    const args = command === 'py' ? ['-3', ...baseArgs] : baseArgs;

    try {
      await runCommand({
        command,
        args,
        cwd: runDir,
        env,
        timeoutMs: SCRAPER_TIMEOUT_MS,
      });

      const streams = await parseGeneratedStreams(runDir, `iptv-scraper:${searchTerm}`);
      if (streams.length > 0) {
        return { streams, runDir, pythonCommand: command };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('No Python runtime available for IPTV scraper.');
};

const getCachedStreams = (cacheKey) => {
  const cached = streamCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > STREAM_CACHE_TTL) {
    streamCache.delete(cacheKey);
    return null;
  }
  return cached;
};

const getPersistentCachedStreams = async (cacheKey) => {
  const record = await StreamCache.findOne({
    fixtureKey: cacheKey,
    expiresAt: { $gt: new Date() },
  }).lean();

  return record ? mapCacheRecordToResponse(record) : null;
};

const saveStreamsToPersistentCache = async (cacheKey, response) => {
  const cachedAtDate = new Date(response.cachedAt || Date.now());
  const expiresAt = new Date(cachedAtDate.getTime() + STREAM_CACHE_TTL);

  const payload = {
    fixtureKey: cacheKey,
    fixtureId: response.fixtureId ?? null,
    matchId: String(response.matchId || ''),
    matchLabel: response.matchLabel,
    status: response.status,
    league: response.league,
    available: response.available,
    source: response.source,
    searchedTerms: response.searchedTerms || [],
    matchedSearchTerm: response.matchedSearchTerm || null,
    streams: response.streams || [],
    streamCount: response.streamCount || 0,
    state: response.state,
    cachedAt: cachedAtDate,
    runtime: response.runtime || null,
    errors: response.errors || [],
    diagnostics: response.diagnostics || {},
    message: response.message || '',
    expiresAt,
  };

  await StreamCache.findOneAndUpdate(
    { fixtureKey: cacheKey },
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

export const getLiveStreamsForMatch = async (match, options = {}) => {
  if (match.status === 'Finished') {
    return {
      fixtureId: match.fixtureId || null,
      matchId: String(match._id),
      matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
      status: match.status,
      league: match.league,
      available: false,
      source: 'iptv-scraper',
      searchedTerms: [],
      matchedSearchTerm: null,
      streams: [],
      streamCount: 0,
      state: 'finished',
      cached: false,
      cachedAt: Date.now(),
      runtime: null,
      errors: [],
      diagnostics: {
        skipped: true,
        reason: 'finished_match',
      },
      message: 'Streams are not fetched for finished matches.',
    };
  }

  if (match.status !== 'Live' && !isPriorityMatch(match)) {
    return {
      fixtureId: match.fixtureId || null,
      matchId: String(match._id),
      matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
      status: match.status,
      league: match.league,
      available: false,
      source: 'iptv-scraper',
      searchedTerms: [],
      matchedSearchTerm: null,
      streams: [],
      streamCount: 0,
      state: 'skipped_low_priority',
      cached: false,
      cachedAt: Date.now(),
      runtime: null,
      errors: [],
      diagnostics: {
        skipped: true,
        reason: 'low_priority_upcoming_match',
      },
      message: 'Stream search is skipped for lower-priority upcoming matches. Try again when the match goes live.',
    };
  }

  const fixtureKey = String(match.fixtureId || match._id);
  const cached = !options.forceRefresh ? getCachedStreams(fixtureKey) : null;

  if (cached) {
    return {
      ...cached,
      cached: true,
      message: cached.streamCount > 0 ? 'Cached streams returned.' : 'Cached empty stream result returned.',
    };
  }

  const dbCached = !options.forceRefresh ? await getPersistentCachedStreams(fixtureKey) : null;
  if (dbCached) {
    streamCache.set(fixtureKey, dbCached);
    return {
      ...dbCached,
      cached: true,
      message: dbCached.streamCount > 0 ? 'Persistent cached streams returned.' : 'Persistent cached empty stream result returned.',
    };
  }

  const existingLookup = !options.forceRefresh ? inFlightStreamLookups.get(fixtureKey) : null;
  if (existingLookup) {
    return existingLookup;
  }

  const lookupPromise = (async () => {
    const searchTerms = buildSearchTerms(match);
    const outputName = `${safeSlug(match.homeTeam)}-vs-${safeSlug(match.awayTeam)}`;
    let streams = [];
    let matchedSearchTerm = null;
    let runtime = null;
    const errors = [];
    const startedAt = Date.now();
    const attemptedTerms = [];

    for (const searchTerm of searchTerms) {
      if (Date.now() - startedAt >= TOTAL_SCRAPE_TIMEOUT_MS) {
        errors.push({
          searchTerm,
          message: `Overall stream lookup timed out after ${TOTAL_SCRAPE_TIMEOUT_MS}ms`,
        });
        break;
      }

      try {
        attemptedTerms.push(searchTerm);
        console.log(`[stream-scraper] Trying "${searchTerm}" for ${match.homeTeam} vs ${match.awayTeam}`);
        const result = await runScraperForTerm({ searchTerm, outputName });
        if (result.streams.length > 0) {
          streams = result.streams;
          matchedSearchTerm = searchTerm;
          runtime = result.pythonCommand;
          break;
        }
      } catch (error) {
        errors.push({ searchTerm, message: error.message });
      }
    }

    const validatedSummary = {
      checkedCount: streams.filter((stream) => stream.isValidated).length,
      aliveCount: streams.filter((stream) => stream.isAlive === true).length,
      failedCount: streams.filter((stream) => stream.isAlive === false).length,
    };

    const response = {
      fixtureId: match.fixtureId || null,
      matchId: String(match._id),
      matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
      status: match.status,
      league: match.league,
      available: streams.length > 0,
      source: 'iptv-scraper',
      searchedTerms: searchTerms,
      matchedSearchTerm,
      streams,
      streamCount: streams.length,
      state: streams.length > 0 ? 'ready' : 'empty',
      cached: false,
      cachedAt: Date.now(),
      runtime,
      errors,
      diagnostics: {
        skipped: false,
        attemptedTerms,
        durationMs: Date.now() - startedAt,
        priorityMatch: isPriorityMatch(match),
        validation: validatedSummary,
      },
      message: streams.length > 0
        ? 'Live streams fetched successfully.'
        : errors.length > 0
          ? 'Stream lookup timed out or no source returned a working link yet.'
          : 'Scraper completed but no stream was found.',
    };

    streamCache.set(fixtureKey, response);
    await saveStreamsToPersistentCache(fixtureKey, response);
    return response;
  })();

  inFlightStreamLookups.set(fixtureKey, lookupPromise);

  try {
    return await lookupPromise;
  } finally {
    inFlightStreamLookups.delete(fixtureKey);
  }
};

export const clearLiveStreamCache = (fixtureId) => {
  if (!fixtureId) {
    streamCache.clear();
    return StreamCache.deleteMany({});
  }

  const fixtureKey = String(fixtureId);
  streamCache.delete(fixtureKey);
  return StreamCache.deleteOne({ fixtureKey });
};

export const getStreamScraperHealth = async () => {
  if (cachedHealthSnapshot && (Date.now() - cachedHealthAt) < HEALTH_CACHE_TTL_MS) {
    return cachedHealthSnapshot;
  }

  const candidates = getPythonCandidates();
  let pythonCommand = null;
  let pythonVersion = null;
  let dependenciesInstalled = false;
  let scraperAccessible = false;
  let cliRunnable = false;
  const checks = [];

  try {
    await resolveScraperPaths();
    scraperAccessible = true;
  } catch (error) {
    checks.push({
      check: 'scraper_path',
      ok: false,
      code: classifyError(error.message),
      message: error.message,
    });
  }

  for (const command of candidates) {
    try {
      const versionArgs = command === 'py' ? ['-3', '--version'] : ['--version'];
      const versionResult = await runCommand({
        command,
        args: versionArgs,
        cwd: backendRoot,
        env: buildPythonEnv(),
        timeoutMs: HEALTH_CHECK_TIMEOUT,
      });
      pythonCommand = command;
      pythonVersion = (versionResult.stdout || versionResult.stderr).trim();
      checks.push({ check: 'python', ok: true, message: pythonVersion, command });
      break;
    } catch (error) {
      checks.push({
        check: 'python',
        ok: false,
        command,
        code: classifyError(error.message),
        message: error.message,
      });
    }
  }

  if (pythonCommand && scraperAccessible) {
    const { scraperDir } = await resolveScraperPaths();
    const env = buildPythonEnv(scraperDir);

    try {
      const depArgs = pythonCommand === 'py'
        ? ['-3', '-c', 'import bs4, requests, termcolor, colorama, art; print("deps-ok")']
        : ['-c', 'import bs4, requests, termcolor, colorama, art; print("deps-ok")'];
      const depResult = await runCommand({
        command: pythonCommand,
        args: depArgs,
        cwd: backendRoot,
        env,
        timeoutMs: HEALTH_CHECK_TIMEOUT,
      });
      dependenciesInstalled = (depResult.stdout || depResult.stderr).includes('deps-ok');
      checks.push({
        check: 'dependencies',
        ok: dependenciesInstalled,
        message: dependenciesInstalled ? 'Python scraper dependencies available.' : 'Dependency check did not confirm readiness.',
      });
    } catch (error) {
      checks.push({
        check: 'dependencies',
        ok: false,
        code: classifyError(error.message),
        message: error.message,
      });
    }

    if (dependenciesInstalled) {
      try {
        const helpArgs = pythonCommand === 'py'
          ? ['-3', '-m', 'iptv_scraper.cli', '--help']
          : ['-m', 'iptv_scraper.cli', '--help'];
        await runCommand({
          command: pythonCommand,
          args: helpArgs,
          cwd: scraperDir,
          env,
          timeoutMs: HEALTH_CHECK_TIMEOUT,
        });
        cliRunnable = true;
        checks.push({
          check: 'cli',
          ok: true,
          message: 'IPTV scraper CLI runnable.',
        });
      } catch (error) {
        checks.push({
          check: 'cli',
          ok: false,
          code: classifyError(error.message),
          message: error.message,
        });
      }
    }
  }

  const response = {
    ok: scraperAccessible && !!pythonCommand && dependenciesInstalled && cliRunnable,
    source: 'iptv-scraper',
    scraperAccessible,
    pythonCommand,
    pythonVersion,
    dependenciesInstalled,
    cliRunnable,
    checks,
  };

  cachedHealthSnapshot = response;
  cachedHealthAt = Date.now();
  return response;
};

const getPrefetchCandidates = async () => {
  const now = new Date();
  const upcomingWindowEnd = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  const matches = await Match.find({
    $or: [
      { status: 'Live' },
      {
        status: 'Upcoming',
        matchTime: { $gte: now, $lte: upcomingWindowEnd },
      },
    ],
  })
    .sort({ status: -1, matchTime: 1 })
    .limit(PREFETCH_MATCH_LIMIT * 3)
    .lean();

  return matches
    .filter((match) => match.status === 'Live' || isPriorityMatch(match))
    .slice(0, PREFETCH_MATCH_LIMIT);
};

export const prefetchPriorityMatchStreams = async () => {
  if (prefetchInFlight) {
    return { ok: true, skipped: true, reason: 'prefetch_already_running' };
  }

  prefetchInFlight = true;

  try {
    const health = await getStreamScraperHealth();
    if (!health.ok) {
      return { ok: false, skipped: true, reason: 'scraper_not_ready', health };
    }

    const matches = await getPrefetchCandidates();
    const results = [];

    for (const match of matches) {
      try {
        const fixtureKey = getFixtureKey(match);
        const cached = getCachedStreams(fixtureKey) || (await getPersistentCachedStreams(fixtureKey));

        const cacheAgeMs = cached ? Date.now() - Number(cached.cachedAt || 0) : null;
        const shouldRefreshLive = match.status === 'Live' && cacheAgeMs !== null && cacheAgeMs >= PREFETCH_REFRESH_LIVE_AFTER_MS;

        if (cached && !shouldRefreshLive) {
          results.push({
            fixtureKey,
            matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
            state: 'cache_hit',
            streamCount: cached.streamCount || 0,
          });
          continue;
        }

        console.log(`[stream-prefetch] Prefetching ${match.homeTeam} vs ${match.awayTeam} (${match.status})`);
        const response = await getLiveStreamsForMatch(match, { forceRefresh: true });
        const diagnostics = {
          ...(response.diagnostics || {}),
          prefetchedAt: new Date(),
        };
        const prefetchedResponse = { ...response, diagnostics };
        streamCache.set(fixtureKey, prefetchedResponse);
        await saveStreamsToPersistentCache(fixtureKey, prefetchedResponse);

        results.push({
          fixtureKey,
          matchLabel: response.matchLabel,
          state: response.state,
          streamCount: response.streamCount,
        });
      } catch (error) {
        results.push({
          fixtureKey: getFixtureKey(match),
          matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
          state: 'error',
          message: error.message,
        });
      }
    }

    return { ok: true, skipped: false, checkedMatches: matches.length, results };
  } finally {
    prefetchInFlight = false;
  }
};

export const startStreamPrefetchLoop = () => {
  if (prefetchIntervalHandle || process.env.ENABLE_STREAM_PREFETCH === 'false') {
    return;
  }

  const runPrefetch = async () => {
    try {
      const result = await prefetchPriorityMatchStreams();
      if (!result.skipped) {
        console.log(`[stream-prefetch] cycle complete for ${result.checkedMatches || 0} matches`);
      }
    } catch (error) {
      console.error('[stream-prefetch] cycle failed:', error.message);
    }
  };

  prefetchIntervalHandle = setInterval(runPrefetch, PREFETCH_INTERVAL_MS);
  void runPrefetch();
};

export const stopStreamPrefetchLoop = () => {
  if (!prefetchIntervalHandle) return;
  clearInterval(prefetchIntervalHandle);
  prefetchIntervalHandle = null;
};
