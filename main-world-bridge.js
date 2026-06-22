// Main-World Bridge — runs in MAIN world (loaded via content_scripts[] with NO world specified = default MAIN since it's loaded via <script src=>).
//
// When content.js (isolated world) needs to patch MAIN world APIs, it
// posts a message to this bridge via window.postMessage. This bridge
// applies the patch in the MAIN world where Gemini's Angular code lives.
//
// Communication protocol:
//   content.js → main-world:
//     window.postMessage({ source: 'opsv-content', cmd: 'PATCH_INPUT_CLICK', b64, name, type }, '*');
//   main-world → content.js (via same channel):
//     window.postMessage({ source: 'opsv-mainworld', event: 'INJECTED' }, '*');
//
// Auto-restoration: patches revert after 10s to avoid permanent modifications.

(function() {
  // Listen for patches from content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'opsv-content') return;

    if (event.data.cmd === 'PATCH_INPUT_CLICK') {
      const b64 = event.data.b64;
      const fname = event.data.name;
      const ftype = event.data.type;
      if (!b64 || !fname) return;

      // Decode base64 → ArrayBuffer → Blob → File
      const binary = atob(b64);
      const buf = new ArrayBuffer(binary.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
      const blob = new Blob([buf], { type: ftype });
      const file = new File([blob], fname, { type: ftype });

      const _origClick = HTMLInputElement.prototype.click;
      let _injected = false;
      HTMLInputElement.prototype.click = function() {
        if (this.type === 'file' && !_injected) {
          _injected = true;
          try {
            const dt = new DataTransfer();
            dt.items.add(file);
            Object.defineProperty(this, 'files', {
              value: dt.files, writable: true, configurable: true,
            });
            this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            window.postMessage({ source: 'opsv-mainworld', event: 'INJECTED', name: fname }, '*');
            return;
          } catch (e) {
            window.postMessage({ source: 'opsv-mainworld', event: 'ERROR', error: String(e), name: fname }, '*');
          }
        }
        _origClick.call(this);
      };

      // Auto-restore after 10s
      setTimeout(() => {
        HTMLInputElement.prototype.click = _origClick;
      }, 10000);
    }
  });

  console.log('[OpsV MainWorldBridge] Initialized');
})();