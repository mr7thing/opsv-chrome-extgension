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
  const DAEMON_FILES = 'http://127.0.0.1:9700/files/';
  const GENERATION_TIMEOUT_MS = 180000;
  const IMAGE_CHECK_INTERVAL_MS = 2000;

  // ── Message Listener ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'EXECUTE_JOB') {
      remoteLog('Received Job:', request.job.id);
      runJob(request.job);
      sendResponse({ status: 'started' });
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
        // Try batch upload (composite to single grid then drag-drop)
        const ok = await uploadReferenceImagesBatch(refFiles);
        if (!ok) {
          throw new Error('Failed to upload reference images');
        }
        remoteLog('All reference images uploaded and confirmed ready');
      }

      // Step 2: Type the prompt
      await typePrompt(prompt, false);

      // 模拟人类点击发送按钮前的短暂犹豫
      await sleep(1000 + Math.random() * 1000);

      // 关键时序优化：在点击发送前一瞬间，立即收集页面上所有已有的图片 URL (包括已上传的参考图)
      const excludeUrls = getExistingImageUrls();

      // Step 3: Click send
      await clickSend();

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
      remoteLog(`Job ${shotId} failed:`, err.message);
      chrome.runtime.sendMessage({
        type: 'JOB_FAILED',
        shotId,
        error: err.message,
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
      if (!safePath.startsWith('/')) safePath = '/' + safePath;
      const httpUrl = DAEMON_FILES + safePath;
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

      // Step 4: Fallback to clipboard paste (v0.4 working approach)
      remoteLog('Drag-drop failed, trying clipboard paste...');
      await copyImageToClipboard(blob);
      const composer2 = findComposer();
      if (composer2) {
        focusComposer(composer2);
        await sleep(500);
        await pasteIntoComposer(composer2, blob);
        await waitForUploadPreview(blob);
        remoteLog('Clipboard upload preview confirmed');
        return true;
      }
      remoteLog('Clipboard paste fallback also failed');
      return false;
    } catch (err) {
      remoteLog('uploadReferenceImage error:', err.message);
      return false;
    }
  }

  /**
   * Simulate a file drop on the composer element.
   * Creates a proper DragEvent with a DataTransfer containing the image File.
   */
  async function uploadViaDragDrop(blob, filename) {
    try {
      const composer = findComposer();
      if (!composer) return false;

      // Create a File object from the blob
      const file = new File([blob], filename, { type: blob.type || 'image/png' });
      
      // Create DataTransfer with the file
      const dt = new DataTransfer();
      dt.items.add(file);

      remoteLog(`Simulating drag-drop for ${filename} (${(blob.size / 1024).toFixed(0)}KB)`);

      // Dispatch drag events in sequence (what Gemini expects)
      composer.dispatchEvent(new DragEvent('dragenter', {
        dataTransfer: dt, bubbles: true, cancelable: true
      }));
      await sleep(100);

      composer.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: dt, bubbles: true, cancelable: true
      }));
      await sleep(100);

      composer.dispatchEvent(new DragEvent('drop', {
        dataTransfer: dt, bubbles: true, cancelable: true
      }));
      await sleep(500);

      // Step 4: Wait for upload preview to appear
      const confirmed = await waitForUploadPreview(blob);
      if (confirmed) {
        remoteLog('Drag-drop upload preview confirmed');
        return true;
      }

      remoteLog('Drag-drop: no upload preview detected');
      return false;
    } catch (err) {
      remoteLog('uploadViaDragDrop error:', err.message);
      return false;
    }
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

  // ── Batch Upload: composite + drag-drop ────────────────────────────────
  /**
   * Batch upload multiple reference images by compositing into a single grid image.
   * Gemini only keeps the last pasted/dropped image, so we merge all refs into one.
   * Then uploads the composite via drag-and-drop (no clipboard/user gesture needed).
   */
  async function uploadReferenceImagesBatch(fileUrls) {
    try {
      // Step 1: Download all blobs from daemon
      const blobs = [];
      for (const fileUrl of fileUrls) {
        let safePath = fileUrl.replace(/\\\\/g, '/');
        if (!safePath.startsWith('/')) safePath = '/' + safePath;
        const httpUrl = DAEMON_FILES + safePath;
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
      remoteLog(`Downloaded ${blobs.length}/${fileUrls.length} reference images`);

      // Step 2: Composite all images into a single grid image
      const compositeBlob = await compositeImagesToGrid(blobs);
      if (!compositeBlob) {
        remoteLog('Composite failed, trying per-file drag-drop...');
        return await uploadFilesViaDragDrop(blobs, fileUrls);
      }
      remoteLog(`Composite image: ${compositeBlob.size} bytes`);

      // Step 3: Upload the single composite via drag-drop
      const dragOk = await uploadViaDragDrop(compositeBlob, 'composite_ref_grid.png');
      if (dragOk) return true;

      // Fallback: upload each image via clipboard paste
      remoteLog('Batch drag-drop failed, trying clipboard paste for each image...');
      for (let i = 0; i < blobs.length; i++) {
        const name = fileUrls[i] ? fileUrls[i].split('/').pop() : `ref_${i}.png`;
        await copyImageToClipboard(blobs[i]);
        const composerCb = findComposer();
        if (composerCb) {
          focusComposer(composerCb);
          await sleep(500);
          await pasteIntoComposer(composerCb, blobs[i]);
          await waitForUploadPreview(blobs[i]);
          remoteLog(`Clipboard uploaded image ${i+1}/${blobs.length}: ${name}`);
        }
        await sleep(2000);
      }
      return true;
    } catch (err) {
      remoteLog('uploadReferenceImagesBatch error:', err.message);
      return await uploadFilesViaDragDrop(blobs, fileUrls);
    }
  }

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
   * Paste image into Gemini composer by constructing a ClipboardEvent
   * with the blob data inline — no system clipboard read needed.
   */
  async function pasteIntoComposer(composer, blob) {
    // Focus the composer first
    composer.focus();
    await sleep(200);

    // Method 1 (preferred): Dispatch ClipboardEvent with the blob data inline.
    // This avoids needing user gesture for navigator.clipboard.read().
    if (blob) {
      try {
        const dt = new DataTransfer();
        const file = new File([blob], 'ref_image.png', { type: blob.type || 'image/png' });
        dt.items.add(file);

        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });

        composer.dispatchEvent(pasteEvent);
        await sleep(800);
        remoteLog('Inline ClipboardEvent dispatched with blob data');
        return true;
      } catch (err) {
        remoteLog('Inline ClipboardEvent failed:', err.message);
      }
    }

    // Method 2: Dispatch Ctrl+V keydown (triggers Gemini's paste handler)
    const isMac = navigator.platform.includes('Mac');
    const ctrlKey = !isMac;
    const metaKey = isMac;

    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', keyCode: 86,
      ctrlKey, metaKey, bubbles: true, cancelable: true,
    }));

    // Method 3: Attempt to read clipboard and re-dispatch (may fail without gesture)
    try {
      const clipboardItems = await navigator.clipboard.read();
      if (clipboardItems.length > 0) {
        const item = clipboardItems[0];
        const types = item.types;

        for (const type of types) {
          const blobItem = await item.getType(type);
          const pe = new ClipboardEvent('paste', {
            bubbles: true, cancelable: true,
            clipboardData: new DataTransfer(),
          });
          try { pe.clipboardData.items.add(blobItem, type); } catch {}
          composer.dispatchEvent(pe);
        }
      }
    } catch (err) {
      remoteLog('Clipboard read fallback error:', err.message);
    }

    // Method 4: execCommand paste (deprecated but kept as last resort)
    try {
      document.execCommand('paste');
    } catch {}

    await sleep(1000);
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
