// Background Service Worker — OPSV Companion Extension
// ============================================================================

// Side panel behavior
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[OpsV BG]', error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('[OpsV BG] Companion installed');
});

// Forward REMOTE_LOG from content script to sidepanel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'REMOTE_LOG') {
    // Already handled by sidepanel's listener, just acknowledge
    sendResponse({ received: true });
    return true;
  }
  // OPEN_SIDEPANEL removed: chrome.sidePanel.open() requires a user gesture,
  // and tool-bar click already opens the panel via setPanelBehavior above.
});
