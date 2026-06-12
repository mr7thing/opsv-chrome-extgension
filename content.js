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
        for (const fileUrl of refFiles) {
          const ok = await uploadReferenceImage(fileUrl);
          if (!ok) {
            throw new Error(`Failed to upload reference: ${fileUrl}`);
          }
          await sleep(2000);
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
        
        // 转换 blob: 为 Base64 传递给后台
        const base64Data = await getBase64FromUrl(result.url);
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

  // ── Reference Image Upload via Clipboard ───────────────────────────────
  async function uploadReferenceImage(fileUrl) {
    try {
      // Step 1: Fetch the image from daemon
      let safePath = fileUrl.replace(/\\/g, '/');
      if (!safePath.startsWith('/')) safePath = '/' + safePath;
      const httpUrl = DAEMON_FILES + safePath;
      remoteLog(`Fetching reference: ${httpUrl}`);
      const blob = await fetchImage(httpUrl);
      if (!blob) {
        remoteLog('Failed to fetch image');
        return false;
      }

      // Step 2: Copy to clipboard as image
      await copyImageToClipboard(blob);

      // Step 3: Find and focus Gemini input
      const composer = findComposer();
      if (!composer) {
        remoteLog('Composer not found');
        return false;
      }
      focusComposer(composer);

      // Step 4: Paste
      await sleep(500);
      const pasted = await pasteIntoComposer(composer);
      if (pasted) {
        remoteLog('Paste successful');

        // Step 5: Wait for upload preview to appear
        await waitForUploadPreview(blob);
        remoteLog('Upload preview confirmed');
        return true;
      }

      // Fallback: Try clicking the upload button
      remoteLog('Clipboard paste not detected, trying upload button...');
      const uploadBtn = findUploadButton();
      if (uploadBtn) {
        uploadBtn.click();
        await sleep(1000);

        // After clicking upload, Gemini may open a file picker
        // Check if there's a hidden file input we can use
        const fileInput = findHiddenFileInput();
        if (fileInput) {
          const file = new File([blob], 'ref_image.png', { type: blob.type || 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));

          // Wait for upload preview with status tracking
          const uploaded = await waitForUploadPreview(blob);
          if (uploaded) {
            remoteLog('File input upload confirmed');
            return true;
          }
        }
      }

      remoteLog('All upload methods failed');
      return false;
    } catch (err) {
      remoteLog('uploadReferenceImage error:', err.message);
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

  async function pasteIntoComposer(composer) {
    // Method 1: Focus and trigger Ctrl+V
    composer.focus();
    await sleep(200);

    // Dispatch keydown for Ctrl+V / Cmd+V
    const isMac = navigator.platform.includes('Mac');
    const ctrlKey = !isMac;
    const metaKey = isMac;

    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', keyCode: 86,
      ctrlKey, metaKey, bubbles: true, cancelable: true,
    }));

    // Also dispatch paste event with clipboard data for rich text editors
    try {
      const clipboardItems = await navigator.clipboard.read();
      if (clipboardItems.length > 0) {
        const item = clipboardItems[0];
        const types = item.types;

        for (const type of types) {
          const blob = await item.getType(type);
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: new DataTransfer(),
          });

          // Try to add the data to clipboardData
          try {
            pasteEvent.clipboardData.items.add(blob, type);
          } catch {
            // DataTransfer items might be read-only in some contexts
          }

          composer.dispatchEvent(pasteEvent);
        }
      }
    } catch (err) {
      remoteLog('Clipboard read in paste fallback error:', err.message);
    }

    // Method 2: document.execCommand('paste')
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
      };
    }
    return null;
  }

  // ── Utils ──────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Result Check (for sidepanel polling) ───────────────────────────────
  async function checkForResult() {
    return {
      imageCount: countGeneratedImages(),
      hasNewImage: false,
    };
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
