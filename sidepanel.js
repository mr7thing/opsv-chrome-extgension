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
let queuedJobs = [];     // { id, prompt, reference_files, watermark_removal, status, result_files, batchId, _selected }
let batches = [];        // { id, color, sentAt, jobIds }
let activeBatchId = null;
let lastReportBatchId = null;
let daemonWsUrl = DAEMON_WS_DEFAULT; // resolved dynamically

// Filter & selection state
let activeFilter = 'all';
let searchQuery = '';
let selectedJobIds = new Set();

// 9-rotation palette (HSL gold/pink/teal/orange/purple/lime/blue/magenta/cyan)
const BATCH_COLORS = [
  '#ff6b6b', '#4ecdc4', '#ffe66d', '#a8e6cf', '#ff8ed4',
  '#c9a0ff', '#7ee787', '#79c0ff', '#f78166'
];
let _batchColorIdx = 0;
function nextBatchColor() {
  const c = BATCH_COLORS[_batchColorIdx % BATCH_COLORS.length];
  _batchColorIdx++;
  return c;
}

// ── DOM ────────────────────────────────────────────────────────────────────

const statusEl = document.getElementById('status-indicator');
const jobListEl = document.getElementById('job-list');
const runAllBtn = document.getElementById('run-all-btn');
const stopBtn = document.getElementById('stop-btn');
const modeAutoBtn = document.getElementById('mode-auto');
const modeManualBtn = document.getElementById('mode-manual');
const modeLabel = document.getElementById('mode-label');
const removeWatermarkCb = document.getElementById('remove-watermark-cb');
const batchBannerEl = document.getElementById('batch-banner');
const batchHistoryEl = document.getElementById('batch-history');
const searchInputEl = document.getElementById('search-input');
const batchToolbarEl = document.getElementById('batch-toolbar');

// ── State persistence ─────────────────────────────────────────────────────

if (removeWatermarkCb) {
  chrome.storage.local.get(['removeWatermark'], (res) => {
    if (res.removeWatermark !== undefined) removeWatermarkCb.checked = res.removeWatermark;
  });
  removeWatermarkCb.addEventListener('change', (e) => {
    chrome.storage.local.set({ removeWatermark: e.target.checked });
  });
}

