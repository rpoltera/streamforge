'use strict';

const express     = require('express');
const multer      = require('multer');
const xml2js      = require('xml2js');
const fetch       = require('node-fetch');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');
const { v4: uuidv4 } = require('uuid');
const cron        = require('node-cron');
const path        = require('path');
const fs          = require('fs');
const fsp         = require('fs').promises;
const { spawn, execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = process.env.SF_CONFIG || path.join(__dirname, '../data/config/config.json');
const DATA_DIR    = process.env.SF_DATA   || path.join(__dirname, '../data');
const LOG_DIR     = process.env.SF_LOG    || DATA_DIR;

let config = {
  port: 8080,
  baseUrl: 'http://localhost:8080',
  dataDir: DATA_DIR,
  epgDaysAhead: 7,

  // FFmpeg paths
  ffmpegPath:  '/usr/bin/ffmpeg',
  ffprobePath: '/usr/bin/ffprobe',

  // Hardware acceleration
  hwAccel: 'auto',

  // Video profile
  videoResolution: '1920x1080',
  videoCodec:      'copy',       // copy | h264 | hevc
  videoBitrate:    '4M',
  videoMaxBitrate: '8M',
  videoBufferSize: '8M',
  videoPreset:     'p4',         // nvenc preset / libx264 preset
  videoCrf:        '23',

  // Audio
  audioCodec:      'aac',
  audioBitrate:    '192k',
  audioChannels:   '2',
  audioLanguage:   'eng',        // preferred audio language (ISO 639-2)
  normalizeAudio:  true,         // aresample async fix

  // Subtitles
  extractSubtitles: false,
  burnSubtitles:    false,

  // HLS segmenter
  hlsSegmentSeconds:    4,
  hlsListSize:          6,
  hlsWorkaheadLimit:    1,
  hlsInitialSegments:   1,
  hlsOutputFormat:      'mpegts',  // mpegts | fmp4
  hlsIdleTimeoutSecs:   60,

  // AI provider — 'anthropic' | 'openai' | 'openwebui' | 'ollama' | 'custom'
  aiProvider: 'anthropic',
  anthropicApiKey: '',
  openaiApiKey: '',
  openaiModel: 'gpt-4o',
  openaiApiUrl: 'http://localhost:3000/api/v1',
  openaiApiKey2: '',              // alias for openwebui key
  openwebUIUrl: 'http://localhost:3000/api/v1',
  openwebUIKey: '',
  openwebUIModel: '',
  ollamaUrl: 'http://localhost:11434/v1',
  ollamaModel: 'llama3.2',
  customAiUrl: '',
  customAiKey: '',
  customAiModel: '',

  // Misc
  probeInterlaced:   false,
  saveTroubleshooting: false,
  globalWatermark:   '',
};

try {
  if (fs.existsSync(CONFIG_PATH))
    Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (_) {}

// ── Hardware transcoding detection ───────────────────────────────────────────
function detectHardware() {
  // Check NVIDIA GPU
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { timeout: 3000 });
    // Check ffmpeg has nvenc support
    const codecs = execSync(`"${config.ffmpegPath}" -codecs 2>/dev/null | grep nvenc`, { timeout: 5000 }).toString();
    if (codecs.includes('nvenc')) {
      console.log('[sf] Hardware: NVIDIA NVENC detected');
      return 'nvenc';
    }
  } catch (_) {}

  // Check VAAPI (Intel/AMD on Linux)
  try {
    if (fs.existsSync('/dev/dri/renderD128')) {
      console.log('[sf] Hardware: VAAPI device found at /dev/dri/renderD128');
      return 'vaapi';
    }
  } catch (_) {}

  console.log('[sf] Hardware: No GPU acceleration found, using software');
  return 'software';
}

// Auto-detect ffmpeg/ffprobe if configured path doesn't exist
function detectBinary(name, configured) {
  if (configured && fs.existsSync(configured)) return configured;
  // Try common paths
  const candidates = [
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/snap/bin/${name}`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try which
  try {
    const found = execSync(`which ${name} 2>/dev/null`, { timeout: 3000 }).toString().trim();
    if (found) return found;
  } catch (_) {}
  return configured || `/usr/bin/${name}`;
}
config.ffmpegPath  = detectBinary('ffmpeg',  config.ffmpegPath);
config.ffprobePath = detectBinary('ffprobe', config.ffprobePath);
console.log(`[sf] ffmpeg:  ${config.ffmpegPath}  exists=${fs.existsSync(config.ffmpegPath)}`);
console.log(`[sf] ffprobe: ${config.ffprobePath}  exists=${fs.existsSync(config.ffprobePath)}`);
// Use user-configured hw accel, fall back to auto-detect if not set
if (!config.hwAccel || config.hwAccel === 'auto') {
  config.hwAccel = detectHardware();
  console.log(`[sf] hw accel auto-detected: ${config.hwAccel}`);
} else {
  console.log(`[sf] hw accel user-configured: ${config.hwAccel}`);
}

const CHANNELS_FILE  = path.join(config.dataDir, 'channels.json');
const LIBRARIES_FILE = path.join(config.dataDir, 'libraries.json');
const MEDIA_FILE     = path.join(config.dataDir, 'media.json');
const EPG_FILE       = path.join(config.dataDir, 'epg.json');
const STREAMS_FILE   = path.join(config.dataDir, 'streams.json');
const UPLOADS_DIR    = path.join(config.dataDir, 'uploads');

[
  path.join(config.dataDir, 'config'),
  path.join(config.dataDir, 'hls'),
  UPLOADS_DIR,
].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} });

// ── State ─────────────────────────────────────────────────────────────────────
let db = {
  channels:  loadJson(CHANNELS_FILE,  []),
  libraries: loadJson(LIBRARIES_FILE, []),
  media:     loadJson(MEDIA_FILE,     []),
  epg:       loadJson(EPG_FILE,       { channels: [], programs: [], importedAt: null, sourceName: '' }),
  streams:   loadJson(STREAMS_FILE,   []),
};

function loadJson(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (_) { return JSON.parse(JSON.stringify(def)); }
}
function saveJson(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error('[sf] save:', e.message); }
}
function saveAll() {
  saveJson(CHANNELS_FILE,  db.channels);
  saveJson(LIBRARIES_FILE, db.libraries);
  saveJson(MEDIA_FILE,     db.media);
  saveJson(EPG_FILE,       db.epg);
  saveJson(STREAMS_FILE,   db.streams);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
try {
  app.use(morgan('combined', {
    stream: fs.createWriteStream(path.join(LOG_DIR, 'access.log'), { flags: 'a' })
  }));
} catch (_) { app.use(morgan('dev')); }
app.use(express.static(path.join(__dirname, '../public')));
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 500 * 1024 * 1024 } });
const uploadEpg = multer({ dest: UPLOADS_DIR, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB for large EPG files

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

// ── Media file extensions ─────────────────────────────────────────────────────
const VIDEO_EXTS = new Set(['.mkv','.mp4','.avi','.mov','.wmv','.m4v','.ts','.m2ts','.flv','.webm','.ogv','.3gp']);

// Probe source video codec — returns { codec, pixFmt, is10bit, needsTranscode }
function probeVideoCodec(srcPath) {
  try {
    const out = execSync(
      `"${config.ffprobePath}" -v quiet -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of csv=p=0 "${srcPath}"`,
      { timeout: 10000 }
    ).toString().trim();
    const [codec, pixFmt] = out.split(',');
    const is10bit = pixFmt && (pixFmt.includes('10') || pixFmt.includes('12'));
    const needsTranscode = codec === 'hevc' || codec === 'av1' || codec === 'vp9' || is10bit;
    return { codec: codec || 'unknown', pixFmt: pixFmt || 'unknown', is10bit: !!is10bit, needsTranscode };
  } catch (_) {
    return { codec: 'unknown', pixFmt: 'unknown', is10bit: false, needsTranscode: false };
  }
}

// ── Get video duration via ffprobe ─────────────────────────────────────────────
function getDuration(filePath) {
  try {
    const out = execSync(
      `"${config.ffprobePath}" -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 10000 }
    ).toString().trim();
    const d = parseFloat(out);
    return isNaN(d) ? 0 : Math.floor(d);
  } catch (_) { return 0; }
}

// ── Parse title/year/season/episode from filename ──────────────────────────────
function parseFilename(name) {
  const base = path.basename(name, path.extname(name));
  let title = base, year = null, season = null, episode = null;

  // Season/episode: S01E02 or 1x02
  const seMatch = base.match(/[Ss](\d+)[Ee](\d+)/);
  if (seMatch) {
    season  = parseInt(seMatch[1]);
    episode = parseInt(seMatch[2]);
    title   = base.slice(0, seMatch.index).replace(/[._\-]+$/,'').replace(/[._]/g,' ').trim();
  }
  // Year: (2021) or .2021.
  const yrMatch = base.match(/[\.(]((?:19|20)\d{2})[\.)]/);
  if (yrMatch) {
    year  = parseInt(yrMatch[1]);
    if (!seMatch) title = base.slice(0, yrMatch.index).replace(/[._]/g,' ').trim();
  }
  if (!seMatch && !yrMatch) title = base.replace(/[._]/g,' ').trim();

  return {
    title: title || base,
    year,
    season,
    episode,
    type: (season !== null) ? 'episode' : 'movie',
  };
}

