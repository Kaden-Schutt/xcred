/**
 * XCred - Background Service Worker
 * Handles API requests and message passing
 */

// Default settings
const DEFAULT_SETTINGS = {
  enabled: true,
  showFlags: true,
  showBorders: true,
  debugMode: false
};

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[XCred] Extension installed:', details.reason);

  if (details.reason === 'install') {
    // Set default settings
    await chrome.storage.sync.set({ xlocation_settings: DEFAULT_SETTINGS });
    console.log('[XCred] Default settings initialized');
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[XCred] Received message:', message.type);

  switch (message.type) {
    case 'GET_SETTINGS':
      chrome.storage.sync.get(['xlocation_settings'], (result) => {
        sendResponse(result.xlocation_settings || DEFAULT_SETTINGS);
      });
      return true; // Keep channel open for async response

    case 'SAVE_SETTINGS':
      chrome.storage.sync.set({ xlocation_settings: message.settings }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'CLEAR_CACHE':
      // Send message to content script to clear IndexedDB cache
      chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_CACHE' });
        });
        sendResponse({ success: true });
      });
      return true;

    case 'GET_STATS':
      // Could be extended to track usage statistics
      sendResponse({
        profilesProcessed: 0,
        cacheHits: 0,
        cacheMisses: 0
      });
      return true;

    default:
      console.warn('[XCred] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

// Handle extension icon click (optional - popup handles main interaction)
chrome.action.onClicked.addListener((tab) => {
  // This won't fire if we have a popup, but kept for reference
  console.log('[XCred] Extension icon clicked');
});

// Clean up old cache entries periodically
chrome.alarms.create('cleanupCache', {
  periodInMinutes: 60 // Run every hour
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cleanupCache') {
    console.log('[XCred] Running cache cleanup');
    // Send cleanup message to active X tabs
    chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'CLEANUP_CACHE' }).catch(() => {
          // Tab might not have content script loaded
        });
      });
    });
  }
});

console.log('[XCred] Background service worker loaded');
