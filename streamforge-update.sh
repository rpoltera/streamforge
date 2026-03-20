#!/bin/bash
# StreamForge Emergency Fix - run directly on container
set -e
echo "Applying fixes..."

pkill -9 -f ffmpeg 2>/dev/null || true
systemctl stop streamforge 2>/dev/null || true

# Fix 1: Spawn guard - prevent duplicate FFmpeg processes
node -e "
const fs = require('fs');
const file = '/opt/streamforge/server/index.js';
let s = fs.readFileSync(file, 'utf8');

// Replace entire startHlsSession opening with clean version
const funcStart = s.indexOf('function startHlsSession(ch) {');
const hlsDirPos = s.indexOf('  const hlsDir = getHlsDir(channelId);', funcStart);

const cleanGuard = 'function startHlsSession(ch) {\n' +
  '  const channelId = ch.id;\n' +
  '  // Kill any existing session first\n' +
  '  if (hlsSessions[channelId]) {\n' +
  '    try { hlsSessions[channelId].proc.kill(\"SIGKILL\"); } catch (_) {}\n' +
  '    delete hlsSessions[channelId];\n' +
  '  }\n\n  ';

s = s.slice(0, funcStart) + cleanGuard + s.slice(hlsDirPos);
fs.writeFileSync(file, s);
console.log('Fix 1: spawn guard OK');
"

# Fix 2: POST /watch - don't restart if session is healthy
node -e "
const fs = require('fs');
const file = '/opt/streamforge/server/index.js';
let s = fs.readFileSync(file, 'utf8');

const oldWatch = \"app.post('/api/channels/:id/watch', (req, res) => {\\n  const ch = db.channels.find(c => c.id === req.params.id);\\n  if (!ch) return res.status(404).json({ error: 'not found' });\\n  const session = startHlsSession(ch);\\n  if (!session) return res.status(404).json({ error: 'Nothing scheduled' });\\n  res.json({ ok: true, hlsUrl: \\\`/hls/\\\${ch.id}/index.m3u8\\\` });\\n});\";

const newWatch = \"app.post('/api/channels/:id/watch', (req, res) => {\\n  const ch = db.channels.find(c => c.id === req.params.id);\\n  if (!ch) return res.status(404).json({ error: 'not found' });\\n  const alive = hlsSessions[req.params.id];\\n  if (alive && alive.proc && alive.proc.exitCode === null) {\\n    alive.lastRequest = Date.now();\\n    return res.json({ ok: true, hlsUrl: \\\`/hls/\\\${ch.id}/index.m3u8\\\` });\\n  }\\n  const session = startHlsSession(ch);\\n  if (!session) return res.status(404).json({ error: 'Nothing scheduled' });\\n  res.json({ ok: true, hlsUrl: \\\`/hls/\\\${ch.id}/index.m3u8\\\` });\";

if (s.includes(oldWatch.slice(0, 60))) {
  s = s.replace(oldWatch, newWatch + '\n});');
  console.log('Fix 2: POST /watch guard OK');
} else {
  console.log('Fix 2: already applied or different format, skipping');
}
fs.writeFileSync(file, s);
"

# Fix 3: Auto-transcode HEVC/10-bit to h264_nvenc
node -e "
const fs = require('fs');
const file = '/opt/streamforge/server/index.js';
let s = fs.readFileSync(file, 'utf8');

// Add probeVideoCodec after VIDEO_EXTS if not already there
if (!s.includes('probeVideoCodec')) {
  s = s.replace(
    \"const VIDEO_EXTS = new Set\",
    \"// Probe source codec to decide copy vs transcode\nfunction probeVideoCodec(srcPath) {\n  try {\n    const { execSync: ex } = require('child_process');\n    const out = ex(\\\`\\\\\\\"\\\${config.ffprobePath}\\\\\\\" -v quiet -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of csv=p=0 \\\\\\\"\\\${srcPath}\\\\\\\"\\\`, { timeout: 8000 }).toString().trim();\n    const [codec, pix] = out.split(',');\n    const needs = codec === 'hevc' || codec === 'av1' || (pix && (pix.includes('10') || pix.includes('12')));\n    return { codec, pix, needs };\n  } catch(_) { return { codec: 'h264', pix: 'yuv420p', needs: false }; }\n}\n\nconst VIDEO_EXTS = new Set\"
  );
  console.log('Fix 3a: probeVideoCodec added');
}

// Auto-transcode in buildFfmpegArgs
if (!s.includes('effectiveVCodec')) {
  s = s.replace(
    \"  if (vCodec === 'copy') {\\n    args.push('-vcodec', 'copy');\",
    \"  let effectiveVCodec = vCodec;\\n  if (vCodec === 'copy' && src) {\\n    const probe = probeVideoCodec(src.value);\\n    if (probe.needs) {\\n      console.log('[sf] Auto-transcode: ' + probe.codec + ' ' + probe.pix + ' -> h264_nvenc');\\n      effectiveVCodec = 'h264';\\n    }\\n  }\\n  if (effectiveVCodec === 'copy') {\\n    args.push('-vcodec', 'copy');\"
  );
  s = s.replace(\"vCodec === 'hevc' ? 'hevc_nvenc'\", \"effectiveVCodec === 'hevc' ? 'hevc_nvenc'\");
  s = s.replace(\"vCodec === 'hevc' ? 'hevc_vaapi'\", \"effectiveVCodec === 'hevc' ? 'hevc_vaapi'\");
  s = s.replace(\"vCodec === 'hevc' ? 'libx265'\", \"effectiveVCodec === 'hevc' ? 'libx265'\");
  console.log('Fix 3b: auto-transcode logic added');
}
fs.writeFileSync(file, s);
"

# Fix 4: Audio - unmuted by default
sed -i 's/video\.muted = true;/video.muted = false; video.volume = 1;/g' /opt/streamforge/public/js/app.js
echo "Fix 4: audio unmuted by default"

# Verify syntax
node --check /opt/streamforge/server/index.js && echo "Syntax OK" || echo "SYNTAX ERROR - check manually"

systemctl start streamforge
sleep 2
systemctl is-active streamforge && echo "StreamForge running OK" || echo "FAILED TO START"