// ── Job execution ──────────────────────────────────────────────────────────

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
    case 'SYNC_QUEUE':
      // opsv CLI sent a fresh batch — replace entire queue.
      // If a job id already exists, reset its status to 'pending' (it'll be retried).
      const incomingIds = new Set((msg.jobs || []).map(j => j.id).filter(Boolean));
      queuedJobs = queuedJobs.filter(j => !incomingIds.has(j.id)); // drop dupes

      // Create a new batch
      const batchId = `b${Date.now().toString(36)}`;
      const batch = {
        id: batchId,
        color: nextBatchColor(),
        sentAt: new Date(),
        jobIds: (msg.jobs || []).map(j => j.id).filter(Boolean)
      };
      batches.push(batch);
      activeBatchId = batchId;

      queuedJobs = queuedJobs.concat((msg.jobs || []).map(j => ({
        id: j.id,
        prompt: j.prompt || '',
        reference_files: j.reference_files || [],
        watermark_removal: j.watermark_removal !== false,
        status: 'pending',
        result_files: [],
        batchId: batchId
      })));
      renderJobs();
      renderBatches();
      if (isAutoMode && !isRunning) runNextJob();
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
    // Reset modification tracking when CLI sends a fresh batch
    existing._originalPrompt = existing.prompt;
    existing._originalRefs = [...existing.reference_files];
    existing._modifiedPrompt = null;
    existing._modifiedRefs = null;
  } else {
    queuedJobs.push({
      id: job.id,
      prompt: job.prompt || '',
      reference_files: job.reference_files || [],
      watermark_removal: job.watermark_removal ?? true,
      status: 'pending',
      result_files: [],
      // Track original (from CLI) vs modified (from user via editor)
      _originalPrompt: job.prompt || '',
      _originalRefs: [...(job.reference_files || [])],
      _modifiedPrompt: null,
      _modifiedRefs: null,
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
  renderBatches();
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderBatches() {
  if (!batchBannerEl || !batchHistoryEl) return;

  // Active batch banner
  const active = batches.find(b => b.id === activeBatchId);
  if (!active) {
    batchBannerEl.innerHTML = '';
    batchHistoryEl.innerHTML = '';
    return;
  }

  const activeJobs = queuedJobs.filter(j => j.batchId === active.id);
  const done = activeJobs.filter(j => j.status === 'done').length;
  const failed = activeJobs.filter(j => j.status === 'failed').length;
  const running = activeJobs.filter(j => j.status === 'running').length;
  const total = activeJobs.length;
  const isComplete = (done + failed) >= total && total > 0;
  const pct = total === 0 ? 0 : Math.round(((done + failed) / total) * 100);
  const ts = active.sentAt.toLocaleTimeString();

  batchBannerEl.innerHTML = `
    <div class="batch-banner ${isComplete ? 'complete' : ''}" style="--batch-color: ${active.color}">
      <div class="batch-banner-row">
        <span>
          <span class="batch-color-dot" style="background:${active.color}"></span>
          <strong>Batch ${active.id}</strong> · ${ts}
        </span>
        <span>${done + failed}/${total} ${isComplete ? (failed > 0 ? '⚠ has failures' : '✓ all done') : 'running'}</span>
      </div>
      <div class="batch-progress-bar">
        <div class="batch-progress-fill" style="width: ${pct}%; --batch-color: ${active.color}"></div>
      </div>
      ${!isComplete ? `<div style="font-size:10px;color:#888;margin-top:3px;">✓ ${done} done · ❌ ${failed} failed · ⏵ ${running} running · ⏸ ${total - done - failed - running} pending</div>` : ''}
    </div>`;

  // Batch history (collapsed past batches)
  const historyBatches = batches.filter(b => b.id !== activeBatchId).slice(-5);
  if (historyBatches.length > 0) {
    batchHistoryEl.innerHTML = historyBatches.map(b => {
      const bj = queuedJobs.filter(j => j.batchId === b.id);
      const bd = bj.filter(j => j.status === 'done').length;
      const bf = bj.filter(j => j.status === 'failed').length;
      return `<div class="batch-history-item" data-batch-id="${b.id}">
        <span class="batch-color-dot" style="background:${b.color};width:8px;height:8px;"></span>
        <span>${b.id}</span>
        <span>${bd}✓ ${bf}✗</span>
      </div>`;
    }).join('');
  } else {
    batchHistoryEl.innerHTML = '';
  }
}

function renderJobs() {
  jobListEl.innerHTML = '';

  if (queuedJobs.length === 0) {
    jobListEl.innerHTML = '<div class="empty-state">Waiting for OPSV Daemon...</div>';
    runAllBtn.disabled = true;
    runAllBtn.textContent = '▶ Run All (0)';
    return;
  }

  for (const job of queuedJobs) {
    // Apply filter
    if (activeFilter !== 'all' && job.status !== activeFilter) continue;
    // Apply search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchId = job.id?.toLowerCase().includes(q);
      const matchPrompt = job.prompt?.toLowerCase().includes(q);
      if (!matchId && !matchPrompt) continue;
    }

    const div = document.createElement('div');
    div.className = `job-item ${job.status}`;
    div.dataset.jobId = job.id;

    const checked = selectedJobIds.has(job.id) ? 'checked' : '';

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

    // Build modified marker
    const isModified = job._modifiedPrompt !== null || job._modifiedRefs !== null;
    const modifiedMarker = isModified
      ? '<span class="job-modified-marker" title="User-modified prompt or attachments">✏ MODIFIED</span>'
      : '';

    const jobBatch = batches.find(b => b.id === job.batchId);
    const batchDot = jobBatch
      ? `<span class="batch-color-dot" style="background:${jobBatch.color};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle;" title="Batch ${jobBatch.id}"></span>`
      : '';

    div.innerHTML = `
      <input type="checkbox" class="job-checkbox" data-job-id="${job.id}" ${checked}>
      <div class="job-desc">
        <span class="job-id">${batchDot}${escapeHtml(job.id)}${modifiedMarker}</span>
        <div class="job-prompt-text" title="点击编辑提示词和附件">${escapeHtml(job.prompt)}</div>
        ${thumbsContainer}
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
        <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
        <div class="job-actions">
          <button class="btn-action-sm btn-edit" data-job-id="${job.id}" title="编辑提示词和附件">✏️ Edit</button>
          <button class="btn-action-sm btn-inject" data-job-id="${job.id}" title="一键注入图片和文字（不发送）">⚡ Inject</button>
          ${job.status === 'failed' || job.status === 'done' ? `<button class="btn-action-sm btn-retry" data-job-id="${job.id}">🔄 Retry</button>` : ''}
          ${job.status === 'pending' ? `<button class="btn-action-sm btn-run" data-job-id="${job.id}">▶ Run</button>` : ''}
          ${job.status === 'frozen' ? `<button class="btn-action-sm btn-unfreeze" data-job-id="${job.id}">🔓 Unfreeze</button>` : (job.status === 'pending' || job.status === 'failed' || job.status === 'done' ? `<button class="btn-action-sm btn-freeze" data-job-id="${job.id}" title="冻结 (跳过本批执行)">❄️ Freeze</button>` : '')}
          <button class="btn-action-sm btn-remove" data-job-id="${job.id}" title="从队列删除">✕</button>
        </div>
      </div>`;

    // ── Bind Click Listeners for Manual Editing ──

    // 1. Click prompt OR Edit button → open full-screen editor modal
    const promptTextEl = div.querySelector('.job-prompt-text');
    if (promptTextEl) {
      promptTextEl.addEventListener('click', () => {
        openPromptEditor(job.id);
      });
    }
    const editBtn = div.querySelector('.btn-edit');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPromptEditor(job.id);
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

    const removeBtn = div.querySelector('.btn-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (job.status === 'running') {
          alert('Cannot remove a running job. Stop it first.');
          return;
        }
        queuedJobs = queuedJobs.filter(j => j.id !== job.id);
        selectedJobIds.delete(job.id);
        renderJobs();
        updateBatchToolbar();
      });
    }

    const freezeBtn = div.querySelector('.btn-freeze');
    if (freezeBtn) {
      freezeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        freezeJob(job.id);
      });
    }
    const unfreezeBtn = div.querySelector('.btn-unfreeze');
    if (unfreezeBtn) {
      unfreezeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        unfreezeJob(job.id);
      });
    }

    const checkbox = div.querySelector('.job-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkbox.checked) selectedJobIds.add(job.id);
        else selectedJobIds.delete(job.id);
        updateBatchToolbar();
      });
      // Prevent the row click from toggling the checkbox
      checkbox.addEventListener('click', (e) => e.stopPropagation());
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
        // Send incremental result to daemon with modification context
        sendWs({
          type: 'INCREMENTAL_RESULT',
          shotId: job.id,
          fileName: f.name,
          dataUrl: dataUrl,
          originalPrompt: job._originalPrompt || job.prompt,
          modifiedPrompt: job._modifiedPrompt,
          originalRefs: job._originalRefs || job.reference_files,
          modifiedRefs: job._modifiedRefs,
        });
        remoteLog(`Result dropped on job ${job.id}: ${f.name}`);
      }
    });

    jobListEl.appendChild(div);
  }

  const pending = queuedJobs.filter(j => j.status === 'pending').length;
  const failed = queuedJobs.filter(j => j.status === 'failed').length;
  const actionable = pending + failed;
  runAllBtn.disabled = actionable === 0;
  runAllBtn.textContent = `▶ Run All (${actionable})`;
  if (failed > 0 && pending === 0) runAllBtn.textContent = `▶ Retry All (${failed})`;
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
            prompt: job.prompt,                    // already modified if user edited
            reference_files: job.reference_files,  // already modified
            watermark_removal: job.watermark_removal,
            _original: {
              prompt: job._originalPrompt,
              reference_files: job._originalRefs,
            },
            _modified: {
              prompt: job._modifiedPrompt,
              reference_files: job._modifiedRefs,
            },
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
  const pending = queuedJobs.find(j => j.status === 'pending'); // frozen skipped
  if (!pending) {
    isRunning = false;
    // All jobs complete — show DONE badge + batch report
    const allDone = queuedJobs.every(j => j.status === 'done' || j.status === 'failed');
    if (allDone && queuedJobs.length > 0 && chrome.action) {
      chrome.action.setBadgeText({ text: 'DONE' });
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    }
    stopBtn.style.display = 'none';
    runAllBtn.style.display = 'block';

    // Batch completion: report to user + Agent (in auto mode)
    if (isAutoMode && allDone && queuedJobs.length > 0 && activeBatchId && activeBatchId !== lastReportBatchId) {
      lastReportBatchId = activeBatchId;
      const batch = batches.find(b => b.id === activeBatchId);
      const bj = queuedJobs.filter(j => j.batchId === activeBatchId);
      const bd = bj.filter(j => j.status === 'done');
      const bf = bj.filter(j => j.status === 'failed');
      const elapsed = batch ? Math.round((Date.now() - batch.sentAt.getTime()) / 1000) : 0;

      // Switch to manual so the queue stops after this batch
      switchToManualMode();

      // Show report panel
      showBatchReport(batch, bd, bf, elapsed);

      // Send report to daemon (→ opsv CLI / Agent)
      sendBatchReportToAgent(batch, bd, bf, elapsed);
    }
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
      base64Data: result.base64Data,
      originalPrompt: job ? job._originalPrompt : null,
      modifiedPrompt: job ? job._modifiedPrompt : null,
      originalRefs: job ? job._originalRefs : null,
      modifiedRefs: job ? job._modifiedRefs : null,
    });

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

