/**
 * StreamFusion Server
 * ------------------
 * Receives a live video stream from the browser via WebSocket,
 * pipes it into FFmpeg, and forwards to multiple RTMP destinations
 * (TikTok, YouTube, Facebook) simultaneously.
 *
 * Handles: graceful shutdown, reconnection, per-platform status,
 * heartbeat keepalive, and clean FFmpeg process management.
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check — Railway and monitoring tools use this
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    streaming: !!currentFFmpeg,
    uptime: process.uptime(),
    duration: streamStartTime ? Math.floor((Date.now() - streamStartTime) / 1000) : 0
  });
});

const server = http.createServer(app);

// ─── State ────────────────────────────────────────────────────────────────────

let currentFFmpeg   = null;   // Active FFmpeg child process
let currentWs       = null;   // Active WebSocket client
let streamStartTime = null;   // When the stream began (ms timestamp)
let ffmpegReady     = false;  // True after FFmpeg has started accepting input
let writeBuffer     = [];     // Holds chunks that arrive before FFmpeg is ready

// ─── FFmpeg Argument Builder ──────────────────────────────────────────────────

/**
 * Builds the FFmpeg argument list for multi-destination RTMP streaming.
 *
 * Uses the "tee" muxer so video is encoded ONCE and sent to N destinations
 * — this is far more efficient than running a separate FFmpeg per platform.
 *
 * Input: WebM stream from browser MediaRecorder (VP8/VP9 or H264)
 * Output: H264/AAC over RTMP/FLV to each platform
 */
function buildFFmpegArgs(destinations) {
  // Filter out any destination that doesn't have both url and key
  const valid = destinations.filter(d => d.url && d.key);

  if (valid.length === 0) {
    throw new Error('No valid destinations.');
  }

  // Build tee output string: "[f=flv]rtmp://url/key|[f=flv]rtmp://url/key"
  const teeString = valid
    .map(d => `[f=flv]${d.url.replace(/\/$/, '')}/${d.key}`)
    .join('|');

  return [
    // Input: read from stdin, tell FFmpeg it's a webm stream
    '-f',             'webm',
    '-fflags',        'nobuffer',         // Reduce input buffering for lower latency
    '-probesize',     '32',               // Probe just 32 bytes — we know it's webm
    '-analyzeduration', '0',             // Skip analysis delay
    '-i',             'pipe:0',           // Read from stdin

    // Video: transcode to H264 (required by all RTMP platforms)
    '-c:v',           'libx264',
    '-preset',        'veryfast',         // Fastest encode — acceptable quality for live
    '-tune',          'zerolatency',      // Minimize encoder latency
    '-b:v',           '1000k',            // 2.5 Mbps video bitrate
    '-maxrate',       '1000k',
    '-bufsize',       '2000k',
    '-pix_fmt',       'yuv420p',          // Required by TikTok and most platforms
    '-g',             '60',              // Keyframe every 60 frames (2s at 30fps)
    '-keyint_min',    '60',

    // Audio: transcode to AAC (required by all RTMP platforms)
    '-c:a',           'aac',
    '-b:a',           '128k',
    '-ar',            '44100',
    '-ac',            '2',               // Stereo

    // Map both streams to output
    '-map',           '0:v',
    '-map',           '0:a',

    // Output: tee muxer sends to all platforms at once
    '-f',             'tee',
    teeString
  ];
}

// ─── Stream Management ────────────────────────────────────────────────────────

