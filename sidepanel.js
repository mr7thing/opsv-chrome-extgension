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
let queuedJobs = [];     // { id, prompt, reference_files, watermark_removal, status, result_files }
let daemonWsUrl = DAEMON_WS_DEFAULT; // resolved dynamically

// ── DOM ────────────────────────────────────────────────────────────────────

const statusEl = document.getElementById('status-indicator');
const jobListEl = document.getElementById('job-list');
const runAllBtn = document.getElementById('run-all-btn');
const modeAutoBtn = document.getElementById('mode-auto');
const modeManualBtn = document.getElementById('mode-manual');
const modeLabel = document.getElementById('mode-label');
const removeWatermarkCb = document.getElementById('remove-watermark-cb');

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
    case 'INCREMENTAL_SAVED':
      remoteLog(`Incremental result saved for ${msg.shotId}: ${msg.path}`);
      const savedJob = queuedJobs.find(j => j.id === msg.shotId);
      if (savedJob) {
        if (!savedJob.result_files) savedJob.result_files = [];
        if (!savedJob.result_files.includes(msg.path)) {
          savedJob.result_files.push(msg.path);
        }
        renderJobs(); // refresh UI (F4)
      }
      break;
    default:
      break;
  }
}

function addJob(job) {
  const existing = queuedJobs.find(j => j.id === job.id);
  if (existing) {
    existing.prompt = job.prompt || '';
    existing.reference_files = job.reference_files || [];
    existing.watermark_removal = job.watermark_removal ?? true;
    existing.status = 'pending';
    existing.result_files = [];
  } else {
    queuedJobs.push({
      id: job.id,
      prompt: job.prompt || '',
      reference_files: job.reference_files || [],
      watermark_removal: job.watermark_removal ?? true,
      status: 'pending',
      result_files: []
    });
  }

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
    div.dataset.jobId = job.id;

    // Build reference thumbnails
    let thumbsHtml = '';
    if (job.reference_files && job.reference_files.length > 0) {
      thumbsHtml = '<div class="job-thumbs">';
      for (const refPath of job.reference_files) {
        let safePath = refPath.replace(/\\/g, '/');
        if (!safePath.startsWith('/')) safePath = '/' + safePath;
        const fileUrl = `${DAEMON_HTTP}/files/${safePath}`;
        thumbsHtml += `<img src="${fileUrl}" title="${escapeHtml(refPath.split('/').pop())}" 
                          onerror="this.style.display='none'" loading="lazy">`;
      }
      thumbsHtml += '</div>';
    }

    // Build result thumbnails (F3)
    let resultThumbsHtml = '';
    if (job.result_files && job.result_files.length > 0) {
      resultThumbsHtml = '<div class="job-thumbs result-thumbs">';
      for (const resPath of job.result_files) {
        let fileUrl = resPath;
        if (!resPath.startsWith('http://') && !resPath.startsWith('https://')) {
          let safePath = resPath.replace(/\\/g, '/');
          if (!safePath.startsWith('/')) safePath = '/' + safePath;
          fileUrl = `${DAEMON_HTTP}/files/${safePath}`;
        }
        resultThumbsHtml += `<img src="${fileUrl}" title="${escapeHtml(resPath.split('/').pop())}" 
                            onerror="this.style.display='none'" loading="lazy">`;
      }
      resultThumbsHtml += '</div>';
    }

    const thumbsContainer = `
      <div class="job-thumbs-container">
        ${thumbsHtml ? `<div class="thumb-section"><span class="thumb-label">Ref:</span>${thumbsHtml}</div>` : ''}
        ${resultThumbsHtml ? `<div class="thumb-section"><span class="thumb-label">Result:</span>${resultThumbsHtml}</div>` : ''}
      </div>`;

    div.innerHTML = `
      <div class="job-desc">
        <span class="job-id">${escapeHtml(job.id)}</span>
        <div class="job-prompt-text" title="点击单独注入提示词到输入框">${escapeHtml(job.prompt)}</div>
        ${thumbsContainer}
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
        <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
        <div class="job-actions">
          <button class="btn-action-sm btn-inject" data-job-id="${job.id}" title="一键注入图片和文字（不发送）">⚡ Inject</button>
          ${job.status === 'failed' || job.status === 'done' ? `<button class="btn-action-sm btn-retry" data-job-id="${job.id}">🔄 Retry</button>` : ''}
          ${job.status === 'pending' ? `<button class="btn-action-sm btn-run" data-job-id="${job.id}">▶ Run</button>` : ''}
        </div>
      </div>`;

    // ── Bind Click Listeners for Manual Editing ──

    // 1. Click prompt to inject text
    const promptTextEl = div.querySelector('.job-prompt-text');
    if (promptTextEl) {
      promptTextEl.addEventListener('click', () => {
        injectPromptText(job);
      });
    }

    // 2. Click individual reference image thumbnail to inject it
    const refThumbImgs = div.querySelectorAll('.thumb-section:first-child .job-thumbs img');
    refThumbImgs.forEach((imgEl, idx) => {
      imgEl.addEventListener('click', () => {
        const refPath = job.reference_files[idx];
        if (refPath) injectReferenceImage(job, refPath);
      });
    });

    // 3. Click Inject button to inject both images and text without sending
    const injectBtn = div.querySelector('.btn-inject');
    if (injectBtn) {
      injectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        injectJobAssets(job);
      });
    }

    // ── Run & Retry Buttons ──
    const runBtn = div.querySelector('.btn-run');
    if (runBtn) {
      runBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        runJobExecutor(job);
      });
    }

    const retryBtn = div.querySelector('.btn-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetJob = queuedJobs.find(j => j.id === job.id);
        if (targetJob) {
          targetJob.status = 'pending';
          renderJobs();
          runJobExecutor(targetJob);
        }
      });
    }

    // ── Per-job drop target for result images ──
    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      div.classList.add('dragover');
    });
    div.addEventListener('dragleave', () => {
      div.classList.remove('dragover');
    });
    div.addEventListener('drop', async (e) => {
      e.preventDefault();
      div.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        const dataUrl = await fileToDataUrl(f);
        // Send incremental result to daemon
        sendWs({
          type: 'INCREMENTAL_RESULT',
          shotId: job.id,
          fileName: f.name,
          dataUrl: dataUrl,
        });
        remoteLog(`Result dropped on job ${job.id}: ${f.name}`);
      }
    });

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

