import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');

const DEFAULT_SCRAPER_DIR = path.join(backendRoot, 'tools', 'iptv-scraper');
const CACHE_DIR = path.join(backendRoot, '.stream-cache');
const STREAM_CACHE_TTL = 5 * 60 * 1000;
const MAX_STREAMS = Number(process.env.IPTV_STREAM_MAX_STREAMS || 6);
const MAX_SEARCH_TERMS = Number(process.env.IPTV_STREAM_MAX_SEARCH_TERMS || 3);
const SCRAPER_TIMEOUT_MS = Number(process.env.IPTV_SCRAPER_TIMEOUT_MS || 120000);
const HEALTH_CHECK_TIMEOUT = 20 * 1000;

const streamCache = new Map();

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

const buildSearchTerms = (match) => {
  const rawTerms = [
    `${match.homeTeam} vs ${match.awayTeam}`,
    `${match.homeTeam} ${match.awayTeam}`,
    `${match.league} ${match.homeTeam}`,
    `${match.league} ${match.awayTeam}`,
    match.league,
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

  return dedupeStreams(parsedGroups.flat()).slice(0, MAX_STREAMS);
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

export const getLiveStreamsForMatch = async (match, options = {}) => {
  if (match.status !== 'Live') {
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
      state: 'not_live',
      cached: false,
      cachedAt: Date.now(),
      runtime: null,
      errors: [],
      message: 'Streams are fetched only for matches currently marked Live.',
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

  const searchTerms = buildSearchTerms(match);
  const outputName = `${safeSlug(match.homeTeam)}-vs-${safeSlug(match.awayTeam)}`;
  let streams = [];
  let matchedSearchTerm = null;
  let runtime = null;
  const errors = [];

  for (const searchTerm of searchTerms) {
    try {
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
    message: streams.length > 0
      ? 'Live streams fetched successfully.'
      : errors.length > 0
        ? 'No stream found from scraper sources.'
        : 'Scraper completed but no stream was found.',
  };

  streamCache.set(fixtureKey, response);
  return response;
};

export const clearLiveStreamCache = (fixtureId) => {
  if (!fixtureId) {
    streamCache.clear();
    return;
  }

  streamCache.delete(String(fixtureId));
};

export const getStreamScraperHealth = async () => {
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

  return {
    ok: scraperAccessible && !!pythonCommand && dependenciesInstalled && cliRunnable,
    source: 'iptv-scraper',
    scraperAccessible,
    pythonCommand,
    pythonVersion,
    dependenciesInstalled,
    cliRunnable,
    checks,
  };
};