// Clear buttons
const clearAllBtn = document.getElementById('clear-all-btn');
const clearDoneBtn = document.getElementById('clear-done-btn');

if (clearAllBtn) {
  clearAllBtn.addEventListener('click', () => {
    if (isRunning) {
      alert('Cannot clear while a job is running. Stop it first.');
      return;
    }
    if (!confirm(`Clear all ${queuedJobs.length} task(s) from queue?`)) return;
    queuedJobs = [];
    renderJobs();
    remoteLog('Queue cleared by user');
  });
}

if (clearDoneBtn) {
  clearDoneBtn.addEventListener('click', () => {
    const before = queuedJobs.length;
    queuedJobs = queuedJobs.filter(j => j.status !== 'completed' && j.status !== 'failed');
    const removed = before - queuedJobs.length;
    renderJobs();
    remoteLog(`Cleared ${removed} done/failed task(s)`);
  });
}

initFiltersAndSelection();

// ── Batch report panel ───────────────────────────────────────────────────

function showBatchReport(batch, done, failed, elapsedSec) {
  const panel = document.createElement('div');
  panel.className = `batch-report-panel ${failed.length > 0 ? 'failed-batch' : ''}`;
  panel.id = 'batch-report-panel';

  const ts = batch ? batch.sentAt.toLocaleTimeString() : '?';
  const failedList = failed.map(j => j.id).join(', ') || '—';
  const doneList = done.map(j => j.id).join(', ') || '—';

  panel.innerHTML = `
    <div class="batch-report-title">
      <span class="batch-color-dot" style="background:${batch?.color || '#888'}; display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px;"></span>
      Batch ${batch?.id || '?'} 完成 · ${ts}
    </div>
    <div class="batch-report-stats">
      ✓ <strong style="color:#7ee787;">${done.length}</strong> done ·
      ✗ <strong style="color:#ff6b6b;">${failed.length}</strong> failed ·
      ⏱ ${elapsedSec}s
    </div>
    <div style="font-size:10px; color:#888; margin-bottom:6px;">
      Done: ${doneList}<br>
      Failed: <span style="color:#ff6b6b;">${failedList}</span>
    </div>
    <div class="batch-report-actions">
      ${failed.length > 0 ? '<button id="retry-failed-btn" class="btn-secondary">🔁 Retry Failed (' + failed.length + ')</button>' : ''}
      <button id="copy-report-btn" class="btn-secondary">📋 Copy Report</button>
      <button id="send-agent-btn" class="btn-secondary">📡 Send to Agent</button>
      <button id="dismiss-report-btn" class="btn-secondary">✕ Dismiss</button>
    </div>
  `;

  // Replace any existing report
  const old = document.getElementById('batch-report-panel');
  if (old) old.remove();
  if (batchBannerEl && batchBannerEl.parentNode) {
    batchBannerEl.parentNode.insertBefore(panel, batchBannerEl.nextSibling);
  }

  // Wire buttons
  const retryBtn = panel.querySelector('#retry-failed-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      retryFailedBatch(batch.id);
      panel.remove();
    });
  }
  panel.querySelector('#copy-report-btn')?.addEventListener('click', () => {
    const text = formatBatchReportText(batch, done, failed, elapsedSec);
    navigator.clipboard.writeText(text).then(() => alert('Report copied to clipboard'));
  });
  panel.querySelector('#send-agent-btn')?.addEventListener('click', () => {
    sendBatchReportToAgent(batch, done, failed, elapsedSec, true);
    alert('Report sent to agent via daemon.');
  });
  panel.querySelector('#dismiss-report-btn')?.addEventListener('click', () => {
    panel.remove();
  });
}

