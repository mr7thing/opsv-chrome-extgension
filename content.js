// Content Script for Gemini — with reference image clipboard paste upload
// ============================================================================
(function () {
  if (window.hasOpsVContentScript) {
    console.log('OpsV Automation Script already loaded. Skipping.');
    return;
  }
  window.hasOpsVContentScript = true;

  // Track the last selection range in the composer contenteditable
  let lastSelectionRange = null;

  // Detect whether this is a fresh page (vs. SPA navigation) — Gemini is a
  // SPA so URL changes don't reload the script. But a hard refresh DOES, and
  // we need to recover cleanly: drop any stale state and tell background.
  let isFreshLoad = (performance.getEntriesByType('navigation')[0]?.type === 'reload')
                  || (performance.navigation && performance.navigation.type === 1);
  if (isFreshLoad) {
    console.log('[OpsV] Content script injected after page reload');
  }

  document.addEventListener('selectionchange', () => {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const composer = findComposer();
        if (composer && composer.contains(range.commonAncestorContainer)) {
          lastSelectionRange = range.cloneRange();
        }
      }
    } catch (err) {
      // Ignore selection tracking errors
    }
  });

  // Auto-open companion sidepanel to establish WS connection
  try {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' }).catch(() => {});
  } catch {}

  // Notify background + sidepanel that this content-script instance just
  // bootstrapped. Sidepanel uses this to detect "the user refreshed Gemini
  // mid-task" and mark the in-flight task as interrupted instead of leaving
  // it hanging forever.
  try {
    chrome.runtime.sendMessage({
      type: 'CONTENT_READY',
      isFreshLoad,
      url: location.href,
      ts: Date.now(),
    }).catch(() => {});
  } catch {}

  // ── Conversation URL Watcher ──────────────────────────────────────────
  // Gemini changes URL from /app → /app/<convId> once a generation starts.
  // Capturing this lets the sidepanel (and Agent) recover after a refresh:
  // if we observed a convId before the page died, the result is still on
  // Gemini's server at that URL.
  let lastConvId = extractConvId(location.href);

  function extractConvId(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^\/app\/([a-zA-Z0-9_-]{6,})/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  function reportConvId(convId, source) {
    if (!convId || convId === lastConvId) return;
    lastConvId = convId;
    remoteLog(`Conversation URL detected: ${convId} (source=${source})`);
    try {
      chrome.runtime.sendMessage({
        type: 'CONV_URL_CHANGED',
        convId,
        url: location.href,
        ts: Date.now(),
        source,
      }).catch(() => {});
    } catch {}
  }

  // Probe immediately in case we landed on /app/<id> already.
  if (lastConvId) reportConvId(lastConvId, 'initial');

  // Monkey-patch pushState/replaceState so Gemini's SPA navigation triggers.
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function (...args) {
    const r = _push(...args);
    queueMicrotask(() => {
      const id = extractConvId(location.href);
      if (id) reportConvId(id, 'pushState');
      else if (lastConvId) {
        // URL moved off a convId (user opened new chat) — reset tracker
        lastConvId = null;
        remoteLog('Conversation URL cleared (new chat opened)');
      }
    });
    return r;
  };
  history.replaceState = function (...args) {
    const r = _replace(...args);
    queueMicrotask(() => {
      const id = extractConvId(location.href);
      if (id) reportConvId(id, 'replaceState');
      else if (lastConvId) {
        lastConvId = null;
        remoteLog('Conversation URL cleared (new chat)');
      }
    });
    return r;
  };
  window.addEventListener('popstate', () => {
    const id = extractConvId(location.href);
    if (id) reportConvId(id, 'popstate');
  });

  // ── Gemini Fresh-Conversation Probe ───────────────────────────────────
  // Reports back when the composer is empty AND no chat history is showing
  // — i.e. Gemini is sitting on a fresh "/app" (new chat) page. The sidepanel
  // uses this signal to mark the active batch as `gating → ready` so the
  // Agent can CONTINUE it.
  let lastFreshReported = false;
  function probeFreshConversation() {
    try {
      const composer = findComposer();
      const composerText = composer ? (composer.textContent || '').trim() : '__no_composer__';
      // Heuristic: composer empty + no images/preview chips in the input area.
      const composerEmpty = composer && composerText === '';
      const composerArea = composer?.closest('[class*="input"], [class*="composer"], [class*="container"]') || composer?.parentElement;
      const previewChips = composerArea ? composerArea.querySelectorAll('[class*="chip"], [class*="thumbnail"], [class*="attachment"] img').length : 0;
      const isFresh = composerEmpty && previewChips === 0;
      if (isFresh && !lastFreshReported) {
        lastFreshReported = true;
        remoteLog('Fresh conversation detected (composer empty, no preview chips)');
        chrome.runtime.sendMessage({
          type: 'GEMINI_TAB_READY',
          url: location.href,
          convId: lastConvId,
          ts: Date.now(),
        }).catch(() => {});
      } else if (!isFresh && lastFreshReported) {
        // Composer has content again — flip back so a fresh chat later re-fires.
        lastFreshReported = false;
        remoteLog('Fresh-conversation signal cleared (composer now has content)');
      }
    } catch (err) {
      // Best-effort probe; ignore failures.
    }
  }
  // Probe once at startup (in case the user opened a fresh tab before content.js injected).
  setTimeout(probeFreshConversation, 800);
  // Then keep probing every 2s so we catch the user opening new chat / clearing composer.
  setInterval(probeFreshConversation, 2000);

  // ── Remote Logger ──────────────────────────────────────────────────────
  function remoteLog(...args) {
    console.log('[OpsV]', ...args);
    try {
      chrome.runtime.sendMessage({
        type: 'REMOTE_LOG',
        message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
      }).catch(() => {});
    } catch {}
  }

  // ── Constants ──────────────────────────────────────────────────────────
  const DAEMON_HTTP = 'http://127.0.0.1:9700';
  const DAEMON_FILES = DAEMON_HTTP + '/files';
  const GENERATION_TIMEOUT_MS = 180000;
  const IMAGE_CHECK_INTERVAL_MS = 2000;
  const UPLOAD_CONFIRM_TIMEOUT_MS = 30000; // max wait per file for upload confirmation

  // Stop signal — set by STOP_JOB message, checked by all async loops
  let isStopped = false;

  function resetStop() { isStopped = false; }
  function requestStop() {
    isStopped = true;
    remoteLog('STOP requested by user');
  }

  // Build a /files URL, preserving leading slash for absolute paths
  function buildFileUrl(filePath) {
    let p = filePath.replace(/\/+/g, '/');
    if (p.startsWith('/')) {
      // Absolute path: double-slash so daemon preserves leading /
      return DAEMON_FILES + '/' + p;
    }
    if (!p.startsWith('/')) p = '/' + p;
    return DAEMON_FILES + p;
  }

  // Ensure Gemini tab has focus so clipboard operations work
  async function ensureFocused() {
    try {
      // First try: ask background to focus this tab/window
      const resp = await chrome.runtime.sendMessage({ type: 'FOCUS_TAB' });
      if (resp?.focused) remoteLog('Tab focused via background');
    } catch (e) {
      // Background focus not available (just activeTab), fall through
    }
    // Second try: focus window + document from content script
    window.focus();
    document.body?.focus();
    document.documentElement?.focus();
    await sleep(200);
  }

  // ── Message Listener ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'EXECUTE_JOB') {
      remoteLog('Received Job:', request.job.id);
      resetStop();
      runJob(request.job);
      sendResponse({ status: 'started' });
    } else if (request.type === 'STOP_JOB') {
      requestStop();
      sendResponse({ status: 'stopping' });
    } else if (request.type === 'CHECK_RESPONSE') {
      checkForResult().then(result => sendResponse(result));
      return true; // async response
    } else if (request.type === 'CHECK_LAST_IMAGE') {
      // Recovery: scan page for latest generated image
      checkForResult().then(result => sendResponse(result));
      return true;
    } else if (request.type === 'INJECT_PROMPT') {
      typePrompt(request.prompt, true).then(() => sendResponse({ status: 'done' }));
      return true;
    } else if (request.type === 'INJECT_REF_IMAGE') {
      uploadReferenceImage(request.fileUrl).then(() => sendResponse({ status: 'done' }));
      return true;
    } else if (request.type === 'INJECT_ALL') {
      runManualInjectAll(request.prompt, request.reference_files).then(() => sendResponse({ status: 'done' }));
      return true;
    }
  });

  async function runManualInjectAll(prompt, refFiles) {
    try {
      if (refFiles && refFiles.length > 0) {
        remoteLog(`Manually uploading ${refFiles.length} reference image(s)...`);
        for (const fileUrl of refFiles) {
          const ok = await uploadReferenceImage(fileUrl);
          if (!ok) {
            remoteLog(`Manual upload failed for image: ${fileUrl}`);
          }
          await sleep(1500);
        }
      }
      await typePrompt(prompt, true);
      remoteLog('Manual injection completed successfully');
    } catch (err) {
      remoteLog('Manual injection error:', err.message);
    }
  }

  // ── Main Job Runner ────────────────────────────────────────────────────
  async function runJob(job) {
    const shotId = job.id;
    const prompt = job.prompt || '';
    const refFiles = job.reference_files || [];

    try {
      // Step 1: Upload reference images if any
      if (refFiles.length > 0) {
        remoteLog(`Uploading ${refFiles.length} reference image(s)...`);
        // Per-file drag-drop. uploadViaDragDrop now waits for upload
        // confirmation (chip status / new img in composer) before returning.
        const ok = await uploadReferenceImagesBatch(refFiles);
        if (!ok) {
          if (isStopped) {
            remoteLog('Upload aborted by user stop');
            throw new Error('Stopped by user before upload completed');
          }
          throw new Error('Failed to upload reference images');
        }
        if (isStopped) {
          remoteLog('Stopped after upload but before prompt typing');
          throw new Error('Stopped by user');
        }
        remoteLog('All reference images uploaded and confirmed ready');
      }

      // Step 2: Type the prompt (now respects isStopped per char)
      await typePrompt(prompt, false);
      if (isStopped) throw new Error('Stopped by user during typing');

      // 模拟人类点击发送按钮前的短暂犹豫
      await sleep(1000 + Math.random() * 1000);
      if (isStopped) throw new Error('Stopped by user before send');

      // 关键时序优化：在点击发送前一瞬间，立即收集页面上所有已有的图片 URL (包括已上传的参考图)
      const excludeUrls = getExistingImageUrls();

      // Step 3: Click send
      await clickSend();
      if (isStopped) throw new Error('Stopped by user after send');

      // Step 4: Wait for generation
      const result = await waitForGeneration(excludeUrls);
      if (result) {
        remoteLog(`Generated image url: ${result.url}`);

        // Try to find a high-res download link (Gemini native download button)
        let bestUrl = result.url;
        if (result.element) {
          const highResUrl = findHighResDownloadUrl(result.element);
          if (highResUrl && !highResUrl.startsWith('javascript:')) {
            remoteLog('Found high-res download link:', highResUrl.substring(0, 60));
            bestUrl = highResUrl;
          } else if (bestUrl.includes('googleusercontent.com')) {
            const expanded = bestUrl.replace(/=(w|h|s|c)[0-9a-zA-Z\-_]+.*/, '=s4096-rj');
            if (expanded !== bestUrl) {
              remoteLog('Expanded googleusercontent URL for high-res:', expanded.substring(0, 60));
              bestUrl = expanded;
            }
          }
        }

        // 转换最佳质量的图片为 Base64
        const base64Data = await getBase64FromUrl(bestUrl);
        if (!base64Data) {
          throw new Error('Failed to extract generated image data to base64');
        }

        chrome.runtime.sendMessage({
          type: 'ASSET_SAVED',
          shotId,
          paths: [result.url],
          base64Data: base64Data
        });
      } else {
        throw new Error('No image generated within timeout');
      }
    } catch (err) {
      const reason = isStopped ? 'Stopped by user' : err.message;
      remoteLog(`Job ${shotId} failed:`, reason);
      chrome.runtime.sendMessage({
        type: 'JOB_FAILED',
        shotId,
        error: reason,
      });
    }
  }

  async function getBase64FromUrl(url) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      remoteLog('Error converting URL to Base64:', err.message);
      return null;
    }
  }

  // ── Reference Image Upload via Drag & Drop (primary) ──────────────────
  /**
   * Upload a single reference image by simulating a drag-and-drop on the Gemini composer.
   * Gemini natively handles dropped files and starts the upload process.
   * This avoids clipboard permission issues and user gesture requirements.
   */
  async function uploadReferenceImage(fileUrl) {
    try {
      // Step 1: Fetch the image from daemon
      let safePath = fileUrl.replace(/\\\\/g, '/');
      const httpUrl = buildFileUrl(safePath);
      remoteLog(`Fetching reference: ${httpUrl}`);
      const blob = await fetchImage(httpUrl);
      if (!blob) {
        remoteLog('Failed to fetch image');
        return false;
      }

      // Step 2: Find Gemini composer
      const composer = findComposer();
      if (!composer) {
        remoteLog('Composer not found');
        return false;
      }
      focusComposer(composer);
      await sleep(300);

      // Step 3: Upload via drag-and-drop
      const uploaded = await uploadViaDragDrop(blob, fileUrl.split('/').pop() || 'ref_image.png');
      if (uploaded) {
        remoteLog('Drag-drop upload successful');
        return true;
      }

      // Step 4: Fallback to synthetic paste event (no clipboard API needed)
      remoteLog('Drag-drop failed, trying synthetic paste...');
      const pasted = pasteFileIntoComposer(blob, fileUrl.split('/').pop() || 'ref_image.png');
      if (pasted) {
        await sleep(500);
        // CHANGED 2026-06-22: assume paste success (no chip wait)
        remoteLog('Synthetic paste dispatched (assuming success)');
        return true;
      }
      remoteLog('Synthetic paste also failed');
      return false;
    } catch (err) {
      remoteLog('uploadReferenceImage error:', err.message);
      return false;
    }
  }

  /**
   * Upload a blob to the Gemini composer.
   *
   * Strategy (try in order, fall back on failure):
   *   1. clipboard path: write image to system clipboard via navigator.clipboard.write,
   *      then document.execCommand('paste') into the focused composer.
   *      This is the path the user confirmed actually attaches images to Gemini.
   *   2. drag-drop path: dispatch synthetic dragenter/dragover/drop with a File in
   *      the DataTransfer. May or may not be honored by current Gemini build.
   *
   * After a successful paste we WAIT for the composer to actually contain a new
   * <img> (the uploaded preview). This is the real "upload complete" signal —
   * chip-based detection kept failing because Gemini's chip selector changes
   * with every release. Without this wait, typing the prompt starts while the
   * upload is still in-flight and Gemini drops the file.
   *
   * Returns true only if we observed a new <img> in the composer after paste.
   * Returns false on stop, on timeout, or if both upload strategies fail.
   */
  async function uploadViaDragDrop(blob, filename) {
    const composer = findComposer();
    if (!composer) {
      remoteLog('Upload: no composer found');
      return false;
    }
    const file = new File([blob], filename, { type: blob.type || 'image/png' });

    // Snapshot the composer's image count BEFORE we try to upload.
    // After upload, an <img> with the uploaded preview should appear.
    const preCount = composer.querySelectorAll('img').length;

    // The actual drop target is the page-wide chat-container with
    // `file-drop-zone` attribute. Angular's directive catches drops there.
    // Falling back to composer is the legacy path.
    const dropTarget = document.querySelector('[file-drop-zone]') || composer;

    // ── Strategy 1: clipboard write + execCommand('paste') ─────────────
    let pasted = false;
    try {
      // Focus window first — navigator.clipboard.write requires document focus.
      // We focus the window TWICE (with a delay) because Chrome may need a
      // moment after windows.update() to actually deliver focus to the page.
      await ensureFocused();
      await sleep(300);
      window.focus();
      document.body?.focus();
      // Bring composer into focus so execCommand targets the right element.
      composer.focus();
      await sleep(200);

      const item = new ClipboardItem({ [blob.type || 'image/png']: blob });
      await navigator.clipboard.write([item]);
      remoteLog(`Clipboard write ok for ${filename}, issuing execCommand('paste')`);

      // execCommand targets the focused contenteditable. Composer is focused above.
      const ok = document.execCommand('paste');
      remoteLog(`execCommand('paste') returned ${ok}`);

      // VERIFY that paste actually produced something in the input area.
      // If not, fall through to drag-drop / file-picker strategies.
      await sleep(800);
      const pasteCount = composer.querySelectorAll('img').length;
      const composerParent = composer.closest('[class*="input"], [class*="composer"], [class*="container"]') || composer.parentElement;
      const chipCount = composerParent ? composerParent.querySelectorAll('[class*="chip"], [class*="thumbnail"], [class*="attachment"] img').length : 0;
      if (pasteCount > preCount || chipCount > 0) {
        pasted = true;
        remoteLog(`Strategy 1 (clipboard paste) actually attached the file: composerImg=${pasteCount}, chips=${chipCount}`);
      } else {
        remoteLog(`Strategy 1 (clipboard paste) returned true but produced no visible image. Falling through.`);
      }
    } catch (err) {
      remoteLog(`Clipboard path failed for ${filename}: ${err.message}; trying ClipboardEvent fallback`);
      // Fallback: dispatch a synthetic ClipboardEvent with the File in
      // clipboardData. This does NOT require document focus (the page is
      // already past the user-gesture check once the user clicked Run).
      try {
        const file2 = new File([blob], filename, { type: blob.type || 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file2);
        const evt = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        composer.dispatchEvent(evt);
        remoteLog(`Dispatched synthetic paste ClipboardEvent with ${filename} (${(blob.size / 1024).toFixed(0)}KB)`);
        // Verify quickly — if no image/chip appeared, keep trying other strategies
        await sleep(800);
        const evtCount = composer.querySelectorAll('img').length;
        const evtParent = composer.closest('[class*="input"], [class*="composer"], [class*="container"]') || composer.parentElement;
        const evtChips = evtParent ? evtParent.querySelectorAll('[class*="chip"], [class*="thumbnail"], [class*="attachment"] img').length : 0;
        if (evtCount > preCount || evtChips > 0) {
          pasted = true;
          remoteLog(`ClipboardEvent fallback actually attached the file`);
        } else {
          remoteLog(`ClipboardEvent fallback dispatched but no visible image. Falling through.`);
        }
      } catch (evtErr) {
        remoteLog(`Synthetic paste ClipboardEvent also failed: ${evtErr.message}`);
      }
    }

    // ── Strategy 2: synthetic drag-drop on page-wide file-drop-zone ───
    // The drop target is the chat container (not composer) — Angular's
    // file-drop-zone directive handles the event there.
    if (!pasted) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        remoteLog(`Falling back to drag-drop on ${dropTarget.tagName}.${(dropTarget.className || '').toString().slice(0, 40)} for ${filename} (${(blob.size / 1024).toFixed(0)}KB)`);
        // Dispatch at window level so the event bubbles up to the directive.
        const dragenter = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true });
        const dragover = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
        const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        dropTarget.dispatchEvent(dragenter);
        await sleep(100);
        dropTarget.dispatchEvent(dragover);
        await sleep(100);
        dropTarget.dispatchEvent(drop);
        // Also dispatch on composer (some builds listen there).
        composer.dispatchEvent(dragenter);
        composer.dispatchEvent(dragover);
        composer.dispatchEvent(drop);
        // Wait briefly and verify
        await sleep(1000);
        const dragCount = composer.querySelectorAll('img').length;
        const dragParent = composer.closest('[class*="input"], [class*="composer"], [class*="container"]') || composer.parentElement;
        const dragChips = dragParent ? dragParent.querySelectorAll('[class*="chip"], [class*="thumbnail"], [class*="attachment"] img').length : 0;
        if (dragCount > preCount || dragChips > 0) {
          pasted = true;
          remoteLog(`Strategy 2 (drag-drop) attached file: $_opsvDragPreCheck`);
        } else {
          remoteLog(`Strategy 2 (drag-drop) dispatched but no visible image. Trying file-picker strategy.`);
        }
      } catch (err) {
        remoteLog(`Drag-drop fallback failed: ${err.message}`);
      }
    }

    // ── Strategy 3: inject <script> into MAIN WORLD to patch ─────────
    // ROOT CAUSE: Chrome content scripts run in an Isolated World.
    // Patching HTMLInputElement.prototype.click in content.js has NO effect
    // on Gemini's Angular code, which runs in the Main World.
    //
    // SOLUTION: Inject a <script> element into the page DOM. This runs
    // in the Main World and can patch the real HTMLInputElement.prototype.
    // We pass the file data via dataset attributes on the document element.
    if (!pasted) {
      try {
        const uploadBtn = document.querySelector('button[aria-label="上传和工具"]');
        if (uploadBtn) {
          remoteLog(`Injecting MAIN-WORLD patch for ${filename}`);

          let injected = false;

          // Convert file blob to base64 so we can pass it across worlds
          const b64 = await blobToBase64(file);
          const fileName = filename;
          const fileType = blob.type || 'image/png';

          // Set data on the document element for the injected script to read
          document.documentElement.dataset.opsvFileB64 = b64;
          document.documentElement.dataset.opsvFileName = fileName;
          document.documentElement.dataset.opsvFileType = fileType;

          // Inject <script> into the page — runs in MAIN WORLD
          const script = document.createElement('script');
          script.textContent = `
(function(){
  var b64 = document.documentElement.dataset.opsvFileB64;
  var fname = document.documentElement.dataset.opsvFileName;
  var ftype = document.documentElement.dataset.opsvFileType;
  if (!b64 || !fname) return;

  // Decode base64 → ArrayBuffer → Blob → File
  var binary = atob(b64);
  var buf = new ArrayBuffer(binary.length);
  var view = new Uint8Array(buf);
  for (var i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  var blob = new Blob([buf], { type: ftype });
  var file = new File([blob], fname, { type: ftype });

  var _origClick = HTMLInputElement.prototype.click;
  var _injected = false;
  HTMLInputElement.prototype.click = function() {
    if (this.type === 'file' && !_injected) {
      _injected = true;
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        Object.defineProperty(this, 'files', {
          value: dt.files, writable: true, configurable: true
        });
        this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        document.documentElement.dataset.opsvInjected = 'true';
        return;
      } catch(e) {
        document.documentElement.dataset.opsvInjected = 'err:' + e.message;
      }
    }
    _origClick.call(this);
  };

  // Auto-restore after 10s
  setTimeout(function(){
    HTMLInputElement.prototype.click = _origClick;
    delete document.documentElement.dataset.opsvFileB64;
    delete document.documentElement.dataset.opsvFileName;
    delete document.documentElement.dataset.opsvFileType;
  }, 10000);
})();
`;
          document.body.appendChild(script);
          script.remove(); // Remove the script element, but its side effects remain

          // Now click the button — Gemini's Angular calls fileInput.click()
          // which is now patched in the MAIN WORLD.
          remoteLog(`Clicking "上传和工具" button for ${filename}`);
          uploadBtn.click();

          // Poll for the injected flag from the main world
          for (let i = 0; i < 20; i++) {
            await sleep(250);
            const flag = document.documentElement.dataset.opsvInjected;
            if (flag === 'true') {
              injected = true;
              remoteLog(`[Strategy 3] MAIN-WORLD patch intercepted file input for ${fileName}`);
              break;
            } else if (flag && flag.startsWith('err:')) {
              remoteLog(`[Strategy 3] Main-world injection error: ${flag}`);
              break;
            }
          }

          if (!injected) {
            remoteLog(`[Strategy 3] MAIN-WORLD patch didn't fire`);
          }
        }
      } catch (err) {
        remoteLog(`Strategy 3 (main-world patch) failed: ${err.message}`);
      }
    }

    // ── Verify: wait for the upload preview <img> to appear in composer ──
    const confirmed = await waitForUploadedImg(composer, preCount, filename);
    if (!confirmed) {
      remoteLog(`Upload NOT confirmed for ${filename} (no new <img> appeared)`);
      return false;
    }
    remoteLog(`Upload confirmed for ${filename} (new <img> in composer)`);
    return true;
  }

  /**
   * Wait until the composer (or the broader input area) contains more
   * images than the pre-upload baseline, OR a chip/preview element appears.
   * Polling cheap (250ms).
   */
  async function waitForUploadedImg(composer, preCount, filename, timeoutMs = UPLOAD_CONFIRM_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isStopped) {
        remoteLog(`Upload wait aborted by stop (${filename})`);
        return false;
      }
      await sleep(250);

      // Strategy 1: composer area has new <img>
      const nowCount = composer ? composer.querySelectorAll('img').length : 0;
      if (nowCount > preCount) {
        remoteLog(`Composer img count grew ${preCount} → ${nowCount} for ${filename}`);
        return true;
      }

      // Strategy 2: any chip-like container with <img> inside the input area
      const composerParent = composer?.closest('[class*="input"], [class*="composer"], [class*="container"]') || composer?.parentElement;
      if (composerParent) {
        const chipImages = composerParent.querySelectorAll('[class*="chip"], [class*="thumbnail"], [class*="attachment"]');
        for (const c of chipImages) {
          if (c.querySelector('img')) {
            remoteLog(`Found uploaded preview chip with <img> for ${filename}`);
            return true;
          }
        }
      }

      // Strategy 3: NEW — check if the file is visible in the chat/input area
      // (Quill sometimes pastes inline img, and the upload preview may live
      // outside the strict contenteditable container).
      const inputArea = document.querySelector('[class*="input-area"], [class*="InputArea"]') || composerParent;
      if (inputArea) {
        const inputImgs = inputArea.querySelectorAll('img');
        if (inputImgs.length > preCount) {
          remoteLog(`Input area img count grew for ${filename}: ${preCount} → ${inputImgs.length}`);
          return true;
        }
        // Check for any preview/pending element (Quill uses .ql-preview or similar)
        const pendingEls = inputArea.querySelectorAll('[class*="preview"], [class*="pending"], [class*="uploading"], [class*="spinner"]');
        for (const el of pendingEls) {
          if (el.offsetParent !== null) {
            // Visible pending state means upload is in progress or just completed
            const hasImg = el.querySelector('img');
            if (hasImg) {
              remoteLog(`Found pending upload with <img> for ${filename}`);
              return true;
            }
          }
        }
      }

      // Strategy 4: any new attachment-like container appeared in the page
      // (Gemini may render the uploaded image in a separate panel above composer).
      const allImgsNow = document.querySelectorAll('img').length;
      const baselineImgs = window._opsvBaselineImgCount || 0;
      if (!baselineImgs && start < Date.now() - 500) {
        // After 500ms, set baseline
        if (!window._opsvBaselineImgCount) {
          window._opsvBaselineImgCount = document.querySelectorAll('img').length;
        }
      }
      if (baselineImgs && allImgsNow > baselineImgs) {
        // Hmm — global img count grew, but that might be the user's chat
        // history. Don't auto-success on this, but log it.
        // Skip — keep looking for a composer-local signal.
      }
    }
    remoteLog(`waitForUploadedImg timeout for ${filename} (preCount=${preCount}, now=${composer?.querySelectorAll('img').length || 0})`);
    return false;
  }

  async function fetchImage(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.blob();
    } catch (err) {
      remoteLog('fetchImage error:', err.message);
      return null;
    }
  }

  /** Convert a Blob to base64 data URL for passing across JS worlds */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // Result is "data:image/png;base64,iVBORw0..." — strip prefix
        const result = reader.result;
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // ── Batch Upload: per-file clipboard-paste (with real confirmation) ───
    /**
     * Upload each ref image one by one via clipboard paste + execCommand.
     *
     * Wait for EACH image to be confirmed uploaded (new <img> in composer)
     * before moving on — this prevents Gemini from discarding files when
     * the prompt typing replaces mid-flight uploads.
     *
     * If any single upload fails, abort the whole batch and return false —
     * no point proceeding to type a prompt with only partial refs.
     *
     * NOTE: compositeImagesToGrid is kept (commented out below) for future use.
     */
    async function uploadReferenceImagesBatch(fileUrls) {
      try {
        // Step 1: Download all blobs from daemon up front
        const blobs = [];
        for (const fileUrl of fileUrls) {
          let safePath = fileUrl.replace(/\\/g, '/');
          const httpUrl = buildFileUrl(safePath);
          remoteLog(`Fetching reference: ${httpUrl}`);
          const blob = await fetchImage(httpUrl);
          if (blob) {
            blobs.push(blob);
          } else {
            remoteLog(`Failed to fetch image: ${fileUrl}`);
          }
        }
        if (blobs.length === 0) {
          remoteLog('No reference images could be downloaded');
          return false;
        }
        if (blobs.length !== fileUrls.length) {
          remoteLog(`Partial fetch: ${blobs.length}/${fileUrls.length}; aborting batch`);
          return false;
        }
        remoteLog(`Downloaded ${blobs.length}/${fileUrls.length} reference images`);

        // Step 2: Paste each blob (one at a time, wait for confirmation)
        for (let i = 0; i < blobs.length; i++) {
          if (isStopped) {
            remoteLog(`Batch aborted by stop before file ${i + 1}`);
            return false;
          }
          const name = fileUrls[i] ? fileUrls[i].split('/').pop() : `ref_${i}.png`;
          remoteLog(`Pasting ${i + 1}/${blobs.length}: ${name} (${(blobs[i].size / 1024).toFixed(0)}KB)`);

          // Re-focus composer before each paste
          const composer = findComposer();
          if (composer) focusComposer(composer);

          const ok = await uploadViaDragDrop(blobs[i], name);
          if (!ok) {
            if (isStopped) {
              remoteLog(`Upload aborted by stop during file ${i + 1}`);
            } else {
              remoteLog(`Upload failed for file ${i + 1} (${name}); aborting batch`);
            }
            return false;
          }
          // Brief pause between successful uploads to let Gemini settle.
          await sleep(600);
        }
        remoteLog(`All ${blobs.length} reference images uploaded and confirmed`);
        return true;
      } catch (err) {
        remoteLog('uploadReferenceImagesBatch error:', err.message);
        return false;
      }
    }

  // COMPOSITE-BASED UPLOAD (TEMPORARILY DISABLED 2026-06-22 — per-file drag-drop
  // works reliably; composite was unreliable due to chip-detection failure.
  // Kept here for future reference and re-enablement.)
  // async function _unused_uploadReferenceImagesBatch_composite(fileUrls) {
  //   try {
  //     const blobs = [];
  //     for (const fileUrl of fileUrls) {
  //       let safePath = fileUrl.replace(/\\\\/g, '/');
  //       const httpUrl = buildFileUrl(safePath);
  //       remoteLog(`Fetching reference: ${httpUrl}`);
  //       const blob = await fetchImage(httpUrl);
  //       if (blob) blobs.push(blob);
  //     }
  //     if (blobs.length === 0) return false;
  //     const compositeBlob = await compositeImagesToGrid(blobs);
  //     if (!compositeBlob) {
  //       return await uploadFilesViaDragDrop(blobs, fileUrls);
  //     }
  //     const dragOk = await uploadViaDragDrop(compositeBlob, 'composite_ref_grid.png');
  //     if (dragOk) return true;
  //     const compositePasted = pasteFileIntoComposer(compositeBlob, 'composite_ref_grid.png');
  //     if (compositePasted) {
  //       await sleep(500);
  //     }
  //     return false;
  //   } catch (err) {
  //     return await uploadFilesViaDragDrop(blobs, fileUrls);
  //   }
  // }

  /**
   * Composite multiple images into a single grid (max 3 per row).
   */
  async function compositeImagesToGrid(blobs) {
    try {
      const images = await Promise.all(blobs.map(b => blobToImage(b)));
      const cols = Math.min(images.length, 3);
      const rows = Math.ceil(images.length / cols);
      const cellW = 400;
      const cellH = 400;
      const gap = 8;
      const canvas = document.createElement('canvas');
      canvas.width = cols * cellW + (cols - 1) * gap;
      canvas.height = rows * cellH + (rows - 1) * gap;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < images.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * (cellW + gap);
        const y = row * (cellH + gap);
        const img = images[i];
        const scale = Math.min(cellW / img.naturalWidth, cellH / img.naturalHeight);
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        ctx.drawImage(img, x + (cellW - drawW) / 2, y + (cellH - drawH) / 2, drawW, drawH);
      }
      return new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
    } catch (err) {
      remoteLog('compositeImagesToGrid error:', err.message);
      return null;
    }
  }

  /**
   * Fallback: upload each blob via per-file drag-drop.
   */
  async function uploadFilesViaDragDrop(blobs, fileUrls) {
    let anyOk = false;
    for (let i = 0; i < blobs.length; i++) {
      const name = fileUrls[i] ? fileUrls[i].split('/').pop() : `ref_${i}.png`;
      const ok = await uploadViaDragDrop(blobs[i], name);
      if (ok) anyOk = true;
      await sleep(2000); // space between uploads
    }
    return anyOk;
  }

  async function copyImageToClipboard(blob) {
    try {
      // Use Clipboard API to write image
      const item = new ClipboardItem({ [blob.type]: blob });
      await navigator.clipboard.write([item]);
      remoteLog('Image copied to clipboard');
      return true;
    } catch (err) {
      remoteLog('Clipboard write failed:', err.message);
      // Fallback: create a canvas, draw, and try copy
      try {
        const img = await blobToImage(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Use toBlob with PNG for broader clipboard support
        const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const item = new ClipboardItem({ 'image/png': pngBlob });
        await navigator.clipboard.write([item]);
        remoteLog('Image copied as PNG to clipboard');
        return true;
      } catch (err2) {
        remoteLog('Clipboard write fallback also failed:', err2.message);
        return false;
      }
    }
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  /**
   * Paste image into Gemini composer.
   * Relies on copyImageToClipboard having already written to system clipboard.
   * Gemini's own paste handler reads from system clipboard — synthetic
   * ClipboardEvents with inline data are less reliable.
   */
  async function pasteIntoComposer(composer) {
    // Focus the composer first
    composer.focus();
    await sleep(200);

    // Method 1: Dispatch Ctrl+V keydown (Gemini picks up from system clipboard)
    const isMac = navigator.platform.includes('Mac');
    const ctrlKey = !isMac;
    const metaKey = isMac;

    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', keyCode: 86,
      ctrlKey, metaKey, bubbles: true, cancelable: true,
    }));

    // Method 2: document.execCommand('paste') reads from system clipboard
    try {
      document.execCommand('paste');
    } catch (e) {
      remoteLog('execCommand paste failed:', e.message);
    }

    await sleep(1000);
    return true;
  }

  /**
   * Paste a File directly into the Gemini composer via synthetic ClipboardEvent.
   * Does NOT use navigator.clipboard.write() — avoids content-script focus restrictions.
   * Gemini's paste handler reads event.clipboardData.files and starts upload.
   */
  function pasteFileIntoComposer(blob, filename) {
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    });

    const composer = findComposer();
    if (!composer) return false;
    composer.dispatchEvent(pasteEvent);
    remoteLog(`Dispatched synthetic paste event with ${filename} (${(blob.size / 1024).toFixed(0)}KB)`);
    return true;
  }

  async function waitForUploadPreview(expectedBlob, timeoutMs = 30000) {
    const start = Date.now();
    let chipFound = false;

    while (Date.now() - start < timeoutMs) {
      await sleep(1000);

      const chip = findUploadChip();
      if (!chip) {
        if (chipFound) return true; // chip was there, now gone = upload complete & merged into composer
        continue;
      }

      chipFound = true;

      // Check upload status on the chip
      const status = getUploadChipStatus(chip);
      remoteLog(`Upload chip status: ${status}`);

      if (status === 'error') {
        remoteLog('Upload chip shows error state');
        return false;
      }

      if (status === 'ready') {
        remoteLog('Upload chip ready');
        return true;
      }

      // status === 'uploading' — keep waiting
    }

    // Timeout: if we at least found a chip, consider it ready
    return chipFound;
  }

  /**
   * Wait for the just-dropped file to be confirmed uploaded.
   *
   * Multi-strategy (each strategy is a heuristic — we use the FIRST one that
   * gives a clear signal, otherwise fall through to the next):
   *
   *   1. chip is found with status='ready' (class on the chip)
   *   2. composer area contains an <img> whose src starts with a data: URL
   *      (Gemini's uploaded preview uses a blob: URL — once it shows in
   *       the composer, the upload is complete)
   *   3. chip was found earlier and is now gone (Gemini removed the chip
   *      after merging the image into the composer body)
   *
   * The detection is polling-based (cheap 200ms) with a max timeout.
   * Returns true if any strategy says "ready", false on timeout.
   */
  async function waitForUploadComplete(expectedBlob, timeoutMs = UPLOAD_CONFIRM_TIMEOUT_MS) {
    const start = Date.now();
    let chipEverSeen = false;
    let preDropImgCount = 0;
    const composer = findComposer();
    if (composer) {
      preDropImgCount = composer.querySelectorAll('img').length;
    }

    while (Date.now() - start < timeoutMs) {
      if (isStopped) {
        remoteLog('Upload wait aborted by stop');
        return false;
      }
      await sleep(200);

      // Strategy 1: explicit ready chip
      const chip = findUploadChip();
      if (chip) {
        chipEverSeen = true;
        const status = getUploadChipStatus(chip);
        if (status === 'ready') {
          remoteLog('Upload ready (chip status)');
          return true;
        }
        if (status === 'error') {
          remoteLog('Upload failed (chip error status)');
          return false;
        }
        // 'uploading' → keep waiting
        continue;
      }

      // Strategy 2: chip gone after being seen = upload completed & merged
      if (chipEverSeen) {
        remoteLog('Upload ready (chip disappeared, merged)');
        return true;
      }

      // Strategy 3: composer has a new <img> (data: or blob: src)
      if (composer) {
        const imgs = composer.querySelectorAll('img');
        if (imgs.length > preDropImgCount) {
          remoteLog('Upload ready (new img in composer)');
          return true;
        }
      }
    }

    remoteLog(`Upload confirmation timed out after ${timeoutMs}ms (chipEverSeen=${chipEverSeen})`);
    return false;
  }

  /**
   * Find the upload chip / thumbnail in the composer area.
   * Gemini renders pasted images as attachment chips before upload completes.
   */
  function findUploadChip() {
    const selectors = [
      // Gemini-specific attachment chip selectors
      '[data-attachment-chip]',
      '[class*="attachment-chip"]',
      '[class*="AttachmentChip"]',
      '[class*="upload-chip"]',
      // Image thumbnails in the input area
      '[class*="image-preview"]',
      '[class*="ImagePreview"]',
      '.upload-progress',
      '[class*="upload-progress"]',
      // Generic: img inside the composer/input area (not in responses)
      'rich-textarea img',
      'div[contenteditable="true"] img',
      // Fallback: any new image element
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        // Make sure it's in the input area, not a response
        if (!el.closest('[data-test-id="response"]') &&
            !el.closest('[class*="response"]') &&
            !el.closest('message-content')) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Determine the upload state of a chip element.
   * Returns: 'uploading' | 'ready' | 'error'
   */
  function getUploadChipStatus(chip) {
    // Check for loading/progress indicators
    const loadingIndicators = [
      'mat-progress-bar',
      '[role="progressbar"]',
      '[class*="progress"]',
      '[class*="loading"]',
      '[class*="spinner"]',
      'mat-spinner',
      '.mat-progress-spinner',
      'svg[class*="circular"]',
      '[aria-label*="Loading"]',
      '[aria-label*="upload" i]',
      '[aria-label*="Upload" i]',
    ];

    for (const sel of loadingIndicators) {
      const indicator = chip.querySelector(sel) || chip.closest(sel);
      if (indicator) {
        // Check if it's actually visible/active
        const style = window.getComputedStyle(indicator);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return 'uploading';
        }
      }
    }

    // Check for error state
    const errorIndicators = [
      '[class*="error"]',
      '[class*="Error"]',
      '[aria-label*="error" i]',
      '[aria-label*="failed" i]',
      '.mat-chip-error',
    ];

    for (const sel of errorIndicators) {
      const indicator = chip.querySelector(sel) || chip.closest(sel);
      if (indicator) {
        const style = window.getComputedStyle(indicator);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return 'error';
        }
      }
    }

    // If the chip has an img that's fully loaded, consider it ready
    const img = chip.tagName === 'IMG' ? chip : chip.querySelector('img');
    if (img && img.complete && img.naturalWidth > 50) {
      return 'ready';
    }

    // Default: assume uploading if we have a chip but can't determine state
    return 'uploading';
  }

  // ── Typing ─────────────────────────────────────────────────────────────
  // ── Typing ─────────────────────────────────────────────────────────────
  async function typePrompt(text, isManual = false) {
    const composer = findComposer();
    if (!composer) throw new Error('Could not find Gemini composer');

    // 如果是手动模式注入，我们在记忆的或当前的光标位置直接插入
    if (isManual) {
      remoteLog('Manual injection: Attempting to insert prompt at cursor position.');
      if (lastSelectionRange) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(lastSelectionRange);
        } catch (e) {
          remoteLog('Failed to restore last selection range:', e.message);
        }
      }
      
      // 让输入框重新获得焦点，使选区生效
      composer.focus();
      
      document.execCommand('insertText', false, text);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      
      // 更新记忆的光标位置
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          lastSelectionRange = sel.getRangeAt(0).cloneRange();
        }
      } catch (e) {}
      
      await sleep(150);
      return;
    }

    // ── 自动模式：清空并模拟人类打字 ───────────────────────────────────────
    focusComposer(composer);
    await sleep(300);

    const currentText = (composer.textContent || '').trim();
    remoteLog(`Current composer text content: "${currentText}"`);

    if (currentText !== text.trim()) {
      if (currentText.length > 0) {
        remoteLog('Composer has existing text. Clearing text nodes only...');
        clearTextNodesOnly(composer);
        await sleep(200);
      }

      focusComposer(composer);
      // 打字前的短暂起势停顿
      await sleep(500 + Math.random() * 500);

      remoteLog(`Starting human-like typing simulation for prompt (${text.length} chars)...`);
      
      // 逐字符键入并添加延迟和抖动以模拟真人输入
      for (let i = 0; i < text.length; i++) {
        if (isStopped) {
          remoteLog('Typing aborted by stop signal at char ' + i);
          return;
        }
        const char = text[i];
        document.execCommand('insertText', false, char);
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        
        let delay = 15 + Math.random() * 20; // 降低默认打字速度以更加拟真
        if (char === '.' || char === ',' || char === '!' || char === '?' || char === '\n' || char === '。' || char === '，' || char === '！' || char === '？') {
          // 标点符号或换行时额外停顿（模拟人类停顿思考）
          delay += 200 + Math.random() * 200;
        } else if (Math.random() < 0.05) {
          // 5% 概率产生打字迟疑
          delay += 100 + Math.random() * 150;
        }
        await sleep(delay);
      }

      // 模拟人类打完字后在结尾处按一下空格（如果 prompt 结尾不是空格）
      if (!text.endsWith(' ')) {
        await sleep(300 + Math.random() * 300);
        document.execCommand('insertText', false, ' ');
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
      }

      composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await sleep(200);

      const newText = (composer.textContent || '').trim();
      if (!newText.includes(text.trim())) {
        remoteLog('Character typing validation failed. Using fallback textNode modification...');
        const textNode = getLatestTextNode(composer);
        if (textNode) {
          textNode.nodeValue = text;
        } else {
          composer.textContent = text;
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        await sleep(300);
      }
    } else {
      remoteLog('Prompt text already present in composer');
    }

    await sleep(500);
    remoteLog('Prompt typing finished');
  }

  function getLatestTextNode(container) {
    let targetNode = null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      targetNode = walker.currentNode;
    }
    return targetNode;
  }

  function clearTextNodesOnly(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    for (const tn of textNodes) {
      tn.nodeValue = '';
    }
  }

  function findComposer() {
    const selectors = [
      'rich-textarea [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      '#c-input',
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest('[data-test-id="response"]')) {
        return el;
      }
    }
    return null;
  }

  function focusComposer(composer) {
    composer.focus();
    let targetNode = getLatestTextNode(composer);

    if (!targetNode) {
      let p = composer.querySelector('p');
      if (!p) {
        p = document.createElement('p');
        composer.appendChild(p);
      }
      targetNode = document.createTextNode('');
      p.appendChild(targetNode);
    }

    const range = document.createRange();
    range.selectNode(targetNode);
    range.collapse(false); // end of text node

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Send Button ─────────────────────────────────────────────────────────
  async function clickSend() {
    const btn = findSendButton();
    if (!btn) throw new Error('Could not find send button');
    remoteLog('Clicking send...');
    btn.click();
    await sleep(2000);
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[aria-label="发送消息"]',
      'button[aria-label="发送"]',
      '.send-button',
      '[data-test-id="send-button"]',
      'button[type="submit"]',
      // Generic: last button in the input area
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.disabled) return el;
    }
    return null;
  }

  function findUploadButton() {
    const selectors = [
      'button[aria-label="Upload image"]',
      'button[aria-label*="upload" i]',
      'button[aria-label*="Upload" i]',
      '[data-test-id="upload-button"]',
      '[class*="upload-button"]',
      'button:has(svg)',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findHiddenFileInput() {
    // Look for file inputs anywhere, including shadow DOM
    const all = document.querySelectorAll('input[type="file"]');
    if (all.length > 0) return all[0];

    // Search shadow DOMs
    const walkShadow = (root, depth) => {
      if (depth > 5) return null;
      const inputs = root.querySelectorAll('input[type="file"]');
      if (inputs.length > 0) return inputs[0];
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) {
          const found = walkShadow(el.shadowRoot, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    return walkShadow(document, 0);
  }

  // ── Generation Monitoring ──────────────────────────────────────────────
  async function waitForGeneration(passedExcludeUrls = null) {
    const start = Date.now();
    remoteLog('Waiting for image generation...');

    // 若未传入已有的排查集合，则退回实时收集
    const excludeUrls = passedExcludeUrls || getExistingImageUrls();
    remoteLog(`Using ${excludeUrls.size} excluded image(s) for generation detection`);

    while (Date.now() - start < GENERATION_TIMEOUT_MS) {
      await sleep(IMAGE_CHECK_INTERVAL_MS);

      try {
        // 提取符合生成大图条件的最新图片
        const result = extractLatestImage(excludeUrls);
        if (result) {
          remoteLog(`Successfully detected new generated image: ${result.url}`);
          return result;
        }
      } catch (err) {
        remoteLog(`Error in extractLatestImage: ${err.message}`);
      }

      // 同时也检查页面上是否有生成失败的错误文字
      const errorText = document.querySelector('[class*="error"]');
      if (errorText && errorText.textContent.includes('unable to generate')) {
        throw new Error('Gemini reported unable to generate');
      }
    }

    return null;
  }

  function getExistingImageUrls() {
    const urls = new Set();
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      if (img.src && (img.src.startsWith('http') || img.src.startsWith('blob:'))) {
        urls.add(img.src);
      }
    }
    return urls;
  }

  function extractLatestImage(excludeUrls = new Set()) {
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    let bestScore = 0;

    for (const img of imgs) {
      if (!img.src) continue;
      const src = img.src;

      if (!src.startsWith('http') && !src.startsWith('blob:')) continue;
      if (excludeUrls.has(src)) continue;

      const isComplete = img.complete;
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const isImageBtn = img.closest('.image-button') || (img.classList && img.classList.contains('image-button'));

      remoteLog(`Detected new image: src=${src.slice(0, 60)}... complete=${isComplete} size=${width}x${height} isImageBtn=${!!isImageBtn}`);

      const lowerSrc = src.toLowerCase();
      if (lowerSrc.includes('avatar') || lowerSrc.includes('profile') || lowerSrc.includes('logo') || lowerSrc.includes('icon')) {
        continue;
      }

      if (width < 100 && !isImageBtn) continue;

      const score = (width || 200) * (height || 200);
      if (score > bestScore) {
        bestScore = score;
        best = img;
      }
    }

    if (best) {
      remoteLog(`Selected best generated image: src=${best.src.slice(0, 60)}... size=${best.naturalWidth}x${best.naturalHeight}`);
      return {
        url: best.src,
        width: best.naturalWidth || 512,
        height: best.naturalHeight || 512,
        element: best,
      };
    }
    return null;
  }

  // ── Utils ──────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Result Check (for sidepanel polling & recovery) ────────────────────
  async function checkForResult() {
    remoteLog('Running detailed result check...');
    const imgs = Array.from(document.querySelectorAll('img'));
    remoteLog(`Found ${imgs.length} images on page.`);

    // Iterate backwards (latest images first)
    for (let i = imgs.length - 1; i >= 0; i--) {
      const img = imgs[i];
      if (!img.src || !img.src.startsWith('http')) continue;

      const info = `[${i}] Src: ${img.src.substring(0, 30)}... Complete: ${img.complete} NatW: ${img.naturalWidth}`;
      
      if (img.complete && img.naturalWidth > 200) {
        remoteLog('Found preview image:', info);

        // Try to find a high-res download link nearby
        const highResUrl = findHighResDownloadUrl(img);
        if (highResUrl) {
          remoteLog('Found native high-res download link:', highResUrl.substring(0, 60));
          const base64Data = await getBase64FromUrl(highResUrl);
          if (base64Data) {
            return { hasNewImage: true, imageUrl: highResUrl, base64Data };
          }
        }

        // Heuristic fallback: expand googleusercontent URL
        let finalUrl = img.src;
        if (finalUrl.includes('googleusercontent.com')) {
          finalUrl = finalUrl.replace(/=(w|h|s|c)[0-9a-zA-Z\-_]+.*/, '=s4096-rj');
          remoteLog('Heuristic expansion:', finalUrl.substring(0, 60));
          const base64Data = await getBase64FromUrl(finalUrl);
          if (base64Data) {
            return { hasNewImage: true, imageUrl: finalUrl, base64Data };
          }
        }

        // Fallback: use the image src directly
        const base64Data = await getBase64FromUrl(img.src);
        if (base64Data) {
          return { hasNewImage: true, imageUrl: img.src, base64Data };
        }
        return { hasNewImage: true, imageUrl: img.src };
      }
    }

    remoteLog('No completed result found in recent images.');
    return { hasNewImage: false, imageCount: imgs.length };
  }

  /**
   * Search 8 levels up from an image element for a high-res download link.
   * Gemini often nests download buttons inside the image container.
   */
  function findHighResDownloadUrl(img) {
    let container = img.parentElement;
    for (let k = 0; k < 8; k++) {
      if (!container) break;
      const anchors = Array.from(container.querySelectorAll('a[href]'));
      const realLink = anchors.find(a => {
        const label = (a.getAttribute('aria-label') || '').toLowerCase();
        const tooltip = (a.getAttribute('data-tooltip') || '').toLowerCase();
        return a.hasAttribute('download') ||
               label.includes('download') || label.includes('下载') ||
               tooltip.includes('download') || tooltip.includes('下载');
      });
      if (realLink) return realLink.href;
      container = container.parentElement;
    }
    return null;
  }

  // ── Intercept Drag & Drop from Sidepanel ───────────────────────────────
  document.addEventListener('dragover', (e) => {
    try {
      const types = e.dataTransfer.types;
      const isUrl = types.includes('text/uri-list') || types.includes('text/plain');
      if (isUrl) {
        e.preventDefault();
      }
    } catch {}
  }, true);

  document.addEventListener('drop', async (e) => {
    try {
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (url && url.startsWith('http://127.0.0.1:9700/files/')) {
        e.preventDefault();
        e.stopPropagation();
        remoteLog(`Detected local reference image drop: ${url}`);
        const parts = url.split('/files/');
        if (parts.length > 1) {
          const fileUrl = decodeURIComponent(parts[1]);
          await uploadReferenceImage(fileUrl);
        }
      }
    } catch (err) {
      remoteLog('Error handling drag-drop intercept:', err.message);
    }
  }, true);

  remoteLog('content.js loaded and ready');
})();