function startStream(ws, destinations) {
  if (currentFFmpeg) {
    sendTo(ws, { type: 'error', message: 'A stream is already active. Stop it first.' });
    return;
  }

  let args;
  try {
    args = buildFFmpegArgs(destinations);
  } catch (err) {
    sendTo(ws, { type: 'error', message: err.message });
    return;
  }

  console.log('[StreamFusion] Starting FFmpeg...');

  currentFFmpeg   = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  currentWs       = ws;
  streamStartTime = Date.now();
  ffmpegReady     = false;
  writeBuffer     = [];

  // Give FFmpeg a moment to initialise before we start writing
  // (avoids "broken pipe" on the very first chunk)
  setTimeout(() => {
    ffmpegReady = true;
    // Flush any buffered chunks
    writeBuffer.forEach(chunk => safeWrite(chunk));
    writeBuffer = [];
  }, 500);

  // ── FFmpeg stderr (progress + errors) ──
  currentFFmpeg.stderr.on('data', (chunk) => {
    const line = chunk.toString();

    // Detect a fatal error from FFmpeg and relay it to the client
    if (line.toLowerCase().includes('error') && !line.includes('non monotonous')) {
      console.error('[FFmpeg]', line.trim());
    }

    // Relay live stats (fps, bitrate, etc.) to the client every second
    if (line.includes('fps=')) {
      sendTo(ws, { type: 'stats', raw: line.trim() });
    }
  });

  // ── FFmpeg process exit ──
  currentFFmpeg.on('close', (code) => {
    console.log(`[FFmpeg] Exited with code ${code}`);
    const msg = code === 0
      ? 'Stream ended.'
      : `Stream ended unexpectedly (code ${code}). Check your streaming keys and internet connection.`;

    if (currentWs && currentWs.readyState === 1 /* OPEN */) {
      sendTo(currentWs, { type: 'stopped', code, message: msg });
    }

    currentFFmpeg   = null;
    currentWs       = null;
    streamStartTime = null;
    ffmpegReady     = false;
    writeBuffer     = [];
  });

  // ── FFmpeg spawn error (e.g. FFmpeg not installed) ──
  currentFFmpeg.on('error', (err) => {
    console.error('[FFmpeg] Spawn error:', err.message);
    const message = err.code === 'ENOENT'
      ? 'FFmpeg is not installed on this server. Contact support.'
      : 'FFmpeg error: ' + err.message;
    sendTo(ws, { type: 'error', message });
    currentFFmpeg   = null;
    currentWs       = null;
    streamStartTime = null;
    ffmpegReady     = false;
    writeBuffer     = [];
  });

  sendTo(ws, {
    type: 'started',
    platforms: destinations.filter(d => d.url && d.key).map(d => d.name),
    message: `Going live on ${destinations.filter(d => d.url && d.key).map(d => d.name).join(' & ')}!`
  });
}

function stopStream(ws) {
  if (!currentFFmpeg) {
    if (ws) sendTo(ws, { type: 'stopped', code: 0, message: 'No active stream.' });
    return;
  }

  console.log('[StreamFusion] Stopping stream...');

  try {
    // Gracefully end stdin first so FFmpeg can flush its buffers
    currentFFmpeg.stdin.end();
  } catch (_) {}

  // Force-kill after 3 seconds if it hasn't exited cleanly
  const killTimer = setTimeout(() => {
    if (currentFFmpeg) {
      currentFFmpeg.kill('SIGKILL');
    }
  }, 3000);

  currentFFmpeg.once('close', () => clearTimeout(killTimer));

  // State will be cleared by the 'close' event handler above
}

// Write a chunk to FFmpeg stdin safely
function safeWrite(data) {
  if (currentFFmpeg && currentFFmpeg.stdin && !currentFFmpeg.stdin.destroyed) {
    try {
      currentFFmpeg.stdin.write(Buffer.from(data));
    } catch (err) {
      console.error('[StreamFusion] Write error:', err.message);
    }
  }
}

// Send a JSON message to a WebSocket client safely
function sendTo(ws, obj) {
  try {
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(obj));
    }
  } catch (_) {}
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[StreamFusion] Client connected');

  // ── Heartbeat: keep the connection alive (Railway closes idle WS after ~60s) ──
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {

    // ── Binary frame = video chunk from MediaRecorder ──
    if (isBinary) {
      if (ffmpegReady) {
        safeWrite(data);
      } else if (currentFFmpeg) {
        // FFmpeg started but not yet ready — buffer the chunk
        writeBuffer.push(data);
      }
      return;
    }

    // ── Text frame = JSON command ──
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.warn('[StreamFusion] Could not parse message:', data.toString().slice(0, 100));
      return;
    }

    switch (msg.type) {

      case 'start':
        startStream(ws, msg.destinations || []);
        break;

      case 'stop':
        stopStream(ws);
        break;

      // Client requesting current status (e.g. on page reload)
      case 'status':
        sendTo(ws, {
          type: 'status',
          streaming: !!currentFFmpeg,
          duration: streamStartTime ? Math.floor((Date.now() - streamStartTime) / 1000) : 0
        });
        break;

      default:
        console.warn('[StreamFusion] Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    console.log('[StreamFusion] Client disconnected');
    // If the client that disconnects is the one streaming, stop the stream
    if (currentWs === ws) {
      stopStream(null);
    }
  });

  ws.on('error', (err) => {
    console.error('[StreamFusion] WebSocket error:', err.message);
    if (currentWs === ws) {
      stopStream(null);
    }
  });
});

// Heartbeat interval — ping every 30 seconds to keep Railway connection alive
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[StreamFusion] Received ${signal}, shutting down...`);
  stopStream(null);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // Force exit after 5s
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[StreamFusion] Server ready on port ${PORT}`);
});
                        