function formatBatchReportText(batch, done, failed, elapsedSec) {
  const ts = batch ? batch.sentAt.toISOString() : '?';
  return [
    `# OpsV Batch Report — ${batch?.id || '?'}`,
    `Sent: ${ts}`,
    `Elapsed: ${elapsedSec}s`,
    ``,
    `✓ DONE (${done.length}): ${done.map(j => j.id).join(', ') || '—'}`,
    `✗ FAILED (${failed.length}): ${failed.map(j => j.id).join(', ') || '—'}`,
    ``,
    `Agent decision: retry_failed | manual_fix | accept`
  ].join('\n');
}

function sendBatchReportToAgent(batch, done, failed, elapsedSec, manual = false) {
  const report = {
    type: 'OPSV_REPORT',
    batchId: batch?.id,
    color: batch?.color,
    sentAt: batch?.sentAt?.toISOString(),
    elapsedSec,
    done: done.map(j => ({ id: j.id })),
    failed: failed.map(j => ({ id: j.id, prompt: j.prompt?.slice(0, 200) })),
    manual: !!manual
  };
  // Send via WS to daemon → daemon writes to /tmp/opsv-reports/<batchId>.json
  sendWs(report);
  remoteLog(`Batch report sent: ${batch?.id} (${done.length}✓ ${failed.length}✗)`);
}