// ── Scan a local directory for media files ─────────────────────────────────────
async function scanLocalDirectory(libId, dirPath, existingPaths) {
  const items = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); }
      else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        if (!existingPaths.has(full)) {
          const meta = parseFilename(e.name);
          const duration = getDuration(full);
          items.push({
            id: uuidv4(),
            libraryId: libId,
            path: full,
            filename: e.name,
            title: meta.title,
            year: meta.year,
            season: meta.season,
            episode: meta.episode,
            type: meta.type,
            duration,
            addedAt: new Date().toISOString(),
          });
        }
      }
    }
  }
  await walk(dirPath);
  return items;
}

// ── Fetch Plex library items ───────────────────────────────────────────────────
async function fetchPlexLibrary(lib) {
  const base    = lib.url.replace(/\/+$/, '');
  const headers = { 'X-Plex-Token': lib.token, 'Accept': 'application/json' };
  const items   = [];
  const PAGE_SIZE = 100; // fetch in pages to avoid timeouts

  // Get sections - filter to the one the user picked if sectionKey is set
  const sectRes = await fetch(`${base}/library/sections`, { headers, timeout: 15000 });
  if (!sectRes.ok) throw new Error(`Plex HTTP ${sectRes.status}`);
  const sectData = await sectRes.json();
  let sections = sectData.MediaContainer.Directory || [];

  if (lib.sectionKey) {
    sections = sections.filter(s => String(s.key) === String(lib.sectionKey));
  } else {
    sections = sections.filter(s => ['movie','show'].includes(s.type));
  }

  for (const sect of sections) {
    // For TV shows use /allLeaves which returns individual episodes directly —
    // far more efficient than drilling show→season→episode (thousands of calls)
    const endpoint = sect.type === 'show' ? 'allLeaves' : 'all';

    // Fetch total count first
    const countRes = await fetch(
      `${base}/library/sections/${sect.key}/${endpoint}?X-Plex-Container-Start=0&X-Plex-Container-Size=0`,
      { headers, timeout: 15000 }
    );
    if (!countRes.ok) continue;
    const countData = await countRes.json();
    const total = parseInt(countData.MediaContainer.totalSize || countData.MediaContainer.size || 0);
    console.log(`[sf] Plex section "${sect.title}" (${sect.type}): ${total} items via /${endpoint}`);

    // Paginate through all items
    for (let start = 0; start < total; start += PAGE_SIZE) {
      const pageRes = await fetch(
        `${base}/library/sections/${sect.key}/${endpoint}?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`,
        { headers, timeout: 30000 }
      );
      if (!pageRes.ok) { console.error(`[sf] Plex page error at ${start}`); continue; }
      const pageData = await pageRes.json();
      const entries  = pageData.MediaContainer.Metadata || [];

      for (const m of entries) {
        const filePath = m.Media?.[0]?.Part?.[0]?.file || '';
        // Build Plex direct-stream URL using the part key
        // This lets FFmpeg pull the file over HTTP from Plex regardless of where
        // the file physically lives — works even if Plex is on a different machine
        const partKey  = m.Media?.[0]?.Part?.[0]?.key || '';
        const streamUrl = partKey
          ? `${base}${partKey}?X-Plex-Token=${lib.token}`
          : null;

        if (m.type === 'movie') {
          items.push({
            id: uuidv4(), libraryId: lib.id,
            path: streamUrl || filePath,   // prefer HTTP stream URL
            localPath: filePath,           // keep local path as fallback reference
            filename: path.basename(filePath),
            title: m.title, year: m.year || null,
            season: null, episode: null, type: 'movie',
            duration: Math.floor((m.duration || 0) / 1000),
            thumb: m.thumb ? `${base}${m.thumb}?X-Plex-Token=${lib.token}` : null,
            summary: m.summary || '',
            plexKey: m.ratingKey,
            sourceType: 'plex',
            addedAt: new Date().toISOString(),
          });
        } else if (m.type === 'episode') {
          items.push({
            id: uuidv4(), libraryId: lib.id,
            path: streamUrl || filePath,   // prefer HTTP stream URL
            localPath: filePath,
            filename: path.basename(filePath),
            title: m.grandparentTitle || m.title,
            year:  m.year || null,
            season:  m.parentIndex  || null,
            episode: m.index        || null,
            type: 'episode',
            duration: Math.floor((m.duration || 0) / 1000),
            thumb: m.thumb ? `${base}${m.thumb}?X-Plex-Token=${lib.token}` : null,
            summary: m.summary || '',
            plexKey: m.ratingKey,
            sourceType: 'plex',
            addedAt: new Date().toISOString(),
          });
        }
      }
    }
  }
  console.log(`[sf] Plex import complete: ${items.length} items`);
  return items;
}

// ── Fetch Jellyfin library items ───────────────────────────────────────────────
async function fetchJellyfinLibrary(lib) {
  const base    = lib.url.replace(/\/+$/, '');
  const headers = { 'X-Emby-Token': lib.token, 'Accept': 'application/json' };
  const items   = [];

  // Filter by the specific Jellyfin library the user picked (ParentId) if set
  const parentFilter = lib.parentId ? `&ParentId=${lib.parentId}` : '';
  const res = await fetch(
    `${base}/Items?IncludeItemTypes=Movie,Episode&Recursive=true${parentFilter}&Fields=Path,RunTimeTicks,Overview,ParentIndexNumber,IndexNumber,ProductionYear,SeriesName,SeasonName&api_key=${lib.token}`,
    { headers, timeout: 30000 }
  );
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  const data = await res.json();

  for (const m of (data.Items || [])) {
    const filePath = m.Path || '';
    const duration = m.RunTimeTicks ? Math.floor(m.RunTimeTicks / 10000000) : 0;
    items.push({
      id: uuidv4(), libraryId: lib.id,
      path: filePath, filename: path.basename(filePath),
      title: m.Type === 'Episode' ? (m.SeriesName || m.Name) : m.Name,
      year: m.ProductionYear || null,
      season: m.ParentIndexNumber || null,
      episode: m.IndexNumber || null,
      type: m.Type === 'Episode' ? 'episode' : 'movie',
      duration,
      thumb: m.ImageTags?.Primary
        ? `${base}/Items/${m.Id}/Images/Primary?api_key=${lib.token}`
        : null,
      summary: m.Overview || '',
      jellyfinId: m.Id,
      addedAt: new Date().toISOString(),
    });
  }
  return items;
}

// ── Playout engine ────────────────────────────────────────────────────────────

// Get the best stream source for a media item.
// Returns { type: 'file'|'http', value: string }
function resolveStreamSource(item) {
  const lib = db.libraries.find(l => l.id === item.libraryId);

  // If path is already an HTTP URL (set during import for Plex/Jellyfin), use it directly
  if (item.path && (item.path.startsWith('http://') || item.path.startsWith('https://'))) {
    return { type: 'http', value: item.path };
  }

  // Jellyfin — build stream URL from stored jellyfinId
  if (item.jellyfinId && lib && lib.type === 'jellyfin' && lib.url) {
    const base = lib.url.replace(/\/+$/, '');
    const url = `${base}/Videos/${item.jellyfinId}/stream?Static=true&api_key=${lib.token}`;
    return { type: 'http', value: url };
  }

  // Plex — plexKey is the ratingKey; build a metadata URL and we need the part key.
  // For newly scanned items, item.path is already the correct part URL.
  // For old items scanned before the fix, try to use the ratingKey with /download
  if (item.plexKey && lib && lib.type === 'plex' && lib.url) {
    const base = lib.url.replace(/\/+$/, '');
    // Try /library/metadata/{ratingKey} → get parts → stream
    // Simplest approach that works: use the direct download endpoint
    const url = `${base}/library/metadata/${item.plexKey}/file?download=0&X-Plex-Token=${lib.token}`;
    console.log(`[sf] Plex stream URL: ${url.slice(0,80)}...`);
    return { type: 'http', value: url };
  }

  // Local file — verify it exists
  if (item.path && fs.existsSync(item.path)) {
    return { type: 'file', value: item.path };
  }

  if (item.path) {
    return { type: 'file', value: item.path };
  }

  return null;
}

