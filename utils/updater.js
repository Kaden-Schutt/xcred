/**
 * Auto-update utility for XCred Chrome Extension
 * Checks GitHub releases for new versions and manages update notifications
 */

const GITHUB_API_URL = 'https://api.github.com/repos/Kaden-Schutt/xcred/releases/latest';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
const CURRENT_VERSION = '1.1.1'; // Will be synced with manifest.json

/**
 * Compare two semantic version strings
 * @param {string} current - Current version (e.g., "1.1.1")
 * @param {string} latest - Latest version (e.g., "1.2.0")
 * @returns {number} - Returns 1 if latest > current, 0 if equal, -1 if current > latest
 */
function compareVersions(current, latest) {
  const currentParts = current.replace(/^v/, '').split('.').map(Number);
  const latestParts = latest.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (latestPart > currentPart) return 1;
    if (latestPart < currentPart) return -1;
  }

  return 0;
}

/**
 * Check GitHub releases for the latest version
 * @returns {Promise<Object|null>} Update info or null if no update available
 */
async function checkForUpdates() {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      console.warn('[XCred Update] Failed to check for updates:', response.status);
      return null;
    }

    const release = await response.json();
    const latestVersion = release.tag_name || release.name;

    if (!latestVersion) {
      console.warn('[XCred Update] No version info in release');
      return null;
    }

    // Compare versions
    const comparison = compareVersions(CURRENT_VERSION, latestVersion);

    if (comparison === 1) {
      // New version available
      const zipAsset = release.assets.find(asset =>
        asset.name.endsWith('.zip') && asset.name.toLowerCase().includes('xcred')
      );

      return {
        version: latestVersion,
        currentVersion: CURRENT_VERSION,
        downloadUrl: zipAsset ? zipAsset.browser_download_url : release.html_url,
        releaseUrl: release.html_url,
        releaseNotes: release.body || 'No release notes available',
        publishedAt: release.published_at,
        hasDirectDownload: !!zipAsset
      };
    }

    console.log('[XCred Update] Already on latest version:', CURRENT_VERSION);
    return null;

  } catch (error) {
    console.error('[XCred Update] Error checking for updates:', error);
    return null;
  }
}

/**
 * Get stored update information
 * @returns {Promise<Object|null>}
 */
async function getStoredUpdateInfo() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['updateInfo', 'lastUpdateCheck', 'updateDismissed'], (result) => {
      resolve({
        updateInfo: result.updateInfo || null,
        lastUpdateCheck: result.lastUpdateCheck || 0,
        updateDismissed: result.updateDismissed || false
      });
    });
  });
}

/**
 * Store update information
 * @param {Object} updateInfo - Update information to store
 * @param {boolean} dismissed - Whether the update notification was dismissed
 */
async function storeUpdateInfo(updateInfo, dismissed = false) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      updateInfo: updateInfo,
      lastUpdateCheck: Date.now(),
      updateDismissed: dismissed
    }, resolve);
  });
}

/**
 * Clear stored update information (after successful update)
 */
async function clearUpdateInfo() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(['updateInfo', 'updateDismissed'], resolve);
  });
}

/**
 * Check if we should check for updates (based on interval)
 * @returns {Promise<boolean>}
 */
async function shouldCheckForUpdates() {
  const { lastUpdateCheck } = await getStoredUpdateInfo();
  const timeSinceLastCheck = Date.now() - lastUpdateCheck;
  return timeSinceLastCheck >= UPDATE_CHECK_INTERVAL;
}

/**
 * Perform update check and store results
 * @param {boolean} force - Force check even if within interval
 * @returns {Promise<Object|null>} Update info if available
 */
async function performUpdateCheck(force = false) {
  if (!force && !(await shouldCheckForUpdates())) {
    const { updateInfo } = await getStoredUpdateInfo();
    return updateInfo;
  }

  console.log('[XCred Update] Checking for updates...');
  const updateInfo = await checkForUpdates();

  if (updateInfo) {
    console.log('[XCred Update] New version available:', updateInfo.version);
    await storeUpdateInfo(updateInfo, false);

    // Show notification badge
    chrome.action.setBadgeText({ text: '1' });
    chrome.action.setBadgeBackgroundColor({ color: '#1DA1F2' });
  } else {
    await storeUpdateInfo(null, false);
    chrome.action.setBadgeText({ text: '' });
  }

  return updateInfo;
}

/**
 * Dismiss update notification
 */
async function dismissUpdate() {
  const { updateInfo } = await getStoredUpdateInfo();
  if (updateInfo) {
    await storeUpdateInfo(updateInfo, true);
    chrome.action.setBadgeText({ text: '' });
  }
}

// Export functions for use in background.js and popup.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    checkForUpdates,
    compareVersions,
    performUpdateCheck,
    getStoredUpdateInfo,
    dismissUpdate,
    clearUpdateInfo,
    CURRENT_VERSION
  };
}