function retryFailedBatch(batchId) {
  const bf = queuedJobs.filter(j => j.batchId === batchId && j.status === 'failed');
  if (bf.length === 0) return;

  // Reset failed → pending (in same batch — keeps color continuity)
  bf.forEach(j => { j.status = 'pending'; });
  renderJobs();
  renderBatches();

  // Switch back to auto mode
  isAutoMode = true;
  modeAutoBtn.classList.add('active');
  modeManualBtn.classList.remove('active');
  modeLabel.textContent = 'AUTO';
  lastReportBatchId = null; // allow new report when this retry completes

  // Kick off
  if (!isRunning) runNextJob();
  remoteLog(`Retrying ${bf.length} failed job(s) from batch ${batchId}`);
}

function freezeJob(jobId) {
  const j = queuedJobs.find(x => x.id === jobId);
  if (!j) return;
  if (j.status === 'running') return; // can't freeze running
  j.status = 'frozen';
  renderJobs();
  renderBatches();
  updateBatchToolbar();
  remoteLog(`Froze job: ${jobId}`);
}

function unfreezeJob(jobId) {
  const j = queuedJobs.find(x => x.id === jobId);
  if (!j) return;
  if (j.status !== 'frozen') return;
  j.status = 'pending';
  renderJobs();
  renderBatches();
  updateBatchToolbar();
  remoteLog(`Unfroze job: ${jobId}`);
}

// ── Batch toolbar + filters ─────────────────────────────────────────────────

function updateBatchToolbar() {
  if (!batchToolbarEl) return;
  const n = selectedJobIds.size;
  batchToolbarEl.querySelector('.selected-count').textContent = `${n} selected`;
  if (n > 0) batchToolbarEl.classList.add('visible');
  else batchToolbarEl.classList.remove('visible');
}

function getSelectedJobs() {
  return queuedJobs.filter(j => selectedJobIds.has(j.id));
}

function batchFreeze() {
  const jobs = getSelectedJobs().filter(j => j.status !== 'running');
  jobs.forEach(j => { j.status = 'frozen'; });
  renderJobs();
  renderBatches();
  updateBatchToolbar();
  remoteLog(`Batch froze ${jobs.length} job(s)`);
}