// Returns { item, offsetSeconds, startTime, endTime } for what should be playing NOW
function getPlayoutNow(channel, nowMs) {
  const playout = channel.playout || [];
  if (!playout.length) return null;

  // Total duration of one loop — stream blocks use configured duration
  const totalDuration = playout.reduce((sum, block) => {
    if (block.streamId) return sum + (block.duration || 3600);
    const item = db.media.find(m => m.id === block.mediaId);
    return sum + (item ? (item.duration || 1800) : 1800);
  }, 0);
  if (totalDuration === 0) return null;

  // Anchor: playout started at channel.playoutStart (unix ms), or beginning of today
  // Use saved anchor, falling back to start of today (UTC midnight)
  let anchor;
  if (channel.playoutStart) {
    const parsed = new Date(channel.playoutStart).getTime();
    anchor = isNaN(parsed) ? new Date(new Date().toISOString().slice(0,10) + 'T00:00:00Z').getTime() : parsed;
  } else {
    anchor = new Date(new Date().toISOString().slice(0,10) + 'T00:00:00Z').getTime();
  }

  const elapsed = (nowMs - anchor) % (totalDuration * 1000);
  let cursor = 0;

  for (const block of playout) {
    // Live stream block
    if (block.streamId) {
      const stream = db.streams.find(s => s.id === block.streamId);
      const dur = (block.duration || 3600) * 1000;
      if (elapsed < cursor + dur) {
        const startTime = anchor + Math.floor((nowMs - anchor) / (totalDuration * 1000)) * totalDuration * 1000 + cursor;
        return {
          item: null,
          stream,
          block,
          offsetSeconds: 0, // always play live from beginning
          startTime,
          endTime: startTime + dur,
          isLive: true,
        };
      }
      cursor += dur;
      continue;
    }
    const item = db.media.find(m => m.id === block.mediaId);
    if (!item) continue;
    const dur = (item.duration || 1800) * 1000;
    if (elapsed < cursor + dur) {
      const offsetSeconds = Math.floor((elapsed - cursor) / 1000);
      const startTime = anchor + Math.floor((nowMs - anchor) / (totalDuration * 1000)) * totalDuration * 1000 + cursor;
      return {
        item,
        block,
        offsetSeconds,
        startTime,
        endTime: startTime + dur,
      };
    }
    cursor += dur;
  }
  return null;
}

// Build full EPG schedule for a channel for the next N days
function buildChannelSchedule(channel, fromMs, toMs) {
  const playout = channel.playout || [];
  if (!playout.length) return [];

  const totalDuration = playout.reduce((sum, block) => {
    if (block.streamId) return sum + (block.duration || 3600);
    const item = db.media.find(m => m.id === block.mediaId);
    return sum + (item ? (item.duration || 1800) : 1800);
  }, 0);
  if (totalDuration === 0) return [];

  // Use saved anchor, falling back to start of today (UTC midnight)
  let anchor;
  if (channel.playoutStart) {
    const parsed = new Date(channel.playoutStart).getTime();
    anchor = isNaN(parsed) ? new Date(new Date().toISOString().slice(0,10) + 'T00:00:00Z').getTime() : parsed;
  } else {
    anchor = new Date(new Date().toISOString().slice(0,10) + 'T00:00:00Z').getTime();
  }

  const programs = [];
  // Start from the loop iteration that contains fromMs
  const loopDurMs = totalDuration * 1000;
  let loopStart = anchor + Math.floor((fromMs - anchor) / loopDurMs) * loopDurMs;
  if (loopStart > fromMs) loopStart -= loopDurMs;

  while (loopStart < toMs) {
    let cursor = loopStart;
    for (const block of playout) {
      if (block.streamId) {
        const stream = db.streams.find(s => s.id === block.streamId);
        const durMs = (block.duration || 3600) * 1000;
        const start = cursor;
        const end = cursor + durMs;
        if (end > fromMs && start < toMs) {
          programs.push({ start, end, title: stream ? `🔴 ${stream.name}` : '🔴 Live Stream', isLive: true });
        }
        cursor += durMs;
        continue;
      }
      const item = db.media.find(m => m.id === block.mediaId);
      if (!item) continue;
      const durMs = (item.duration || 1800) * 1000;
      const start = cursor;
      const end   = cursor + durMs;
      if (end > fromMs && start < toMs) {
        programs.push({
          start, end,
          title: item.season
            ? `${item.title} S${String(item.season).padStart(2,'0')}E${String(item.episode).padStart(2,'0')}`
            : item.title,
          desc:    item.summary || '',
          episode: item.season ? `${item.season-1}.${(item.episode||1)-1}.0` : '',
          icon:    item.thumb  || '',
        });
      }
      cursor += durMs;
      if (cursor >= toMs + loopDurMs) break;
    }
    loopStart += loopDurMs;
    if (loopStart > toMs) break;
  }
  return programs;
}

// ── API: Status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true, version: '2.0.0',
    channels:  db.channels.length,
    libraries: db.libraries.length,
    media:     db.media.length,
    uptime:    Math.floor(process.uptime()),
    baseUrl:   config.baseUrl,
    ffmpeg:    fs.existsSync(config.ffmpegPath),
    ffmpegPath:  config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    hwAccel: config.hwAccel || 'software',
  });
});

// Probe available hardware acceleration options
app.get('/api/hw-probe', (req, res) => {
  const results = [];

  // Always available
  results.push({ id: 'software', label: 'Software (CPU)', available: true, note: 'Always works, uses CPU' });

  // NVIDIA NVENC
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { timeout: 3000 });
    const gpuName = execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { timeout: 3000 }).toString().trim().split('\n')[0];
    try {
      execSync(`"${config.ffmpegPath}" -hide_banner -encoders 2>/dev/null | grep nvenc`, { timeout: 5000 });
      results.push({ id: 'nvenc', label: 'NVIDIA NVENC', available: true, note: gpuName });
    } catch (_) {
      results.push({ id: 'nvenc', label: 'NVIDIA NVENC', available: false, note: 'GPU found but ffmpeg lacks nvenc support' });
    }
  } catch (_) {
    results.push({ id: 'nvenc', label: 'NVIDIA NVENC', available: false, note: 'No NVIDIA GPU detected' });
  }

  // VAAPI (Intel / AMD on Linux)
  const vaapiDev = ['/dev/dri/renderD128', '/dev/dri/renderD129'].find(d => {
    try { fs.accessSync(d); return true; } catch (_) { return false; }
  });
  if (vaapiDev) {
    try {
      execSync(`"${config.ffmpegPath}" -hide_banner -encoders 2>/dev/null | grep vaapi`, { timeout: 5000 });
      results.push({ id: 'vaapi', label: 'VAAPI (Intel/AMD)', available: true, note: `Device: ${vaapiDev}` });
    } catch (_) {
      results.push({ id: 'vaapi', label: 'VAAPI (Intel/AMD)', available: false, note: 'DRI device found but ffmpeg lacks vaapi support' });
    }
  } else {
    results.push({ id: 'vaapi', label: 'VAAPI (Intel/AMD)', available: false, note: 'No /dev/dri/renderD128 device' });
  }

  // VideoToolbox (macOS - unlikely in LXC but included for completeness)
  try {
    execSync(`"${config.ffmpegPath}" -hide_banner -encoders 2>/dev/null | grep videotoolbox`, { timeout: 5000 });
    results.push({ id: 'videotoolbox', label: 'VideoToolbox (macOS)', available: true, note: '' });
  } catch (_) {}

  res.json({ current: config.hwAccel, options: results });
});

app.get('/api/config', (req, res) => res.json(config));
app.put('/api/config', (req, res) => {
  [
    'baseUrl','epgDaysAhead','ffmpegPath','ffprobePath','hwAccel',
    'videoResolution','videoCodec','videoBitrate','videoMaxBitrate','videoBufferSize',
    'videoPreset','videoCrf','audioCodec','audioBitrate','audioChannels','audioLanguage',
    'normalizeAudio','extractSubtitles','burnSubtitles',
    'hlsSegmentSeconds','hlsListSize','hlsWorkaheadLimit','hlsInitialSegments',
    'hlsOutputFormat','hlsIdleTimeoutSecs','probeInterlaced','saveTroubleshooting',
    'globalWatermark','aiProvider',
    'anthropicApiKey',
    'openaiApiKey','openaiModel',
    'openwebUIUrl','openwebUIKey','openwebUIModel',
    'ollamaUrl','ollamaModel',
    'customAiUrl','customAiKey','customAiModel',
    'logoUrl',
    'sdUsername','sdPassword','sdLineupId','sdAutoUpdate',
  ].forEach(k => {
    if (req.body[k] !== undefined) config[k] = req.body[k];
  });
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (_) {}
  res.json({ ok: true, config });
});

// ── API: Libraries ────────────────────────────────────────────────────────────
app.get('/api/libraries', (req, res) => res.json(db.libraries));

app.post('/api/libraries', async (req, res) => {
  const { name, type, path: dirPath, url, token } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const lib = {
    id: uuidv4(), name, type,
    path: dirPath || '', url: url || '', token: token || '',
    sectionKey: req.body.sectionKey || null,   // Plex section key
    parentId:   req.body.parentId   || null,   // Jellyfin parent/library ID
    itemCount: 0, scannedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.libraries.push(lib);
  saveAll();
  res.status(201).json(lib);
});

app.delete('/api/libraries/:id', (req, res) => {
  const lib = db.libraries.find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: 'not found' });
  db.libraries = db.libraries.filter(l => l.id !== req.params.id);
  db.media = db.media.filter(m => m.libraryId !== req.params.id);
  saveAll();
  res.json({ ok: true });
});