async function runJobExecutor(job) {
  if (isRunning) {
    remoteLog(`Cannot run ${job.id}: another job is already running.`);
    return;
  }

  isRunning = true;
  currentJob = job;
  updateJobStatus(job.id, 'running');

  sendWs({ type: 'JOB_STARTED', shotId: job.id });

  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    let tab;
    if (tabs.length > 0) {
      tab = tabs[0];
      // Make tab active so user can see it (I1)
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      // Open new Gemini tab and make it active (I1)
      tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
    }

    // Programmatically inject content script if not loaded (B1)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      remoteLog(`Content script injection triggered for tab ${tab.id}`);
    } catch (injectErr) {
      remoteLog(`Content script injection message: ${injectErr.message}`);
    }

    // Wait for tab to load and content script to respond (reduced delay, fixing I2)
    const backoffs = [1500, 3000, 5000];
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(backoffs[attempt]);
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_JOB',
          job: {
            id: job.id,
            prompt: job.prompt,
            reference_files: job.reference_files,
            watermark_removal: job.watermark_removal,
          },
        });
        break;
      } catch (e) {
        remoteLog(`Attempt ${attempt + 1}/3: content script not ready on tab ${tab.id}, URL: ${tab.url || 'unknown'}, error: ${e.message}`);
        if (attempt === 2) throw e;
      }
    }

    if (response && response.status === 'started') {
      // Content script will call back via sidepanel message
    } else {
      throw new Error('Content script did not start execution');
    }
  } catch (err) {
    remoteLog(`runJobExecutor error: ${err.message}`);
    updateJobStatus(job.id, 'failed');
    sendWs({ type: 'JOB_FAILED', shotId: job.id, error: err.message });
    isRunning = false;
    currentJob = null;
    if (isAutoMode) {
      setTimeout(runNextJob, 1000);
    }
  }
}

async function runNextJob() {
  if (isRunning) return;
  const pending = queuedJobs.find(j => j.status === 'pending');
  if (!pending) {
    isRunning = false;
    return;
  }
  await runJobExecutor(pending);
}

function runAllJobs() {
  if (isRunning) return;
  
  // Reset failed jobs to pending (F2)
  for (const job of queuedJobs) {
    if (job.status === 'failed') {
      job.status = 'pending';
    }
  }

  isAutoMode = true;
  modeAutoBtn.classList.add('active');
  modeManualBtn.classList.remove('active');
  modeLabel.textContent = 'AUTO';
  renderJobs();
  runNextJob();
}

function onJobComplete(shotId, result) {
  if (result.success) {
    updateJobStatus(shotId, 'done');

    const job = queuedJobs.find(j => j.id === shotId);
    if (job) {
      job.result_files = result.paths || [];
    }

    sendWs({
      type: 'ASSET_SAVED',
      shotId,
      paths: result.paths || [],
      base64Data: result.base64Data
    });

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
    setTimeout(runNextJob, 1000);
  }
}

// ── Chrome runtime messages (from content script) ────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'ASSET_SAVED') {
    onJobComplete(request.shotId, {
      success: true,
      paths: request.paths || [],
      base64Data: request.base64Data
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

// ── Utils ──────────────────────────────────────────────────────────────────

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

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

// ── Manual Injections ──────────────────────────────────────────────────────────

async function getOrOpenGeminiTab() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  let tab;
  if (tabs.length > 0) {
    tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  }

  // 确保注入最新 content.js
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch {}
  await sleep(1000);
  return tab.id;
}

async function injectPromptText(job) {
  try {
    const tabId = await getOrOpenGeminiTab();
    await chrome.tabs.sendMessage(tabId, {
      type: 'INJECT_PROMPT',
      prompt: job.prompt
    });
    remoteLog(`Injected prompt text manually for ${job.id}`);
  } catch (err) {
    remoteLog(`Manual inject text failed: ${err.message}`);
  }
}

async function injectReferenceImage(job, fileUrl) {
  try {
    const tabId = await getOrOpenGeminiTab();
    await chrome.tabs.sendMessage(tabId, {
      type: 'INJECT_REF_IMAGE',
      fileUrl: fileUrl
    });
    remoteLog(`Injected reference image manually for ${job.id}`);
  } catch (err) {
    remoteLog(`Manual inject reference image failed: ${err.message}`);
  }
}

async function injectJobAssets(job) {
  try {
    const tabId = await getOrOpenGeminiTab();
    await chrome.tabs.sendMessage(tabId, {
      type: 'INJECT_ALL',
      prompt: job.prompt,
      reference_files: job.reference_files
    });
    remoteLog(`Injected all assets manually for ${job.id}`);
  } catch (err) {
    remoteLog(`Manual inject all failed: ${err.message}`);
  }
}

runAllBtn.addEventListener('click', runAllJobs);

// Start
connectWs();
renderJobs();
remoteLog('sidepanel initialized');
