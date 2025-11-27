/**
 * XCred - Background Service Worker
 * Handles API requests and message passing
 */

// Import updater utility
importScripts('utils/updater.js');

// Default settings
const DEFAULT_SETTINGS = {
  enabled: true,
  showFlags: true,
  showBorders: true,
  debugMode: false,
  autoUpdate: true // Enable auto-update checks by default
};

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[XCred] Extension installed:', details.reason);

  if (details.reason === 'install') {
    // Set default settings
    await chrome.storage.sync.set({ xlocation_settings: DEFAULT_SETTINGS });
    console.log('[XCred] Default settings initialized');

    // Check for updates on first install
    const settings = DEFAULT_SETTINGS;
    if (settings.autoUpdate) {
      performUpdateCheck(true).catch(err => {
        console.error('[XCred] Initial update check failed:', err);
      });
    }
  } else if (details.reason === 'update') {
    // Extension was updated - clear update notification
    console.log('[XCred] Extension updated from', details.previousVersion, 'to', CURRENT_VERSION);
    clearUpdateInfo();
    chrome.action.setBadgeText({ text: '' });
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

    case 'CHECK_FOR_UPDATES':
      // Manual update check triggered from popup
      performUpdateCheck(true)
        .then(updateInfo => {
          sendResponse({ success: true, updateInfo });
        })
        .catch(error => {
          console.error('[XCred] Update check failed:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'GET_UPDATE_INFO':
      // Get stored update information
      getStoredUpdateInfo()
        .then(result => {
          sendResponse({ success: true, ...result });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'DISMISS_UPDATE':
      // Dismiss update notification
      dismissUpdate()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
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

// Check for updates periodically (every 6 hours)
chrome.alarms.create('checkForUpdates', {
  periodInMinutes: 360 // Run every 6 hours
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
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
  } else if (alarm.name === 'checkForUpdates') {
    console.log('[XCred] Running periodic update check');
    // Check if auto-update is enabled
    const result = await chrome.storage.sync.get(['xlocation_settings']);
    const settings = result.xlocation_settings || DEFAULT_SETTINGS;

    if (settings.autoUpdate) {
      performUpdateCheck(false).catch(err => {
        console.error('[XCred] Periodic update check failed:', err);
      });
    }
  }
});

console.log('[XCred] Background service worker loaded');