// List available sections/libraries from Plex (for the picker UI)
app.post('/api/libraries/plex-sections', async (req, res) => {
  const { url, token } = req.body;
  if (!url || !token) return res.status(400).json({ error: 'url and token required' });
  try {
    const base = url.replace(/\/+$/, '');
    const r = await fetch(`${base}/library/sections`, {
      headers: { 'X-Plex-Token': token, 'Accept': 'application/json' },
      timeout: 10000,
    });
    if (!r.ok) throw new Error(`Plex HTTP ${r.status}`);
    const data = await r.json();
    const sections = (data.MediaContainer.Directory || [])
      .filter(s => ['movie','show','artist'].includes(s.type))
      .map(s => ({ key: s.key, title: s.title, type: s.type, count: s.count || 0 }));
    res.json(sections);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List available libraries from Jellyfin (for the picker UI)
app.post('/api/libraries/jellyfin-libraries', async (req, res) => {
  const { url, token } = req.body;
  if (!url || !token) return res.status(400).json({ error: 'url and token required' });
  try {
    const base = url.replace(/\/+$/, '');
    const r = await fetch(`${base}/Library/VirtualFolders?api_key=${token}`, {
      headers: { 'X-Emby-Token': token, 'Accept': 'application/json' },
      timeout: 10000,
    });
    if (!r.ok) throw new Error(`Jellyfin HTTP ${r.status}`);
    const data = await r.json();
    const libs = data.map(l => ({
      id: l.ItemId,
      name: l.Name,
      type: l.CollectionType || 'unknown',
      paths: (l.Locations || []),
    }));
    res.json(libs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/libraries/:id/scan', async (req, res) => {
  const lib = db.libraries.find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: 'not found' });

  // Respond immediately — scan runs in background for large libraries
  res.json({ ok: true, status: 'scanning', message: 'Scan started — refresh the page in a moment' });

  try {
    const existingPaths = new Set(
      db.media.filter(m => m.libraryId === lib.id).map(m => m.path)
    );
    let newItems = [];

    if (lib.type === 'local') {
      if (!lib.path) { lib.scanError = 'path required'; saveAll(); return; }
      newItems = await scanLocalDirectory(lib.id, lib.path, existingPaths);
    } else if (lib.type === 'plex') {
      db.media = db.media.filter(m => m.libraryId !== lib.id);
      newItems = await fetchPlexLibrary(lib);
    } else if (lib.type === 'jellyfin') {
      db.media = db.media.filter(m => m.libraryId !== lib.id);
      newItems = await fetchJellyfinLibrary(lib);
    }

    db.media.push(...newItems);
    lib.itemCount = db.media.filter(m => m.libraryId === lib.id).length;
    lib.scannedAt = new Date().toISOString();
    lib.scanError  = null;
    saveAll();
    console.log(`[sf] Scan complete for "${lib.name}": ${newItems.length} new items, ${lib.itemCount} total`);
  } catch (e) {
    lib.scanError = e.message;
    saveAll();
    console.error(`[sf] Scan error for "${lib.name}":`, e.message);
  }
});

// Scan status endpoint — frontend polls this after triggering a scan
app.get('/api/libraries/:id/scan-status', (req, res) => {
  const lib = db.libraries.find(l => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: 'not found' });
  res.json({
    itemCount: lib.itemCount || 0,
    scannedAt: lib.scannedAt || null,
    scanError: lib.scanError || null,
    scanning:  false,
  });
});

// ── API: Media ────────────────────────────────────────────────────────────────
app.get('/api/media', (req, res) => {
  let items = [...db.media];
  if (req.query.libraryId) items = items.filter(m => m.libraryId === req.query.libraryId);
  if (req.query.type)      items = items.filter(m => m.type === req.query.type);
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    items = items.filter(m => m.title.toLowerCase().includes(q));
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  const page  = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 100;
  const start = (page - 1) * limit;
  res.json({ items: items.slice(start, start + limit), total: items.length, page, limit });
});

app.get('/api/media/:id', (req, res) => {
  const item = db.media.find(m => m.id === req.params.id);
  item ? res.json(item) : res.status(404).json({ error: 'not found' });
});

// ── API: Channels ─────────────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  res.json(db.channels.sort((a, b) => a.num - b.num));
});

app.post('/api/channels', (req, res) => {
  const { name, num, group, logo } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxNum = db.channels.length ? Math.max(...db.channels.map(c => c.num)) : 0;
  const ch = {
    id: uuidv4(), num: parseInt(num) || maxNum + 1,
    name, group: group || '', logo: logo || '',
    playout: [], playoutStart: null,
    active: true, createdAt: new Date().toISOString(),
  };
  db.channels.push(ch);
  saveAll();
  res.status(201).json(ch);
});

app.get('/api/channels/:id', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.id);
  ch ? res.json(ch) : res.status(404).json({ error: 'not found' });
});

app.put('/api/channels/:id', (req, res) => {
  const idx = db.channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  ['name','num','group','logo','active','playout','playoutStart'].forEach(k => {
    if (req.body[k] !== undefined) db.channels[idx][k] = req.body[k];
  });
  saveAll();
  res.json(db.channels[idx]);
});

app.delete('/api/channels/:id', (req, res) => {
  const before = db.channels.length;
  db.channels = db.channels.filter(c => c.id !== req.params.id);
  if (db.channels.length === before) return res.status(404).json({ error: 'not found' });
  saveAll();
  res.json({ ok: true });
});

// Playout endpoints
app.get('/api/channels/:id/playout', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'not found' });
  const playout = (ch.playout || []).map(block => {
    if (block.streamId) {
      return { ...block, stream: db.streams.find(s => s.id === block.streamId) || null };
    }
    return { ...block, item: db.media.find(m => m.id === block.mediaId) || null };
  });
  res.json(playout);
});

app.put('/api/channels/:id/playout', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'not found' });
  ch.playout = req.body.playout || [];
  if (req.body.playoutStart !== undefined) ch.playoutStart = req.body.playoutStart;
  saveAll();
  res.json({ ok: true });
});

app.get('/api/channels/:id/now-playing', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'not found' });
  const now = getPlayoutNow(ch, Date.now());
  res.json(now || { item: null });
});

app.get('/api/schedule', (req, res) => {
  const dateStr  = req.query.date || new Date().toISOString().slice(0, 10);
  const fromMs   = new Date(dateStr + 'T00:00:00.000Z').getTime();
  const toMs     = fromMs + 86400000;
  const schedule = db.channels.filter(c => c.active).map(ch => ({
    channel:  { id: ch.id, num: ch.num, name: ch.name, logo: ch.logo },
    programs: buildChannelSchedule(ch, fromMs, toMs),
  }));
  res.json(schedule);
});

// ── Stream via FFmpeg ─────────────────────────────────────────────────────────
app.get('/stream/:channelId', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).send('Channel not found');

  const now = getPlayoutNow(ch, Date.now());
  if (!now) return res.status(404).send('Nothing scheduled on this channel');

  // Live stream block — pass URL directly
  let src;
  if (now.isLive && now.stream) {
    src = { type: 'http', value: now.stream.url };
  } else {
    if (!now.item) return res.status(404).send('Nothing scheduled on this channel');
    src = resolveStreamSource(now.item);
    if (!src) return res.status(404).send('Media source not found. Check library connection.');
  }

  const offset = now.isLive ? 0 : now.offsetSeconds;

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const ffArgs = buildFfmpegArgs(src, offset, { outputFormat: 'mpegts' });

  const ff = spawn(config.ffmpegPath, ffArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res);
  req.on('close', () => ff.kill('SIGKILL'));
  ff.on('error', err => {
    if (!res.headersSent) res.status(500).send('FFmpeg error: ' + err.message);
  });
});

