#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');

// Global State
const wsClients = new Set();
const ipcClients = new Map(); // shotId -> net.Socket

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
  } else if (reqUrl.startsWith('/files')) {
    // Support both /files/<path> and /files?path=<encodedPath>
    const parsedUrl = new URL(reqUrl, 'http://127.0.0.1:9700');
    let filePath;
    if (parsedUrl.searchParams.has('path')) {
      filePath = parsedUrl.searchParams.get('path');
    } else {
      const rawPath = reqUrl.substring('/files/'.length);
      filePath = decodeURIComponent(rawPath);
    }
    
    // Normalize Windows path: strip leading slash if drive letter
    if (filePath.startsWith('/') && filePath.length > 2 && filePath[2] === ':') {
      filePath = filePath.substring(1);
    }
    
    const absPath = path.resolve(filePath);

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

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleWsMessage(ws, data);
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
  } else if (mtype === 'ASSET_SAVED') {
    const shotId = data.shotId;
    const paths = data.paths || [];
    const base64Data = data.base64Data;
    console.log(`Job ${shotId} completed, handling asset saving...`);

    if (base64Data) {
      const taskDir = findTaskDir(shotId, WORKSPACE_ROOT);
      if (taskDir) {
        try {
          const base64Raw = base64Data.split(',')[1];
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
            imageUrl: localHttpUrl
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

    const taskDir = findTaskDir(shotId, WORKSPACE_ROOT);
    if (taskDir) {
      const ext = path.extname(fileName).toLowerCase() || '.png';
      const savePath = getNextIncrementalPath(taskDir, shotId, ext);
      
      const base64Data = dataUrl.split(',')[1];
      fs.writeFileSync(savePath, Buffer.from(base64Data, 'base64'));
      console.log(`Saved incremental result (renamed): ${savePath}`);
      
      broadcast({
        type: 'INCREMENTAL_SAVED',
        shotId: shotId,
        path: savePath
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
  const socket = ipcClients.get(shotId);
  if (socket) {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      console.error(`Error writing to IPC client for ${shotId}:`, err);
    } finally {
      try { socket.end(); } catch {}
      ipcClients.delete(shotId);
    }
  }
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
    ipcClients.set(shotId, socket);

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

    // ACK immediately
    socket.write(JSON.stringify({
      type: 'ack',
      status: 'synced',
      count: jobs.length
    }) + '\n');
    socket.end();

    // Forward full batch to side panel (replaces old queue)
    broadcast({
      type: 'SYNC_QUEUE',
      jobs: jobs.map(j => ({
        id: j.shotId,
        prompt: j.prompt || '',
        reference_files: j.referenceFiles || [],
        watermark_removal: j.watermarkRemoval !== false
      }))
    });
  }
}
