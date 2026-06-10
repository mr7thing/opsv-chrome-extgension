// OPSV Sidepanel — Daemon-bridged job queue with Auto/Manual scheduling
// ============================================================================

const DAEMON_WS_DEFAULT = 'ws://127.0.0.1:3061';
const DAEMON_HTTP = 'http://127.0.0.1:9700';

let ws = null;
let reconnectTimer = null;
let isAutoMode = true;
let isRunning = false;
let currentJob = null;
let watermarkEngine = null;
let queuedJobs = [];     // { id, prompt, reference_files, watermark_removal, status }
let manualRefFiles = []; // user-dropped files
let daemonWsUrl = DAEMON_WS_DEFAULT; // resolved dynamically

// ── DOM ────────────────────────────────────────────────────────────────────

const statusEl = document.getElementById('status-indicator');
const jobListEl = document.getElementById('job-list');
const runAllBtn = document.getElementById('run-all-btn');
const modeAutoBtn = document.getElementById('mode-auto');
const modeManualBtn = document.getElementById('mode-manual');
const modeLabel = document.getElementById('mode-label');
const removeWatermarkCb = document.getElementById('remove-watermark-cb');
const refArea = document.getElementById('ref-area');

// ── State persistence ─────────────────────────────────────────────────────

if (removeWatermarkCb) {
  chrome.storage.local.get(['removeWatermark'], (res) => {
    if (res.removeWatermark !== undefined) removeWatermarkCb.checked = res.removeWatermark;
  });
  removeWatermarkCb.addEventListener('change', (e) => {
    chrome.storage.local.set({ removeWatermark: e.target.checked });
  });
}

// ── Port discovery ──────────────────────────────────────────────────────

async function discoverWsPort() {
  try {
    const resp = await fetch(`${DAEMON_HTTP}/health`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.wsPort && data.wsPort > 0) {
        daemonWsUrl = `ws://127.0.0.1:${data.wsPort}`;
        remoteLog(`sidepanel: discovered WS port ${data.wsPort}`);
        return;
      }
    }
  } catch (e) {
    // HTTP server not up yet, will retry
  }
  daemonWsUrl = DAEMON_WS_DEFAULT;
}

// ── WebSocket ────────────────────────────────────────────────────────────

async function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws) {
    try { ws.close(); } catch {}
  }

  // Discover actual WS port before connecting
  await discoverWsPort();

  ws = new WebSocket(daemonWsUrl);

  ws.onopen = () => {
    statusEl.className = 'status connected';
    statusEl.title = 'Connected';
    remoteLog('sidepanel: WS connected');
  };

  ws.onclose = () => {
    statusEl.className = 'status disconnected';
    statusEl.title = 'Disconnected';
    remoteLog('sidepanel: WS disconnected, reconnecting in 3s...');
    scheduleReconnect();
  };

  ws.onerror = () => {
    statusEl.className = 'status disconnected';
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMsg(msg);
    } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWs, 3000);
}

function sendWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Message Handlers ──────────────────────────────────────────────────────

function handleMsg(msg) {
  switch (msg.type) {
    case 'NEW_JOB':
      addJob(msg.job);
      break;
    case 'JOB_COMPLETE':
      // Daemon confirms a job is done — but we already track locally
      break;
    default:
      break;
  }
}

function addJob(job) {
  // Dedupe
  if (queuedJobs.find(j => j.id === job.id)) return;

  queuedJobs.push({
    id: job.id,
    prompt: job.prompt || '',
    reference_files: job.reference_files || [],
    watermark_removal: job.watermark_removal ?? true,
    status: 'pending',
  });

  renderJobs();

  if (isAutoMode && !isRunning) {
    runNextJob();
  }
}