// ── FFmpeg argument builder ───────────────────────────────────────────────────
// Handles: hardware accel selection, audio fix, HLS vs MPEG-TS output
//
// NVENC strategy: software decode → NVENC encode (most compatible)
// DO NOT use -hwaccel cuda + -hwaccel_output_format cuda for HTTP sources —
// that requires CUDA-decoded frames which breaks with Plex/Jellyfin HTTP streams.
// "Software decode + hardware encode" works universally and still uses the GPU.
function buildFfmpegArgs(src, offsetSeconds, opts = {}) {
  const { outputFormat = 'hls', hlsDir } = opts;
  const hw     = config.hwAccel     || 'software';
  const vCodec = config.videoCodec  || 'copy';
  const args   = [];

  // ── Input ────────────────────────────────────────────────────────────────────
  args.push('-re');
  if (offsetSeconds > 0) args.push('-ss', String(offsetSeconds));
  if (src.type === 'http') args.push('-user_agent', 'StreamForge/2.0 FFmpeg');
  args.push('-i', src.value);

  // ── Audio stream selection (preferred language) ───────────────────────────────
  if (config.audioLanguage && config.audioLanguage !== 'any') {
    args.push('-map', '0:v:0');
    args.push('-map', `0:a:m:language:${config.audioLanguage}?`);
    args.push('-map', '0:a:0?');
  }

  // ── Video codec ───────────────────────────────────────────────────────────────
  const res        = config.videoResolution || 'source';
  const bitrate    = config.videoBitrate    || '4M';
  const maxBitrate = config.videoMaxBitrate || '8M';
  const bufSize    = config.videoBufferSize || '8M';
  const crf        = String(config.videoCrf || 23);
  const preset     = config.videoPreset    || 'p4';

  // Scale filter (only when resolution is set and not source)
  const scaleFilter = (res && res !== 'source')
    ? (() => { const [w,h]=res.split('x'); return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`; })()
    : null;

  // Auto-detect: if copy mode selected but source is HEVC/10-bit, auto-transcode
  let effectiveVCodec = vCodec;
  if (vCodec === 'copy' && src) {
    const probeResult = probeVideoCodec(src.value);
    if (probeResult.needsTranscode) {
      console.log(`[sf/ffmpeg] Auto-transcoding: source is ${probeResult.codec} ${probeResult.pixFmt} — switching to h264_nvenc`);
      effectiveVCodec = 'h264';
    }
  }

  if (effectiveVCodec === 'copy') {
    args.push('-vcodec', 'copy');

  } else if (hw === 'nvenc') {
    // CPU decode → NVENC encode (most compatible with HTTP sources like Plex)
    // scale_cuda lacks aspect ratio support so we use CPU scale + GPU encode
    if (scaleFilter) {
      args.push('-vf', `${scaleFilter},format=yuv420p`);
    } else {
      args.push('-pix_fmt', 'yuv420p');
    }
    args.push(
      '-vcodec', effectiveVCodec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc',
      '-preset', preset,
      '-rc:v', 'vbr', '-cq:v', crf,
      '-b:v', bitrate, '-maxrate:v', maxBitrate, '-bufsize:v', bufSize,
      '-profile:v', 'high', '-level:v', '4.1', '-g', '48',
    );

  } else if (hw === 'vaapi') {
    const vf = scaleFilter ? `${scaleFilter},format=nv12,hwupload` : 'format=nv12,hwupload';
    args.push('-vf', vf);
    args.push(
      '-vcodec', effectiveVCodec === 'hevc' ? 'hevc_vaapi' : 'h264_vaapi',
      '-qp', crf, '-b:v', bitrate, '-profile:v', 'high',
    );

  } else {
    // Software encode (libx264 / libx265)
    if (scaleFilter) args.push('-vf', `${scaleFilter},format=yuv420p`);
    else args.push('-pix_fmt', 'yuv420p');
    args.push(
      '-vcodec', effectiveVCodec === 'hevc' ? 'libx265' : 'libx264',
      '-crf', crf, '-preset', preset === 'p4' ? 'fast' : preset,
      '-b:v', bitrate, '-maxrate:v', maxBitrate, '-bufsize:v', bufSize,
      '-profile:v', 'high',
    );
  }

  // ── Audio codec ───────────────────────────────────────────────────────────────
  const aCodec    = config.audioCodec    || 'aac';
  const aBitrate  = config.audioBitrate  || '192k';
  const aChannels = String(config.audioChannels || 2);
  args.push('-acodec', aCodec, '-b:a', aBitrate, '-ac', aChannels);
  if (config.normalizeAudio !== false) {
    args.push('-af', 'aresample=async=1:min_hard_comp=0.1:first_pts=0');
  }

  // ── Output format ─────────────────────────────────────────────────────────────
  if (outputFormat === 'hls') {
    const segFmt  = config.hlsOutputFormat === 'fmp4' ? 'fmp4' : 'mpegts';
    const segTime = String(config.hlsSegmentSeconds || 4);
    const listSz  = String(config.hlsListSize || 6);
    args.push(
      '-f', 'hls',
      '-hls_time', segTime,
      '-hls_list_size', listSz,
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_type', segFmt,
      '-hls_segment_filename', path.join(hlsDir, 'seg%05d.' + (segFmt === 'fmp4' ? 'm4s' : 'ts')),
      path.join(hlsDir, 'index.m3u8'),
    );
  } else {
    args.push('-f', 'mpegts', '-mpegts_flags', 'resend_headers', 'pipe:1');
  }

  console.log(`[sf/ffmpeg] hw=${hw} vcodec=${vCodec} audio=${aCodec} seg=${outputFormat}`);
  return args;
}

// ── HLS Stream (for browser player) ──────────────────────────────────────────
// We keep one ffmpeg process per channel, writing segments to a temp dir.
// The browser polls the m3u8 playlist and fetches segments.
const hlsSessions = {}; // channelId -> { proc, dir, lastRequest }

function getHlsDir(channelId) {
  return path.join(config.dataDir, 'hls', channelId);
}

function startHlsSession(ch) {
  const channelId = ch.id;
  // Kill any existing session cleanly before starting new one
  if (hlsSessions[channelId]) {
    try { hlsSessions[channelId].proc.kill('SIGKILL'); } catch (_) {}
    delete hlsSessions[channelId];
  }

  const hlsDir = getHlsDir(channelId);
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch (_) {}
  // Clean old segments
  try {
    fs.readdirSync(hlsDir).forEach(f => {
      const ext = f.split('.').pop();
      if (['ts','m3u8','m4s','vtt','mp4','tmp'].includes(ext))
        fs.unlinkSync(path.join(hlsDir, f));
    });
  } catch (_) {}

  const now = getPlayoutNow(ch, Date.now());
  if (!now) {
    console.log(`[sf/hls] No playout item found for channel ${ch.id}`);
    return null;
  }

  let src;
  if (now.isLive && now.stream) {
    src = { type: 'http', value: now.stream.url };
    console.log(`[sf/hls] Starting LIVE stream "${now.stream.name}" url=${now.stream.url.slice(0,60)}`);
  } else {
    if (!now.item) { console.log(`[sf/hls] No playout item for ${ch.id}`); return null; }
    src = resolveStreamSource(now.item);
    if (!src) {
      console.log(`[sf/hls] No stream source for item: ${now.item.title} (id:${now.item.id})`);
      return null;
    }
    console.log(`[sf/hls] Starting stream for "${now.item.title}" offset=${now.offsetSeconds}s src=${src.type}:${src.value.slice(0,60)}`);
  }

  const ffArgs = buildFfmpegArgs(src, now.isLive ? 0 : now.offsetSeconds, {
    outputFormat: 'hls',
    hlsDir,
  });

  if (!fs.existsSync(config.ffmpegPath)) {
    console.error(`[sf] HLS ERROR: ffmpeg not found at "${config.ffmpegPath}"`);
    console.error('[sf] Install it: apt-get install -y ffmpeg');
    return null;
  }

  const proc = spawn(config.ffmpegPath, ffArgs, { stdio: ['ignore','ignore','pipe'] });
  const session = { proc, dir: hlsDir, lastRequest: Date.now(), startedAt: new Date().toISOString(), _spawnedAt: Date.now(), _lastError: null };
  hlsSessions[channelId] = session;

  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (!line) return;
    console.log('[sf/ffmpeg]', line.slice(0, 150));
    stderrBuf += line + '\n';
    // Store the last meaningful error
    if (line.includes('Error') || line.includes('error') || line.includes('No such') || line.includes('Invalid') || line.includes('fail')) {
      session._lastError = line.slice(0, 200);
    }
  });

  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[sf] ffmpeg exited code=${code} for channel ${channelId}`);
      if (!session._lastError && stderrBuf) {
        // grab last non-empty line
        session._lastError = stderrBuf.trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || 'Unknown error';
      }
    }
    delete hlsSessions[channelId];
  });
  return hlsSessions[channelId];
}

// Serve HLS playlist
app.get('/hls/:channelId/index.m3u8', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).send('Channel not found');

  const session = hlsSessions[req.params.channelId] || startHlsSession(ch);
  if (!session) return res.status(404).send('Nothing playing on this channel');
  session.lastRequest = Date.now();

  const m3u8Path = path.join(session.dir, 'index.m3u8');
  // Wait up to 8s for the first playlist to appear
  let waited = 0;
  const tryServe = () => {
    if (fs.existsSync(m3u8Path)) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.sendFile(m3u8Path);
    }
    waited += 300;
    if (waited > 8000) return res.status(503).send('HLS not ready yet');
    setTimeout(tryServe, 300);
  };
  tryServe();
});

// Serve HLS segments
app.get('/hls/:channelId/:segment', (req, res) => {
  const session = hlsSessions[req.params.channelId];
  if (!session) return res.status(404).send('No active session');
  session.lastRequest = Date.now();
  const segPath = path.join(session.dir, req.params.segment);
  if (!fs.existsSync(segPath)) return res.status(404).send('Segment not found');
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(segPath);
});