function batchUnfreeze() {
  const jobs = getSelectedJobs().filter(j => j.status === 'frozen');
  jobs.forEach(j => { j.status = 'pending'; });
  renderJobs();
  renderBatches();
  updateBatchToolbar();
  remoteLog(`Batch unfroze ${jobs.length} job(s)`);
}

function batchDelete() {
  if (!confirm(`Delete ${selectedJobIds.size} selected job(s)?`)) return;
  const removable = getSelectedJobs().filter(j => j.status !== 'running');
  queuedJobs = queuedJobs.filter(j => !selectedJobIds.has(j.id) || j.status === 'running');
  selectedJobIds.clear();
  renderJobs();
  updateBatchToolbar();
  remoteLog(`Batch deleted ${removable.length} job(s)`);
}

function batchRun() {
  // Reset selected failed/done/frozen → pending, then run
  const jobs = getSelectedJobs();
  jobs.forEach(j => {
    if (j.status === 'failed' || j.status === 'done' || j.status === 'frozen') {
      j.status = 'pending';
    }
  });
  renderJobs();
  renderBatches();
  updateBatchToolbar();
  // Switch to auto + kick off
  isAutoMode = true;
  modeAutoBtn.classList.add('active');
  modeManualBtn.classList.remove('active');
  modeLabel.textContent = 'AUTO';
  lastReportBatchId = null;
  if (!isRunning) runNextJob();
  remoteLog(`Batch run: ${jobs.length} job(s) queued`);
}

// Init filter chips + search input + batch toolbar buttons
function initFiltersAndSelection() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      renderJobs();
    });
  });
  if (searchInputEl) {
    searchInputEl.addEventListener('input', () => {
      searchQuery = searchInputEl.value;
      renderJobs();
    });
  }

  const bf = document.getElementById('batch-freeze-btn');
  if (bf) bf.addEventListener('click', batchFreeze);
  const buf = document.getElementById('batch-unfreeze-btn');
  if (buf) buf.addEventListener('click', batchUnfreeze);
  const br = document.getElementById('batch-run-btn');
  if (br) br.addEventListener('click', batchRun);
  const bd = document.getElementById('batch-delete-btn');
  if (bd) bd.addEventListener('click', batchDelete);
  const bc = document.getElementById('batch-clear-sel-btn');
  if (bc) bc.addEventListener('click', () => {
    selectedJobIds.clear();
    renderJobs();
    updateBatchToolbar();
  });
}

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

  if (chrome.action) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  }
  remoteLog('Queue execution stopped by user');
}

stopBtn.addEventListener('click', stopRunAll);

// ── Prompt Editor Modal ─────────────────────────────────────────────────────

let editorCurrentJobId = null;

function openPromptEditor(jobId) {
  const job = queuedJobs.find(j => j.id === jobId);
  if (!job) return;

  editorCurrentJobId = jobId;

  // Populate title
  document.getElementById('editor-title').textContent = `Edit Task: ${job.id}`;

  // Populate original (read-only)
  const origEl = document.getElementById('editor-original');
  const origPrompt = job._originalPrompt || job.prompt;
  origEl.textContent = origPrompt;
  // Highlight if modified
  if (job._modifiedPrompt !== null) {
    origEl.classList.add('modified');
  } else {
    origEl.classList.remove('modified');
  }

  // Populate textarea (use modified if set, otherwise original)
  const textarea = document.getElementById('editor-textarea');
  textarea.value = job._modifiedPrompt !== null ? job._modifiedPrompt : job.prompt;

  // Populate attachments (use modified if set, otherwise original)
  renderEditorAttachments(job._modifiedRefs !== null ? job._modifiedRefs : job.reference_files);

  // Show modal
  document.getElementById('editor-overlay').classList.add('open');

  // Focus textarea
  setTimeout(() => {
    textarea.focus();
    // Place cursor at end
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }, 50);

  // Prevent dialog from interfering with outside clicks
  event && event.stopPropagation && event.stopPropagation();
}

function closePromptEditor() {
  editorCurrentJobId = null;
  document.getElementById('editor-overlay').classList.remove('open');
}

