#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');

// Global State
const wsClients = new Set();
const ipcClients = new Map(); // shotId -> { socket, timeoutHandle }
let currentQueueDir = null; // Set by sync/generate IPC; used to resolve relative ref paths
let lastSyncPayload = null; // Replayed to sidepanel on reconnect (so refresh doesn't lose tasks)

// IPC timeout — if a task doesn't report back within this window, kill the
// waiter so the next task can be picked up. Refreshed-tab scenario needs this:
// if content.js dies mid-task, the OPSV CLI caller is blocked forever otherwise.
const IPC_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

// ── Helper: Find Task Directory ───────────────────────────────────────────
function findTaskDir(shotId, searchRoot) {
  const targetName = `${shotId}.json`;
  
  function walk(currentDir) {
    let files;
    try {
      files = fs.readdirSync(currentDir);
    } catch {
      return null;
    }
    
    if (files.includes(targetName)) {
      return currentDir;
    }
    
    for (const f of files) {
      const fullPath = path.join(currentDir, f);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      
      if (stat.isDirectory()) {
        if (f === '.git' || f === 'node_modules' || f === 'dist') {
          continue;
        }
        const found = walk(fullPath);
        if (found) return found;
      }
    }
    return null;
  }
  
  return walk(searchRoot);
}

// ── HTTP Server (Port 9700) ────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqUrl = req.url || '';

  if (reqUrl === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', wsPort: 3061 }));
  } else if (reqUrl.startsWith('/agent/cmd') && req.method === 'POST') {
    // Agent (opsv CLI / external orchestrator) posts commands here.
    // Body is JSON: { type: 'CONTINUE_BATCH' | 'DENY_BATCH' | 'STOP_BATCH_ACK' | ..., ... }
    // We broadcast it to all sidepanel WS clients so they can react.
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const cmd = JSON.parse(body);
        const mtype = cmd.type;
        if (!mtype) {
          res.writeHead(400); res.end('Missing type'); return;
        }
        // Whitelist only Agent → sidepanel commands so a random POST can't
        // trigger random sidepanel actions.
        const allowed = new Set([
          'CONTINUE_BATCH', 'DENY_BATCH', 'STOP_BATCH_ACK',
          'NEW_JOB', 'SYNC_QUEUE', 'JOB_COMPLETE',
          'GET_STATE', 'LIST_BATCHES',
        ]);
        if (!allowed.has(mtype)) {
          res.writeHead(400); res.end(`Unknown agent cmd: ${mtype}`); return;
        }
        const payload = { ...cmd, _agent: true, _ts: Date.now() };
        broadcast(payload);
        console.log(`[Agent Cmd] ${mtype} batchId=${cmd.batchId || '-'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recipients: wsClients.size }));
      } catch (err) {
        res.writeHead(400); res.end('Invalid JSON');
      }
    });
    return;
  } else if (reqUrl.startsWith('/agent/state') && req.method === 'POST') {
    // Sidepanel posts its batch/job state here for the Agent to inspect.
    // We just write to /tmp/opsv-reports/sidepanel-state.json (latest).
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const dir = '/tmp/opsv-reports';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fname = `${dir}/sidepanel-state.json`;
        fs.writeFileSync(fname, JSON.stringify(parsed.snapshot || parsed, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: fname }));
      } catch (err) {
        res.writeHead(400); res.end('Invalid JSON');
      }
    });
    return;
  } else if (reqUrl.startsWith('/files')) {
    // Support both /files/<path> and /files?path=<encodedPath>
    const parsedUrl = new URL(reqUrl, 'http://127.0.0.1:9700');
    let filePath;
    if (parsedUrl.searchParams.has('path')) {
      filePath = parsedUrl.searchParams.get('path');
    } else {
      let rawPath = reqUrl.substring('/files/'.length);
      // Strip query string if present (e.g. /files/foo.png?v=1)
      const qIdx = rawPath.indexOf('?');
      if (qIdx >= 0) rawPath = rawPath.substring(0, qIdx);
      // Collapse double slashes
      rawPath = rawPath.replace(/\/+/g, '/');
      filePath = decodeURIComponent(rawPath);
    }

    // Normalize Windows path: strip leading slash if drive letter
    if (filePath.startsWith('/') && filePath.length > 2 && filePath[2] === ':') {
      filePath = filePath.substring(1);
    }

    // Resolve: absolute paths go straight, relative paths anchor at queueDir
    let absPath;
    if (path.isAbsolute(filePath)) {
      absPath = filePath;
    } else if (currentQueueDir) {
      absPath = path.resolve(currentQueueDir, filePath);
    } else {
      absPath = path.resolve(filePath);
    }

    if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.json') contentType = 'application/json';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(absPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(9700, '127.0.0.1', () => {
  console.log('HTTP Server running on http://127.0.0.1:9700');
});

// ── WebSocket Server (Port 3061) ───────────────────────────────────────────
const wss = new WebSocketServer({ port: 3061 });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log('WebSocket sidepanel client connected.');

  // Replay last known queue so sidepanel refresh doesn't lose tasks
  if (lastSyncPayload) {
    ws.send(JSON.stringify(lastSyncPayload));
    console.log('Replayed stored queue to new sidepanel client');
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleWsMessage(ws, data);
      // Log all messages to a separate file so the Agent can tail Agent-bound
      // requests (BATCH_REQUEST_RUN / BATCH_READY / BATCH_DONE / BATCH_RETRY etc).
      try {
        const dir = '/tmp/opsv-reports';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const line = `[${new Date().toISOString()}] ${data.type || '?'} ${JSON.stringify(data).slice(0, 500)}\n`;
        fs.appendFileSync(`${dir}/agent-requests.log`, line);
      } catch {}
    } catch (err) {
      console.error('Error handling WS message:', err);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('WebSocket sidepanel client disconnected.');
  });
});

console.log('WebSocket Server running on ws://127.0.0.1:3061');

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function handleWsMessage(ws, data) {
  const mtype = data.type;

  if (mtype === 'LOG') {
    console.log(`[Extension Log]: ${data.message}`);
  } else if (mtype === 'JOB_STARTED') {
    console.log(`Job started in extension: ${data.shotId}`);
  } else if (mtype === 'OPSV_REPORT') {
    // Sidepanel finished a batch and is reporting back to opsv CLI / Agent.
    // Write to /tmp/opsv-reports/<batchId>.json so opsv CLI can tail/poll.
    try {
      const dir = '/tmp/opsv-reports';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fname = `${dir}/${data.batchId || Date.now()}.json`;
      fs.writeFileSync(fname, JSON.stringify(data, null, 2));
      console.log(`[OPSV_REPORT] Written ${fname} (${data.done?.length || 0}✓ ${data.failed?.length || 0}✗)`);
    } catch (err) {
      console.error(`[OPSV_REPORT] Write failed: ${err.message}`);
    }
  } else if (mtype === 'ASSET_SAVED') {
    const shotId = data.shotId;
    const paths = data.paths || [];
    const base64Data = data.base64Data;
    // Modification tracking — forwarded verbatim to opsv CLI for iterate logic
    const originalPrompt = data.originalPrompt || null;
    const modifiedPrompt = data.modifiedPrompt || null;
    const originalRefs = data.originalRefs || null;
    const modifiedRefs = data.modifiedRefs || null;
    console.log(`Job ${shotId} completed, handling asset saving...`);

    if (base64Data) {
      // Robust base64 extraction: handle both raw and data URL formats
      let base64Raw;
      if (base64Data.includes(',')) {
        base64Raw = base64Data.split(',').pop();
      } else {
        base64Raw = base64Data;
      }

      if (!base64Raw || base64Raw === 'undefined') {
        console.error(`Invalid base64 data for ${shotId}, skipping save.`);
        sendToIpcClient(shotId, {
          type: 'task_result',
          status: 'failed',
          error: 'Invalid base64 data from extension',
        });
        return;
      }

      const taskDir = findTaskDir(shotId, WORKSPACE_ROOT);
      if (taskDir) {
        try {
          const tempFileName = `generated_temp_${shotId}.png`;
          const savePath = path.join(taskDir, tempFileName);
          fs.writeFileSync(savePath, Buffer.from(base64Raw, 'base64'));
          console.log(`Saved generated asset locally to: ${savePath}`);

          let safePath = savePath.replace(/\\/g, '/');
          // Use query param to avoid double-slash normalization issues
          const localHttpUrl = `http://127.0.0.1:9700/files?path=${encodeURIComponent(safePath)}`;

          sendToIpcClient(shotId, {
            type: 'task_result',
            status: 'completed',
            imageUrl: localHttpUrl,
            originalPrompt,
            modifiedPrompt,
            originalRefs,
            modifiedRefs,
          });

          broadcast({
            type: 'FINAL_ASSET_SAVED',
            shotId: shotId,
            path: localHttpUrl
          });
        } catch (err) {
          console.error('Error saving generated asset Base64:', err);
          sendToIpcClient(shotId, {
            type: 'task_result',
            status: 'completed',
            imageUrl: paths[0] || null
          });
        }
      } else {
        console.error(`Could not locate task directory for ${shotId} to save generated asset.`);
        sendToIpcClient(shotId, {
          type: 'task_result',
          status: 'completed',
          imageUrl: paths[0] || null
        });
      }
    } else {
      sendToIpcClient(shotId, {
        type: 'task_result',
        status: 'completed',
        imageUrl: paths[0] || null
      });
    }
  } else if (mtype === 'JOB_FAILED') {
    const shotId = data.shotId;
    const error = data.error || 'Unknown error';
    console.log(`Job ${shotId} failed: ${error}`);
    sendToIpcClient(shotId, {
      type: 'task_result',
      status: 'failed',
      error: error
    });
  } else if (mtype === 'INCREMENTAL_RESULT') {
    const shotId = data.shotId;
    const fileName = data.fileName;
    const dataUrl = data.dataUrl;
    const originalPrompt = data.originalPrompt || null;
    const modifiedPrompt = data.modifiedPrompt || null;
    const originalRefs = data.originalRefs || null;
    const modifiedRefs = data.modifiedRefs || null;

    const taskDir = findTaskDir(shotId, WORKSPACE_ROOT);
    if (taskDir) {
      const ext = path.extname(fileName).toLowerCase() || '.png';
      const savePath = getNextIncrementalPath(taskDir, shotId, ext);

      // Robust base64 extraction
      let base64Raw;
      if (dataUrl && dataUrl.includes(',')) {
        base64Raw = dataUrl.split(',').pop();
      } else {
        base64Raw = dataUrl;
      }

      if (!base64Raw || base64Raw === 'undefined') {
        console.error(`Invalid dataUrl for incremental ${shotId}`);
        return;
      }

      fs.writeFileSync(savePath, Buffer.from(base64Raw, 'base64'));
      console.log(`Saved incremental result (renamed): ${savePath}`);

      broadcast({
        type: 'INCREMENTAL_SAVED',
        shotId: shotId,
        path: savePath
      });

      // Notify the original IPC caller if any (manual drop happens when CLI is waiting)
      sendToIpcClient(shotId, {
        type: 'incremental_result',
        status: 'completed',
        path: savePath,
        originalPrompt,
        modifiedPrompt,
        originalRefs,
        modifiedRefs,
      });
    } else {
      console.error(`Could not locate task directory for ${shotId} to save incremental result.`);
    }
  }
}