// API: get HLS session status + last ffmpeg error
app.get('/api/channels/:id/watch-status', (req, res) => {
  const session = hlsSessions[req.params.id];
  if (!session) return res.json({ active: false, error: session?._lastError || null });
  res.json({
    active: true,
    hwAccel: config.hwAccel,
    error: session._lastError || null,
    started: session.startedAt,
  });
});

// API: start/stop HLS session
app.post('/api/channels/:id/watch', (req, res) => {
  const ch = db.channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'not found' });
  // If a healthy session already exists, just return it — don't restart
  const existing = hlsSessions[req.params.id];
  if (existing && existing.proc && !existing.proc.killed) {
    existing.lastRequest = Date.now();
    return res.json({ ok: true, hlsUrl: `/hls/${ch.id}/index.m3u8` });
  }
  const session = startHlsSession(ch);
  if (!session) return res.status(404).json({ error: 'Nothing scheduled' });
  res.json({ ok: true, hlsUrl: `/hls/${ch.id}/index.m3u8` });
});

app.delete('/api/channels/:id/watch', (req, res) => {
  const session = hlsSessions[req.params.id];
  if (session) {
    try { session.proc.kill('SIGKILL'); } catch (_) {}
    delete hlsSessions[req.params.id];
  }
  res.json({ ok: true });
});

// Reap idle HLS sessions (no request in 30s)
setInterval(() => {
  const now = Date.now();
  Object.entries(hlsSessions).forEach(([id, sess]) => {
    const idleMs = (config.hlsIdleTimeoutSecs || 60) * 1000;
    if (now - sess.lastRequest > idleMs) {
      try { sess.proc.kill('SIGKILL'); } catch (_) {}
      delete hlsSessions[id];
    }
  });
}, 10000);

// ── M3U output ────────────────────────────────────────────────────────────────
app.get('/iptv.m3u', (req, res) => {
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  let m3u = `#EXTM3U x-tvg-url="${config.baseUrl}/xmltv.xml"\n\n`;
  db.channels.filter(c => c.active).sort((a,b) => a.num - b.num).forEach(ch => {
    m3u += `#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-name="${esc(ch.name)}" tvg-chno="${ch.num}" group-title="${esc(ch.group)}" tvg-logo="${esc(ch.logo)}",${esc(ch.name)}\n`;
    m3u += `${config.baseUrl}/stream/${ch.id}\n\n`;
  });
  res.send(m3u);
});

// ── XMLTV output ──────────────────────────────────────────────────────────────
app.get('/xmltv.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  const now  = Date.now();
  const to   = now + (config.epgDaysAhead || 7) * 86400000;
  const active = db.channels.filter(c => c.active);

  let xml  = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml     += `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n`;
  xml     += `<tv generator-info-name="StreamForge" generator-info-url="${config.baseUrl}">\n\n`;

  active.forEach(ch => {
    xml += `  <channel id="${esc(ch.id)}">\n`;
    xml += `    <display-name>${esc(ch.name)}</display-name>\n`;
    if (ch.logo) xml += `    <icon src="${esc(ch.logo)}" />\n`;
    xml += `  </channel>\n`;
  });
  xml += '\n';

  active.forEach(ch => {
    const programs = buildChannelSchedule(ch, now - 3600000, to);
    programs.forEach(p => {
      xml += `  <programme start="${fmtDate(p.start)}" stop="${fmtDate(p.end)}" channel="${esc(ch.id)}">\n`;
      xml += `    <title>${esc(p.title)}</title>\n`;
      if (p.desc)    xml += `    <desc>${esc(p.desc)}</desc>\n`;
      if (p.episode) xml += `    <episode-num system="xmltv_ns">${esc(p.episode)}</episode-num>\n`;
      if (p.icon)    xml += `    <icon src="${esc(p.icon)}" />\n`;
      xml += `  </programme>\n`;
    });
  });

  xml += `\n</tv>`;
  res.send(xml);
});

// ── Export / Import ───────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="streamforge-backup.json"');
  res.json({ channels: db.channels, libraries: db.libraries, media: db.media, exportedAt: new Date().toISOString() });
});

app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    const d = JSON.parse(await fsp.readFile(req.file.path, 'utf8'));
    await fsp.unlink(req.file.path).catch(() => {});
    if (d.channels)  db.channels  = d.channels;
    if (d.libraries) db.libraries = d.libraries;
    if (d.media)     db.media     = d.media;
    saveAll();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EPG Import & AI Schedule Builder ─────────────────────────────────────────

// Parse XMLTV content into channels + programs
function parseXmltvContent(xmlContent) {
  const channels = [];
  const programs = [];

  // Parse channels: <channel id="..."><display-name>...</display-name><icon src="..."/></channel>
  const chRegex = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = chRegex.exec(xmlContent)) !== null) {
    const id = m[1];
    const body = m[2];
    const nameMatch = body.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
    const iconMatch = body.match(/<icon src="([^"]+)"/);
    channels.push({
      id,
      name: nameMatch ? nameMatch[1].trim() : id,
      icon: iconMatch ? iconMatch[1] : '',
    });
  }

  // Parse programmes: handles both single-line and multi-line formats
  // e.g. <programme start="..." stop="..." channel="..."><title>X</title></programme>
  const progRegex = /<programme[^>]+start="([^"]+)"[^>]+stop="([^"]+)"[^>]+channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/g;
  while ((m = progRegex.exec(xmlContent)) !== null) {
    const [, start, stop, channel, body] = m;
    const titleMatch  = body.match(/<title[^>]*>([^<]+)<\/title>/);
    const descMatch   = body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);
    const catMatch    = body.match(/<category[^>]*>([^<]+)<\/category>/);
    const epNumMatch  = body.match(/<episode-num[^>]*>([^<]+)<\/episode-num>/);
    const iconMatch   = body.match(/<icon src="([^"]+)"/);

    // Parse XMLTV date: e.g. "20260318010000 -0800" or "20260318010000 +0000"
    const parseDate = (d) => {
      const raw = d.trim();
      const datePart = raw.slice(0, 14);
      const tzRaw   = raw.slice(14).trim(); // " -0800" etc
      const year = datePart.slice(0,4), mon = datePart.slice(4,6), day = datePart.slice(6,8);
      const h = datePart.slice(8,10), min = datePart.slice(10,12), sec = datePart.slice(12,14);
      // Build naive UTC timestamp
      const naiveMs = new Date(`${year}-${mon}-${day}T${h}:${min}:${sec}Z`).getTime();
      // Apply timezone offset to get true UTC
      if (tzRaw) {
        const sign   = tzRaw.includes('-') ? -1 : 1;
        const digits = tzRaw.replace(/[^0-9]/g, '');
        const tzH    = parseInt(digits.slice(0,2)) || 0;
        const tzM    = parseInt(digits.slice(2,4)) || 0;
        return naiveMs - sign * (tzH * 60 + tzM) * 60 * 1000;
      }
      return naiveMs;
    };

    programs.push({
      channel,
      start:    parseDate(start),
      stop:     parseDate(stop),
      title:    titleMatch  ? titleMatch[1].trim()  : 'Unknown',
      desc:     descMatch   ? descMatch[1].trim().replace(/<[^>]+>/g, '') : '',
      category: catMatch    ? catMatch[1].trim()    : '',
      episode:  epNumMatch  ? epNumMatch[1].trim()  : '',
      icon:     iconMatch   ? iconMatch[1]           : '',
    });
  }

  return { channels, programs };
}

// GET current EPG data
app.get('/api/epg', (req, res) => {
  res.json({
    importedAt: db.epg.importedAt,
    sourceName: db.epg.sourceName,
    channelCount: db.epg.channels.length,
    programCount: db.epg.programs.length,
    channels: db.epg.channels,
  });
});

// GET programs for a specific EPG channel
app.get('/api/epg/programs', (req, res) => {
  const { channelId, date } = req.query;
  let programs = [...db.epg.programs];

  if (channelId) programs = programs.filter(p => p.channel === channelId);

  if (date) {
    const from = new Date(date + 'T00:00:00Z').getTime();
    const to   = from + 86400000;
    programs = programs.filter(p => p.stop > from && p.start < to);
  }

  programs.sort((a, b) => a.start - b.start);
  res.json(programs.slice(0, parseInt(req.query.limit) || 200));
});