function updateJobStatus(jobId, status) {
  const job = queuedJobs.find(j => j.id === jobId);
  if (job) job.status = status;
  renderJobs();
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderJobs() {
  jobListEl.innerHTML = '';

  if (queuedJobs.length === 0) {
    jobListEl.innerHTML = '<div class="empty-state">Waiting for OPSV Daemon...</div>';
    runAllBtn.disabled = true;
    runAllBtn.textContent = '▶ Run All (0)';
    return;
  }

  for (const job of queuedJobs) {
    const div = document.createElement('div');
    div.className = `job-item ${job.status}`;
    div.innerHTML = `
      <div class="job-desc">
        <span class="job-id">${escapeHtml(job.id)}</span>
        ${escapeHtml(job.prompt.length > 80 ? job.prompt.substring(0, 80) + '...' : job.prompt)}
        ${job.reference_files && job.reference_files.length > 0
          ? `<span class="job-refs">📎 ${job.reference_files.length} refs</span>`
          : ''}
      </div>
      <div>
        <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
      </div>`;
    jobListEl.appendChild(div);
  }

  const pending = queuedJobs.filter(j => j.status === 'pending').length;
  runAllBtn.disabled = pending === 0;
  runAllBtn.textContent = `▶ Run All (${pending})`;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Job execution ──────────────────────────────────────────────────────────

async function runNextJob() {
  const pending = queuedJobs.find(j => j.status === 'pending');
  if (!pending) {
    isRunning = false;
    return;
  }

  isRunning = true;
  currentJob = pending;
  updateJobStatus(pending.id, 'running');

  sendWs({ type: 'JOB_STARTED', shotId: pending.id });

  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    let tab;
    if (tabs.length > 0) {
      tab = tabs[0];
    } else {
      // Open new Gemini tab
      tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: false });
    }

    // Wait briefly for tab to load if just opened
    await sleep(1500);

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_JOB',
      job: {
        id: pending.id,
        prompt: pending.prompt,
        reference_files: pending.reference_files,
        watermark_removal: pending.watermark_removal,
      },
    });

    if (response && response.status === 'started') {
      // Content script will call back via sidepanel message
      // ASSET_SAVED is handled below in chrome.runtime.onMessage
    } else {
      throw new Error('Content script did not start');
    }
  } catch (err) {
    remoteLog(`runNextJob error: ${err.message}`);
    updateJobStatus(pending.id, 'failed');
    sendWs({ type: 'JOB_FAILED', shotId: pending.id, error: err.message });
    isRunning = false;
    currentJob = null;
    if (isAutoMode) runNextJob();
  }
}

function runAllJobs() {
  if (isRunning) return;
  isAutoMode = false;
  modeAutoBtn.classList.remove('active');
  modeManualBtn.classList.add('active');
  modeLabel.textContent = 'MANUAL';
  runNextJob();
}

function onJobComplete(shotId, result) {
  if (result.success) {
    updateJobStatus(shotId, 'done');
    sendWs({ type: 'ASSET_SAVED', shotId, paths: result.paths || [] });

    // Save result to storage for the daemon to pick up
    chrome.storage.local.set({ [`result_${shotId}`]: result });
  } else {
    updateJobStatus(shotId, 'failed');
    sendWs({ type: 'JOB_FAILED', shotId, error: result.error || 'Unknown error' });
  }

  currentJob = null;
  isRunning = false;

  // Auto-advance if in auto mode
  if (isAutoMode) {
    setTimeout(runNextJob, 500);
  }
}

// ── Chrome runtime messages (from content script) ────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'ASSET_SAVED') {
    onJobComplete(request.shotId, {
      success: true,
      paths: request.paths || [],
    });
  } else if (request.type === 'JOB_FAILED') {
    onJobComplete(request.shotId, {
      success: false,
      error: request.error || 'Unknown error',
    });
  } else if (request.type === 'REMOTE_LOG') {
    // Forward logs to daemon
    sendWs({ type: 'LOG', message: request.message });
  }
});

// ── Remote Logger ──────────────────────────────────────────────────────────

function remoteLog(...args) {
  console.log(...args);
  try {
    chrome.runtime.sendMessage({
      type: 'REMOTE_LOG',
      message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    }).catch(() => {});
  } catch {}
}

// ── Watermark Engine (lazy load) ──────────────────────────────────────────

async function processWatermarkIfEnabled(blob) {
  if (!removeWatermarkCb || !removeWatermarkCb.checked) return blob;
  try {
    if (!watermarkEngine) {
      watermarkEngine = await window.WatermarkEngine.create();
    }
    const img = new Image();
    const imgUrl = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imgUrl;
    });
    const canvas = await watermarkEngine.removeWatermarkFromImage(img, { adaptiveMode: 'always' });
    URL.revokeObjectURL(imgUrl);
    return await window.canvasToBlob(canvas, blob.type || 'image/png');
  } catch (err) {
    remoteLog('Watermark removal failed:', err.message);
    return blob;
  }
}

// ── Reference Image Drag-Drop (manual user upload) ────────────────────────

if (refArea) {
  refArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    refArea.classList.add('dragover');
  });
  refArea.addEventListener('dragleave', () => {
    refArea.classList.remove('dragover');
  });
  refArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    refArea.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const dataUrl = await fileToDataUrl(f);
      manualRefFiles.push({ name: f.name, dataUrl, blob: f });
    }
    refArea.textContent = `📎 ${manualRefFiles.length} manual ref(s) ready`;
    remoteLog(`Manual refs: ${manualRefFiles.length} files dropped`);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

// ── Utils ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Init ───────────────────────────────────────────────────────────────────

modeAutoBtn.addEventListener('click', () => {
  isAutoMode = true;
  modeAutoBtn.classList.add('active');
  modeManualBtn.classList.remove('active');
  modeLabel.textContent = 'AUTO';
  if (!isRunning) runNextJob();
});

modeManualBtn.addEventListener('click', () => {
  isAutoMode = false;
  modeManualBtn.classList.add('active');
  modeAutoBtn.classList.remove('active');
  modeLabel.textContent = 'MANUAL';
});

runAllBtn.addEventListener('click', runAllJobs);

// Start
connectWs();
renderJobs();
remoteLog('sidepanel initialized');