function renderEditorAttachments(refs) {
  const container = document.getElementById('editor-attachments');
  container.innerHTML = '';

  if (!refs || refs.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'editor-att-empty';
    empty.textContent = 'No attachments. Drag images here or click "+ Add"';
    container.appendChild(empty);
    return;
  }

  refs.forEach((ref, idx) => {
    const item = document.createElement('div');
    item.className = 'editor-att-item';

    const name = document.createElement('span');
    name.className = 'editor-att-name';
    name.title = ref;
    name.textContent = ref.split('/').pop();

    const remove = document.createElement('button');
    remove.className = 'editor-att-remove';
    remove.textContent = '✕';
    remove.title = 'Remove attachment';
    remove.addEventListener('click', () => {
      const updated = refs.slice();
      updated.splice(idx, 1);
      renderEditorAttachments(updated);
    });

    item.appendChild(name);
    item.appendChild(remove);
    container.appendChild(item);
  });

  // Add "+ Add" button at the end
  const addBtn = document.createElement('button');
  addBtn.className = 'editor-att-new';
  addBtn.textContent = '+ Add file path';
  addBtn.addEventListener('click', () => {
    const path = prompt('Enter absolute image path:');
    if (path && path.trim()) {
      const updated = refs.slice();
      updated.push(path.trim());
      renderEditorAttachments(updated);
    }
  });
  container.appendChild(addBtn);
}

function getEditorAttachments() {
  const container = document.getElementById('editor-attachments');
  const items = container.querySelectorAll('.editor-att-item .editor-att-name');
  return Array.from(items).map(el => el.title);
}

function saveAndSendFromEditor() {
  if (!editorCurrentJobId) return;
  const job = queuedJobs.find(j => j.id === editorCurrentJobId);
  if (!job) return;

  const newPrompt = document.getElementById('editor-textarea').value.trim();
  const newRefs = getEditorAttachments();

  // Detect modification
  const originalPrompt = job._originalPrompt || job.prompt;
  const originalRefs = job._originalRefs || job.reference_files;

  const promptChanged = newPrompt !== originalPrompt;
  const refsChanged = JSON.stringify(newRefs) !== JSON.stringify(originalRefs);

  if (promptChanged || refsChanged) {
    job._modifiedPrompt = newPrompt;
    job._modifiedRefs = newRefs;
    // Apply modification to live fields
    job.prompt = newPrompt;
    job.reference_files = newRefs;
    remoteLog(`Task ${job.id} marked MODIFIED (prompt: ${promptChanged}, refs: ${refsChanged})`);
  } else {
    // Reverted to original — clear modification flags
    job._modifiedPrompt = null;
    job._modifiedRefs = null;
    job.prompt = originalPrompt;
    job.reference_files = originalRefs;
    remoteLog(`Task ${job.id} reverted to original`);
  }

  closePromptEditor();
  renderJobs();

  // Trigger execution
  runJobExecutor(job);
}

// Drag-and-drop attachments into the editor
document.addEventListener('DOMContentLoaded', () => {
  const attContainer = document.getElementById('editor-attachments');
  if (attContainer) {
    attContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      attContainer.classList.add('drag-over');
    });
    attContainer.addEventListener('dragleave', () => {
      attContainer.classList.remove('drag-over');
    });
    attContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      attContainer.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // For dropped files, we need absolute paths. We can't read f.path on modern browsers.
      // User must use the + Add button or paste path. Just show alert.
      alert('Browser security prevents reading dropped file paths. Use "+ Add file path" instead.');
    });
  }

  // Close handlers
  document.getElementById('editor-close').addEventListener('click', closePromptEditor);
  document.getElementById('editor-cancel').addEventListener('click', closePromptEditor);
  document.getElementById('editor-send').addEventListener('click', saveAndSendFromEditor);

  // Click overlay backdrop to close
  document.getElementById('editor-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'editor-overlay') closePromptEditor();
  });

  // ESC + Ctrl/⌘+Enter
  document.getElementById('editor-textarea').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePromptEditor();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveAndSendFromEditor();
    }
  });
});

// ── Init ───────────────────────────────────────────────────────────────────

// Start connection
connectWs();
renderJobs();
remoteLog('sidepanel initialized');