// POST import XMLTV from URL or body
app.post('/api/epg/import', uploadEpg.single('file'), async (req, res) => {
  try {
    let xmlContent = '';
    let sourceName = '';

    if (req.file) {
      // File upload
      xmlContent = await fsp.readFile(req.file.path, 'utf8');
      sourceName = req.file.originalname || 'Uploaded file';
      await fsp.unlink(req.file.path).catch(() => {});
    } else if (req.body.url) {
      // Fetch from URL
      sourceName = req.body.url;
      const r = await fetch(req.body.url, { timeout: 30000 });
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching EPG URL`);
      xmlContent = await r.text();
    } else if (req.body.xml) {
      xmlContent = req.body.xml;
      sourceName = req.body.sourceName || 'Pasted XML';
    } else {
      return res.status(400).json({ error: 'Provide url, xml, or upload a file' });
    }

    const { channels, programs } = parseXmltvContent(xmlContent);
    if (!channels.length && !programs.length) {
      return res.status(400).json({ error: 'No channels or programs found — is this valid XMLTV?' });
    }

    db.epg = { channels, programs, importedAt: new Date().toISOString(), sourceName };
    saveAll();

    res.json({
      ok: true,
      channelCount: channels.length,
      programCount: programs.length,
      sourceName,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE / clear EPG
app.delete('/api/epg', (req, res) => {
  db.epg = { channels: [], programs: [], importedAt: null, sourceName: '' };
  saveAll();
  res.json({ ok: true });
});

// POST AI schedule builder — uses Claude to match EPG to media library
app.post('/api/ai/build-schedule', async (req, res) => {
  const { channelId, date, userPrompt, targetChannelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });

  // Get EPG programs for the requested channel/date
  let programs = db.epg.programs.filter(p => p.channel === channelId);
  if (date) {
    const from = new Date(date + 'T00:00:00Z').getTime();
    const to   = from + 86400000;
    programs = programs.filter(p => p.stop > from && p.start < to);
  }
  programs.sort((a, b) => a.start - b.start);

  const epgChannel = db.epg.channels.find(c => c.id === channelId);

  // Build a deduplicated show list — group episodes by series so AI sees "Family Guy (156 eps)"
  // instead of 156 individual lines. This lets us fit a huge library in the context window.
  const showMap = new Map();
  const movieList = [];
  db.media.forEach(m => {
    if (m.type === 'movie') {
      movieList.push({ id: m.id, title: m.title, year: m.year, duration: m.duration });
    } else {
      const key = m.title || 'Unknown';
      if (!showMap.has(key)) showMap.set(key, { title: key, episodes: [], ids: [] });
      showMap.get(key).episodes.push(m);
      showMap.get(key).ids.push(m.id);
    }
  });

  // ── Fuzzy title scorer ──────────────────────────────────────────────────────
  function normTitle(t) {
    return (t || '').toLowerCase()
      .replace(/^(the|a|an) /i, '')          // strip leading articles
      .replace(/[^a-z0-9 ]/g, '')            // strip punctuation
      .replace(/\s+/g, ' ').trim();
  }
  function fuzzyScore(libTitle, epgTitle) {
    const a = normTitle(libTitle);
    const b = normTitle(epgTitle);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b) || b.includes(a)) return 90;
    // word-level overlap
    const wa = new Set(a.split(' ').filter(w => w.length > 2));
    const wb = new Set(b.split(' ').filter(w => w.length > 2));
    if (wa.size === 0 || wb.size === 0) return 0;
    const shared = [...wa].filter(w => wb.has(w)).length;
    return Math.round((shared / Math.max(wa.size, wb.size)) * 75);
  }

  // ── Pre-match shows against EPG titles ─────────────────────────────────────
  const epgTitleList = [...new Set(programs.map(p => p.title))];
  const epgTitlesNorm = new Set(epgTitleList.map(normTitle));

  // Score every show in library against every EPG title — keep score ≥ 55
  const matchedShows = new Set();
  showMap.forEach((show, title) => {
    const best = epgTitleList.reduce((max, et) => Math.max(max, fuzzyScore(title, et)), 0);
    if (best >= 55) matchedShows.add(title);
  });

  // Build compact show index — ALL shows (AI needs to know what exists)
  const showLines = [...showMap.values()]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(show => {
      const seasons  = [...new Set(show.episodes.map(e => e.season).filter(Boolean))].sort((a,b)=>a-b);
      const epCount  = show.episodes.length;
      const sampleId = show.episodes[0]?.id || '';
      const matched  = matchedShows.has(show.title) ? ' ✓MATCH' : '';
      return `- SHOW: "${show.title}" | ${epCount} ep${seasons.length ? ` | S${seasons.join(',')}` : ''} | first_id: ${sampleId}${matched}`;
    });

  // Full episode detail for matched shows so AI has real IDs to pick from
  const relevantEpisodes = [];
  showMap.forEach((show, title) => {
    if (!matchedShows.has(title)) return;
    show.episodes
      .sort((a, b) => ((a.season||0)*1000 + (a.episode||0)) - ((b.season||0)*1000 + (b.episode||0)))
      .forEach(ep => {
        relevantEpisodes.push(
          `  - [${ep.id}] S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')} ${ep.duration ? Math.round(ep.duration/60)+'min' : ''}`
        );
      });
  });

  const movieLines = movieList.slice(0, 100).map(m =>
    `- MOVIE: [${m.id}] "${m.title}" ${m.year||''} ${m.duration?Math.round(m.duration/60)+'min':''}`
  );

  const systemPrompt = `You are a TV scheduling assistant for StreamForge, an IPTV playout manager.
Your job: match media from the user's library to fill every single slot in a 24-hour EPG schedule.

CRITICAL RULES:
1. MediaId MUST be an exact UUID copied from the library — never invent one.
2. You will receive the FULL 24-hour schedule with every time slot. You MUST return a suggestion for EVERY slot — no slot can be left empty.
3. Use FUZZY matching — "Family Guy" in EPG matches "Family Guy" anywhere in library title.
4. Shows marked ✓MATCH are strong candidates — prioritise them for their matching slots.
5. If a show has EPISODE DETAILS listed, use those specific IDs.
6. For each EPG slot, find the best library match. If no title match exists, pick any appropriate library show as filler for that slot.
7. Follow EPG frequency exactly — if a show appears 3 times in the schedule, fill those 3 slots. Do not add extra slots.
8. Use the same filler show consistently for the same recurring unmatched title.
9. Do not place the same filler show back to back — vary it.
10. Return one suggestion per EPG slot in order.

Return ONLY valid JSON, no markdown:
{
  "reasoning": "brief strategy",
  "suggestions": [
    { "mediaId": "exact-uuid", "title": "title", "reason": "why it matches" }
  ],
  "unmatchedSlots": ["EPG titles with no library match that used filler"]
}`;

  // Build full 24h slot list with occurrence counts
  const slotCounts = {};
  programs.forEach(p => { slotCounts[p.title] = (slotCounts[p.title] || 0) + 1; });
  const fullSchedule = programs.map(p => {
    const t = new Date(p.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
    const dur = p.stop && p.start ? Math.round((p.stop - p.start) / 60000) + 'min' : '';
    return `  ${t} [${dur}] "${p.title}"`;
  }).join('\n');

  const userMessage = `EPG Channel: ${epgChannel?.name || channelId}
Date: ${date || 'today'}

FULL 24-HOUR EPG SCHEDULE (${programs.length} slots — fill ALL of these):
${fullSchedule}

LIBRARY — TV Shows (${showMap.size} series total — shows marked ✓MATCH are fuzzy-matched to EPG):
${showLines.join('\n')}

${relevantEpisodes.length ? `EPISODE DETAILS (use these exact IDs for ✓MATCH shows):\n${relevantEpisodes.join('\n')}` : ''}

LIBRARY — Movies (${movieList.length} total):
${movieLines.join('\n')}

User request: ${userPrompt || `Match my library to ${epgChannel?.name || 'the channel'}'s schedule as closely as possible`}

Return JSON only.`;

  try {
    let text = '';
    const provider = config.aiProvider || 'anthropic';

    // Helper: call an OpenAI-compatible /chat/completions endpoint
    async function callOpenAICompat(baseUrl, apiKey, model) {
      const url = baseUrl.replace(/\/+$/, '');
      const r = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || 'none'}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
          temperature: 0.3,
          max_tokens: 4096,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
      return d.choices?.[0]?.message?.content || '';
    }

    if (provider === 'anthropic') {
      const key = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
      if (!key) return res.status(400).json({ error: 'No Anthropic API key set. Go to Settings → AI.' });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Anthropic error');
      text = d.content?.[0]?.text || '';

    } else if (provider === 'openai') {
      const key = config.openaiApiKey || '';
      if (!key) return res.status(400).json({ error: 'No OpenAI API key set. Go to Settings → AI.' });
      text = await callOpenAICompat('https://api.openai.com/v1', key, config.openaiModel || 'gpt-4o');

    } else if (provider === 'openwebui') {
      const url = config.openwebUIUrl || 'http://localhost:3000/api/v1';
      const key = config.openwebUIKey || 'none';
      const model = config.openwebUIModel || '';
      if (!model) return res.status(400).json({ error: 'No model selected for Open WebUI. Go to Settings → AI.' });
      text = await callOpenAICompat(url, key, model);

    } else if (provider === 'ollama') {
      const url = config.ollamaUrl || 'http://localhost:11434/v1';
      const model = config.ollamaModel || 'llama3.2';
      text = await callOpenAICompat(url, 'ollama', model);

    } else if (provider === 'custom') {
      const url = config.customAiUrl || '';
      if (!url) return res.status(400).json({ error: 'No custom AI URL set. Go to Settings → AI.' });
      text = await callOpenAICompat(url, config.customAiKey || '', config.customAiModel || 'default');

    } else {
      return res.status(400).json({ error: `Unknown AI provider: ${provider}` });
    }
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (_) {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: text.slice(0, 500) });
    }

    // Resolve media items from IDs
    const suggestions = (parsed.suggestions || []).map(s => ({
      ...s,
      item: db.media.find(m => m.id === s.mediaId) || null,
    })).filter(s => s.item);

    res.json({
      ok: true,
      reasoning: parsed.reasoning,
      suggestions,
      unmatchedSlots: parsed.unmatchedSlots || [],
      epgChannel: epgChannel?.name,
      programCount: programs.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List available models — provider-aware
app.get('/api/ai/models', async (req, res) => {
  // Allow override via query param for the settings UI fetch button
  const provider = req.query.provider || config.aiProvider || 'anthropic';
  const urlParam  = req.query.url;
  const keyParam  = req.query.key;

  // Anthropic & OpenAI have fixed model lists — return curated options
  if (provider === 'anthropic') {
    return res.json({ models: [
      { id: 'claude-opus-4-5',     name: 'Claude Opus 4.5 (most capable)' },
      { id: 'claude-sonnet-4-5',   name: 'Claude Sonnet 4.5 (recommended)' },
      { id: 'claude-haiku-4-5',    name: 'Claude Haiku 4.5 (fastest)' },
    ]});
  }
  if (provider === 'openai') {
    return res.json({ models: [
      { id: 'gpt-4o',         name: 'GPT-4o (recommended)' },
      { id: 'gpt-4o-mini',    name: 'GPT-4o Mini (faster/cheaper)' },
      { id: 'gpt-4-turbo',    name: 'GPT-4 Turbo' },
      { id: 'gpt-3.5-turbo',  name: 'GPT-3.5 Turbo (cheapest)' },
    ]});
  }

  // For openwebui / ollama / custom — fetch live model list
  let baseUrl, apiKey;
  if (provider === 'openwebui') {
    baseUrl = urlParam || config.openwebUIUrl || 'http://localhost:3000/api/v1';
    apiKey  = keyParam || config.openwebUIKey || 'none';
  } else if (provider === 'ollama') {
    baseUrl = urlParam || config.ollamaUrl || 'http://localhost:11434/v1';
    apiKey  = 'ollama';
  } else {
    baseUrl = urlParam || config.customAiUrl || '';
    apiKey  = keyParam || config.customAiKey || 'none';
  }
  if (!baseUrl) return res.status(400).json({ error: 'No URL configured', models: [] });

  try {
    const url = baseUrl.replace(/\/+$/, '');
    const r = await fetch(`${url}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 8000,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const models = (data.data || data.models || []).map(m => ({
      id: m.id || m.name || String(m),
      name: m.name || m.id || String(m),
    }));
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message, models: [] });
  }
});

