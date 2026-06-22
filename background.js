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
// Also handle FOCUS_TAB to bring Gemini tab to foreground for clipboard
// Also: PAGE_REFRESHED broadcast — content script notifies background when it
// detects a fresh page load (location.href or content-script re-injection),
// so sidepanel can stop any in-flight job that was wiped by the refresh.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'REMOTE_LOG') {
    sendResponse({ received: true });
    return true;
  }
  if (request.type === 'FOCUS_TAB' && sender.tab?.id) {
    chrome.tabs.update(sender.tab.id, { active: true }).then(() => {
      if (sender.tab?.windowId) {
        return chrome.windows.update(sender.tab.windowId, { focused: true });
      }
    }).then(() => sendResponse({ focused: true })).catch((err) => {
      console.error('[OpsV BG] Focus failed:', err);
      sendResponse({ focused: false });
    });
    return true;
  }
  // content-script bootstrap signal: send back whether background knows about
  // an in-flight job. If yes, sidepanel can prompt user to retry it after refresh.
  if (request.type === 'CONTENT_READY') {
    // Echo the bootstrap event out so the sidepanel can react to "the user
    // refreshed Gemini mid-task" — there's no direct WS path from content
    // script to sidepanel, so we route through native-host via a WS bridge:
    // background can't talk to native-host, so the sidepanel watches its own
    // tab events instead. We still ACK so the content script knows we got it.
    sendResponse({ received: true, ts: Date.now() });
    return true;
  }
  // Conversation URL changed on Gemini page (e.g. /app → /app/<convId>).
  // Broadcast to all extension pages so the sidepanel can record the convId
  // on the active batch for later recovery.
  if (request.type === 'CONV_URL_CHANGED') {
    chrome.runtime.sendMessage({
      type: 'CONV_URL_CHANGED',
      convId: request.convId,
      url: request.url,
      ts: request.ts,
      source: request.source,
    }).catch(() => {});
    sendResponse({ received: true });
    return true;
  }
  // Gemini composer is empty + no preview chips → fresh conversation.
  // Sidepanel flips active batch from 'gating' → 'ready' so Agent can CONTINUE.
  if (request.type === 'GEMINI_TAB_READY') {
    chrome.runtime.sendMessage({
      type: 'GEMINI_TAB_READY',
      url: request.url,
      convId: request.convId,
      ts: request.ts,
    }).catch(() => {});
    sendResponse({ received: true });
    return true;
  }
  // Sidepanel forwards a "content-script bootstrapped" event into the WS
  // so daemon + sidepanel see it. This lets sidepanel notice Gemini refresh.
  if (request.type === 'CONTENT_BOOTSTRAP_BRIDGE') {
    // No-op for now — kept as hook for future daemon↔sidepanel handshake.
    sendResponse({ received: true });
    return true;
  }
  // OPEN_SIDEPANEL removed: chrome.sidePanel.open() requires a user gesture,
  // and tool-bar click already opens the panel via setPanelBehavior above.
});
