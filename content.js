// Content Script for Gemini — with reference image clipboard paste upload
// ============================================================================
(function () {
  if (window.hasOpsVContentScript) {
    console.log('OpsV Automation Script already loaded. Skipping.');
    return;
  }
  window.hasOpsVContentScript = true;

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
    }
  });

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
      await typePrompt(prompt);

      // Step 3: Click send
      await clickSend();

      // Step 4: Wait for generation
      const result = await waitForGeneration();
      if (result) {
        remoteLog(`Generated image: ${result.url}`);
        chrome.runtime.sendMessage({
          type: 'ASSET_SAVED',
          shotId,
          paths: [result.url],
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

  // ── Reference Image Upload via Clipboard ───────────────────────────────
  async function uploadReferenceImage(fileUrl) {
    try {
      // Step 1: Fetch the image from daemon
      remoteLog(`Fetching reference: ${fileUrl}`);
      const blob = await fetchImage(fileUrl);
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
  async function typePrompt(text) {
    const composer = findComposer();
    if (!composer) throw new Error('Could not find Gemini composer');

    focusComposer(composer);
    await sleep(300);

    // Clear existing content
    composer.innerHTML = '';

    // Bulk insert first, then simulate typing for the textarea to register
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    await sleep(200);

    // Trigger a final space + backspace to ensure Gemini registers the input
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await sleep(100);
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    await sleep(500);
    remoteLog('Prompt typed');
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
    // Range at end
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
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
  async function waitForGeneration() {
    const start = Date.now();
    remoteLog('Waiting for image generation...');

    // Watch DOM for new images
    let lastImageCount = countGeneratedImages();

    while (Date.now() - start < GENERATION_TIMEOUT_MS) {
      await sleep(IMAGE_CHECK_INTERVAL_MS);
      const currentCount = countGeneratedImages();

      if (currentCount > lastImageCount) {
        // New image appeared — wait a bit for it to fully load
        await sleep(3000);
        const result = extractLatestImage();
        if (result) return result;
        lastImageCount = currentCount;
      }

      // Also check response text for error indicators
      const errorText = document.querySelector('[class*="error"]');
      if (errorText && errorText.textContent.includes('unable to generate')) {
        throw new Error('Gemini reported unable to generate');
      }
    }

    return null;
  }

  function countGeneratedImages() {
    // Count images in response area (not in input/composer)
    const responses = document.querySelectorAll('[data-test-id="response"], [class*="response-container"] img');
    return responses.length;
  }

  function extractLatestImage() {
    const imgs = Array.from(document.querySelectorAll('img'));
    // Find the largest, most complete image that's not tiny (likely generated)
    let best = null;
    let bestScore = 0;

    for (const img of imgs) {
      if (!img.src || !img.src.startsWith('http')) continue;
      if (!img.complete || img.naturalWidth < 200) continue;

      // Score by size and position
      const score = img.naturalWidth * img.naturalHeight;
      if (score > bestScore) {
        bestScore = score;
        best = img;
      }
    }

    if (best) {
      return {
        url: best.src,
        width: best.naturalWidth,
        height: best.naturalHeight,
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

  remoteLog('content.js loaded and ready');
})();