// ── Schedules Direct auto-refresh ────────────────────────────────────────────
async function schedulesDirectRefresh() {
  if (!config.sdAutoUpdate || !config.sdUsername || !config.sdPassword || !config.sdLineupId) return;
  const SD_BASE = 'https://json.schedulesdirect.org/20141201';
  try {
    const crypto = require('crypto');
    const sha1pwd = crypto.createHash('sha1').update(config.sdPassword).digest('hex');
    const tokenRes = await fetch(`${SD_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.sdUsername, password: sha1pwd })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) throw new Error(tokenData.message || 'SD login failed');
    const token = tokenData.token;
    const headers = { 'Content-Type': 'application/json', token };

    const lineupRes = await fetch(`${SD_BASE}/lineups/${config.sdLineupId}`, { headers });
    const lineupData = await lineupRes.json();
    const stationIds = (lineupData.stations || []).map(s => s.stationID);
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() + i);
      return d.toISOString().split('T')[0];
    });

    const schedRes = await fetch(`${SD_BASE}/schedules`, {
      method: 'POST', headers,
      body: JSON.stringify(stationIds.map(id => ({ stationID: id, date: dates })))
    });
    const schedules = await schedRes.json();

    const programIds = [...new Set(schedules.flatMap(s => (s.programs || []).map(p => p.programID)))];
    const progMap = {};
    for (let i = 0; i < programIds.length; i += 500) {
      const bRes = await fetch(`${SD_BASE}/programs`, {
        method: 'POST', headers, body: JSON.stringify(programIds.slice(i, i + 500))
      });
      const batch = await bRes.json();
      batch.forEach(p => { progMap[p.programID] = p; });
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
    for (const st of (lineupData.stations || [])) {
      xml += `  <channel id="${st.stationID}"><display-name>${(st.name||st.callsign||st.stationID).replace(/&/g,'&amp;')}</display-name></channel>\n`;
    }
    for (const sched of schedules) {
      for (const p of (sched.programs || [])) {
        const prog = progMap[p.programID] || {};
        const title = (prog.titles || [])[0]?.title120 || p.programID;
        const desc = (prog.descriptions?.description1000 || [{}])[0]?.description || '';
        const start = p.airDateTime?.replace(/[-:]/g,'').replace('T','').replace('Z',' +0000') || '';
        const dur = p.duration || 0;
        const end = (() => { const d = new Date(p.airDateTime); d.setSeconds(d.getSeconds()+dur); return d.toISOString().replace(/[-:]/g,'').replace('T','').replace('.000Z',' +0000'); })();
        const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        xml += `  <programme start="${esc(start)}" stop="${esc(end)}" channel="${esc(sched.stationID)}"><title>${esc(title)}</title>${desc?`<desc>${esc(desc)}</desc>`:''}</programme>\n`;
      }
    }
    xml += '</tv>';

    const parsed = parseXmltvContent(xml);
    db.epg = { ...parsed, importedAt: new Date().toISOString(), sourceName: `Schedules Direct: ${config.sdLineupId}` };
    saveAll();
    console.log(`[sd-refresh] Updated EPG: ${parsed.programs.length} programs`);
  } catch (e) {
    console.error('[sd-refresh] Failed:', e.message);
  }
}

// Run SD refresh on startup + every 24h
schedulesDirectRefresh();
setInterval(schedulesDirectRefresh, 24 * 60 * 60 * 1000);

// ── Live Streams ──────────────────────────────────────────────────────────────
app.get('/api/streams', (req, res) => res.json(db.streams));

app.post('/api/streams', (req, res) => {
  const { name, url, group, icon } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const stream = { id: uuidv4(), name, url, group: group||'', icon: icon||'', createdAt: new Date().toISOString() };
  db.streams.push(stream);
  saveAll();
  res.json(stream);
});

app.put('/api/streams/:id', (req, res) => {
  const s = db.streams.find(s => s.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { name, url, group, icon } = req.body;
  if (name) s.name = name;
  if (url)  s.url  = url;
  if (group !== undefined) s.group = group;
  if (icon  !== undefined) s.icon  = icon;
  saveAll();
  res.json(s);
});

app.delete('/api/streams/:id', (req, res) => {
  db.streams = db.streams.filter(s => s.id !== req.params.id);
  saveAll();
  res.json({ ok: true });
});

// ── Schedules Direct proxy ────────────────────────────────────────────────────
const SD_BASE = 'https://json.schedulesdirect.org/20141201';
const crypto  = require('crypto');

app.post('/api/sd/token', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const sha1pwd = crypto.createHash('sha1').update(password).digest('hex');
    const r = await fetch(`${SD_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: sha1pwd })
    });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sd/lineups', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const r = await fetch(`${SD_BASE}/lineups`, { headers: { token } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search available lineups by zip/postal code
app.get('/api/sd/headends', async (req, res) => {
  try {
    const { token, country, postalcode } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const r = await fetch(`${SD_BASE}/headends?country=${country||'USA'}&postalcode=${postalcode}`, { headers: { token } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a lineup to SD-JSON account
app.put('/api/sd/lineups/:id', async (req, res) => {
  try {
    const { token } = req.query;
    const r = await fetch(`${SD_BASE}/lineups/${req.params.id}`, { method: 'PUT', headers: { token } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sd/lineups/:id', async (req, res) => {
  try {
    const { token } = req.query;
    const r = await fetch(`${SD_BASE}/lineups/${req.params.id}`, { headers: { token } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sd/schedules', async (req, res) => {
  try {
    const { token } = req.query;
    const r = await fetch(`${SD_BASE}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sd/programs', async (req, res) => {
  try {
    const { token } = req.query;
    const r = await fetch(`${SD_BASE}/programs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(config.port) || 8080;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[streamforge] v2 running on port ${PORT}`);
  console.log(`[streamforge] ffmpeg: ${config.ffmpegPath}`);
  console.log(`[streamforge] data:   ${config.dataDir}`);
});

process.on('SIGTERM', () => { saveAll(); process.exit(0); });
process.on('SIGINT',  () => { saveAll(); process.exit(0); });