function getNextIncrementalPath(taskDir, shotId, ext) {
  let files = [];
  try {
    files = fs.readdirSync(taskDir);
  } catch {
    return path.join(taskDir, `${shotId}_1${ext}`);
  }

  const escapedShotId = shotId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedShotId}_(\\d+)${escapedExt}$`, 'i');
  
  let maxIdx = 0;
  for (const f of files) {
    const match = f.match(pattern);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) {
        maxIdx = idx;
      }
    }
  }

  return path.join(taskDir, `${shotId}_${maxIdx + 1}${ext}`);
}

// ── IPC Socket Server (UNIX Socket / Named Pipe) ───────────────────────────
const ipcSocketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\tmp\\opsv-gemini.sock'
  : '/tmp/opsv-gemini.sock';

if (process.platform !== 'win32' && fs.existsSync(ipcSocketPath)) {
  try { fs.unlinkSync(ipcSocketPath); } catch {}
}

const ipcServer = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const cmd = JSON.parse(line.trim());
        handleIpcCommand(socket, cmd);
      } catch (err) {
        console.error('IPC parse error:', err);
      }
    }
  });

  socket.on('error', (err) => {
    // Suppress common connection closed/broken pipe warnings
  });
});

ipcServer.listen(ipcSocketPath, () => {
  console.log(`IPC Server running on ${ipcSocketPath}`);
});

function sendToIpcClient(shotId, response) {
  const entry = ipcClients.get(shotId);
  if (entry) {
    try {
      entry.socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      console.error(`Error writing to IPC client for ${shotId}:`, err);
    } finally {
      clearIpcClient(shotId);
    }
  }
}

function clearIpcClient(shotId) {
  const entry = ipcClients.get(shotId);
  if (!entry) return;
  if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
  try { entry.socket.end(); } catch {}
  ipcClients.delete(shotId);
}

function handleIpcCommand(socket, cmd) {
  const ctype = cmd.type;

  if (ctype === 'ping') {
    socket.write(JSON.stringify({
      type: 'pong',
      cmd_id: cmd.cmd_id,
      extension_connected: wsClients.size > 0
    }) + '\n');
    socket.end();
  } else if (ctype === 'status') {
    socket.write(JSON.stringify({
      type: 'status_response',
      cmd_id: cmd.cmd_id,
      status: wsClients.size > 0 ? 'ready' : 'waiting_for_extension'
    }) + '\n');
    socket.end();
  } else if (ctype === 'generate') {
    const shotId = cmd.shotId;
    console.log(`[IPC Server]: Received generate task for: ${shotId}`);
    // If there's already a waiter for this shotId, kill it (re-issue).
    if (ipcClients.has(shotId)) {
      console.log(`[IPC Server]: Replacing existing IPC waiter for ${shotId}`);
      clearIpcClient(shotId);
    }
    const timeoutHandle = setTimeout(() => {
      const entry = ipcClients.get(shotId);
      if (!entry) return;
      console.log(`[IPC Server]: Timeout for ${shotId} after ${IPC_TIMEOUT_MS}ms — sending failure and closing`);
      try {
        entry.socket.write(JSON.stringify({
          type: 'task_result',
          status: 'failed',
          error: `IPC timeout after ${IPC_TIMEOUT_MS / 1000}s — likely tab refresh or content-script crash`,
        }) + '\n');
      } catch {}
      clearIpcClient(shotId);
    }, IPC_TIMEOUT_MS);
    ipcClients.set(shotId, { socket, timeoutHandle });

    // ACK the client immediately
    socket.write(JSON.stringify({
      type: 'ack',
      status: 'dispatched'
    }) + '\n');

    // Forward to side panel
    broadcast({
      type: 'NEW_JOB',
      job: {
        id: shotId,
        prompt: cmd.prompt,
        reference_files: cmd.referenceFiles || [],
        watermark_removal: cmd.watermarkRemoval !== false
      }
    });
  } else if (ctype === 'sync') {
    const jobs = cmd.jobs || [];
    console.log(`[IPC Server]: Received sync with ${jobs.length} task(s)`);
    if (cmd.queueDir) currentQueueDir = cmd.queueDir;
    else if (jobs[0]?.queueDir) currentQueueDir = jobs[0].queueDir;

    // ACK immediately
    socket.write(JSON.stringify({
      type: 'ack',
      status: 'synced',
      count: jobs.length
    }) + '\n');
    socket.end();

    // Forward full batch to side panel (replaces old queue)
    const syncMsg = {
      type: 'SYNC_QUEUE',
      jobs: jobs.map(j => ({
        id: j.id || j.shotId,
        prompt: j.prompt || '',
        reference_files: j.refs || j.referenceFiles || [],
        watermark_removal: j.watermarkRemoval !== false
      }))
    };
    lastSyncPayload = syncMsg;
    broadcast(syncMsg);
  }
}
