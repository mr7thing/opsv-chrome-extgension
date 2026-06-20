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
const stopBtn = document.getElementById('stop-btn');
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

// ── Queue state persistence ────────────────────────────────────────────────

function saveState() {
  const state = {
    queuedJobs: queuedJobs.map(j => ({
      id: j.id,
      prompt: j.prompt,
      reference_files: j.reference_files,
      watermark_removal: j.watermark_removal,
      status: j.status,
      result_files: j.result_files || []
    })),
    isAutoMode,
    isRunning,
    currentJobId: currentJob ? currentJob.id : null,
    timestamp: Date.now()
  };
  chrome.storage.local.set({ queueState: state });
}

function restoreState() {
  chrome.storage.local.get(['queueState'], (result) => {
    if (result.queueState) {
      const state = result.queueState;
      if (Date.now() - state.timestamp < 24 * 60 * 60 * 1000) {
        queuedJobs = state.queuedJobs || [];
        isAutoMode = state.isAutoMode !== undefined ? state.isAutoMode : true;
        if (state.isRunning && state.currentJobId) {
          currentJob = queuedJobs.find(j => j.id === state.currentJobId) || null;
          isRunning = false; // Don't resume auto-run, but preserve queue
        }
        // Restore auto/manual mode button states
        if (isAutoMode) {
          modeAutoBtn.classList.add('active');
          modeManualBtn.classList.remove('active');
          modeLabel.textContent = 'AUTO';
        } else {
          modeManualBtn.classList.add('active');
          modeAutoBtn.classList.remove('active');
          modeLabel.textContent = 'MANUAL';
        }
        renderJobs();
      }
    }
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
    if (chrome.action) {
      chrome.action.setBadgeText({ text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    }
    remoteLog('sidepanel: WS connected');

    // Recovery: check if there's a job running and try to recover
    if (currentJob && !isRunning) {
      // No job actively running, but check if there's a pending queue
      checkRecovery();
    }
  };

  ws.onclose = () => {
    statusEl.className = 'status disconnected';
    statusEl.title = 'Disconnected';
    if (chrome.action) {
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
    }
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
    case 'FINAL_ASSET_SAVED':
      remoteLog(`Final asset saved for ${msg.shotId}: ${msg.path}`);
      const finalJob = queuedJobs.find(j => j.id === msg.shotId);
      if (finalJob) {
        finalJob.result_files = [msg.path];
        renderJobs();
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
  saveState();

  if (isAutoMode && !isRunning) {
    runNextJob();
  }
}

function updateJobStatus(jobId, status) {
  const job = queuedJobs.find(j => j.id === jobId);
  if (job) job.status = status;
  renderJobs();
  saveState();
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
        thumbsHtml += `<img src="${fileUrl}" class="selected" title="${escapeHtml(refPath.split('/').pop())}" 
                          data-path="${escapeHtml(refPath)}"
                          loading="lazy">`;
      }
      thumbsHtml += '</div>';
    }

    // Build result thumbnails (F3)
    let resultThumbsHtml = '';
    if (job.result_files && job.result_files.length > 0) {
      resultThumbsHtml = '<div class="job-thumbs result-thumbs">';
      for (const resPath of job.result_files) {
        if (resPath.startsWith('blob:')) {
          // 渲染为脉冲动画的保存占位图，防止 CSP 报错且美观
          resultThumbsHtml += `
            <div class="saving-thumb" title="正在从网页获取图片并落盘保存中...">
              <div class="pulse-dot"></div>
              <span class="saving-text">保存中</span>
            </div>`;
          continue;
        }

        let fileUrl = resPath;
        if (!resPath.startsWith('http://') && !resPath.startsWith('https://')) {
          let safePath = resPath.replace(/\\/g, '/');
          if (!safePath.startsWith('/')) safePath = '/' + safePath;
          fileUrl = `${DAEMON_HTTP}/files/${safePath}`;
        }
        resultThumbsHtml += `<img src="${fileUrl}" title="${escapeHtml(resPath.split('/').pop())}" 
                            loading="lazy">`;
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
        // 点击文本自动切换成手动模式注入
        switchToManualMode();
        injectPromptText(job);
      });
    }

    // 2. Click individual reference image thumbnail to toggle selection + Drag event
    const refThumbImgs = div.querySelectorAll('.thumb-section:first-child .job-thumbs img');
    refThumbImgs.forEach((imgEl) => {
      // 启用拖拽支持，并绑定 dragstart 事件
      imgEl.setAttribute('draggable', 'true');
      imgEl.addEventListener('click', (e) => {
        e.stopPropagation();
        imgEl.classList.toggle('selected');
      });
      imgEl.addEventListener('dragstart', (e) => {
        const fileUrl = imgEl.src;
        e.dataTransfer.setData('text/uri-list', fileUrl);
        e.dataTransfer.setData('text/plain', fileUrl);
        remoteLog(`Drag start for reference image: ${fileUrl}`);
      });
      // 程序化绑定 onerror 处理器，避开 MV3 插件环境对 inline 脚本的 CSP 限制
      imgEl.addEventListener('error', () => {
        imgEl.style.display = 'none';
      });
    });

    // 另外程序化绑定结果图片的 onerror 处理
    const resultImgs = div.querySelectorAll('.result-thumbs img');
    resultImgs.forEach((imgEl) => {
      imgEl.addEventListener('error', () => {
        imgEl.style.display = 'none';
      });
    });

    // 3. Click Inject button to inject both images and text without sending
    const injectBtn = div.querySelector('.btn-inject');
    if (injectBtn) {
      injectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        switchToManualMode(); // 注入时同样切为手动修改状态
        const selectedImgs = div.querySelectorAll('.thumb-section:first-child .job-thumbs img.selected');
        const selectedRefs = Array.from(selectedImgs).map(img => img.dataset.path);
        injectJobAssets(job, selectedRefs);
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

  stopBtn.style.display = 'block';
  runAllBtn.style.display = 'none';

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
    stopBtn.style.display = 'none';
    runAllBtn.style.display = 'block';
    sendWs({ type: 'JOB_FAILED', shotId: job.id, error: err.message });
    isRunning = false;
    currentJob = null;
    if (isAutoMode) {
      setTimeout(runNextJob, 3000 + Math.random() * 3000);
    }
  }
}

async function runNextJob() {
  if (isRunning) return;
  const pending = queuedJobs.find(j => j.status === 'pending');
  if (!pending) {
    isRunning = false;
    // All jobs complete — show DONE badge
    const allDone = queuedJobs.every(j => j.status === 'done' || j.status === 'failed');
    if (allDone && queuedJobs.length > 0 && chrome.action) {
      chrome.action.setBadgeText({ text: 'DONE' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    }
    stopBtn.style.display = 'none';
    runAllBtn.style.display = 'block';
    return;
  }
  await runJobExecutor(pending);
}

function runAllJobs() {
  if (isRunning) return;
  
  // Reset failed jobs to pending
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
  saveState();
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
    saveState();
  } else {
    updateJobStatus(shotId, 'failed');
    sendWs({ type: 'JOB_FAILED', shotId, error: result.error || 'Unknown error' });
  }

  currentJob = null;
  isRunning = false;
  stopBtn.style.display = 'none';
  runAllBtn.style.display = 'block';

  // Auto-advance if in auto mode
  if (isAutoMode) {
    setTimeout(runNextJob, 3000 + Math.random() * 3000);
  }
  saveState();
}

// ── Chrome runtime messages (from content script)

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

function switchToManualMode() {
  isAutoMode = false;
  modeManualBtn.classList.add('active');
  modeAutoBtn.classList.remove('active');
  modeLabel.textContent = 'MANUAL';
}

modeAutoBtn.addEventListener('click', () => {
  isAutoMode = true;
  modeAutoBtn.classList.add('active');
  modeManualBtn.classList.remove('active');
  modeLabel.textContent = 'AUTO';
  if (!isRunning) runNextJob();
});

modeManualBtn.addEventListener('click', () => {
  switchToManualMode();
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

async function injectJobAssets(job, selectedRefs) {
  try {
    const refs = selectedRefs !== undefined ? selectedRefs : job.reference_files;
    const tabId = await getOrOpenGeminiTab();
    await chrome.tabs.sendMessage(tabId, {
      type: 'INJECT_ALL',
      prompt: job.prompt,
      reference_files: refs
    });
    remoteLog(`Injected assets manually for ${job.id} (images: ${refs.length})`);
  } catch (err) {
    remoteLog(`Manual inject assets failed: ${err.message}`);
  }
}

runAllBtn.addEventListener('click', runAllJobs);

// ── Recovery ───────────────────────────────────────────────────────────────

async function checkRecovery() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (tabs.length === 0) {
      remoteLog('Recovery: No Gemini tab found');
      return;
    }
    const tab = tabs[0];
    // Try to inject content script and check for results
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch {}
    await sleep(1000);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CHECK_LAST_IMAGE' });
    if (response && response.hasNewImage && response.base64Data) {
      remoteLog('Recovery: Found existing generated image on Gemini page');
      // Find the last running/pending job
      const pendingJob = queuedJobs.find(j => j.status === 'running' || j.status === 'pending');
      if (pendingJob) {
        pendingJob.status = 'done';
        pendingJob.result_files = [response.imageUrl || ''];
        renderJobs();
        saveState();
        // Notify daemon
        sendWs({
          type: 'ASSET_SAVED',
          shotId: pendingJob.id,
          paths: [response.imageUrl || ''],
          base64Data: response.base64Data
        });
        remoteLog(`Recovery: Saved recovered image for ${pendingJob.id}`);
      }
    }
  } catch (err) {
    remoteLog('Recovery check error:', err.message);
  }
}

// ── Stop Button ────────────────────────────────────────────────────────────

function stopRunAll() {
  isAutoMode = false;
  isRunning = false;
  currentJob = null;
  modeManualBtn.classList.add('active');
  modeAutoBtn.classList.remove('active');
  modeLabel.textContent = 'MANUAL';
  stopBtn.style.display = 'none';
  runAllBtn.style.display = 'block';
  renderJobs();
  saveState();
  if (chrome.action) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  }
  remoteLog('Queue execution stopped by user');
}

stopBtn.addEventListener('click', stopRunAll);

// ── Init ───────────────────────────────────────────────────────────────────

// Restore persisted queue state
restoreState();

// Start connection
connectWs();
renderJobs();
remoteLog('sidepanel initialized');
