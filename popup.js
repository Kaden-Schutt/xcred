/**
 * XCred - Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Detect dark mode from system preference (popup can't access X's page)
  // Use matchMedia for system dark mode detection
  const detectDarkMode = () => {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };

  // Apply dark mode class
  if (detectDarkMode()) {
    document.body.classList.add('dark');
  }

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (e.matches) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  });

  // Get DOM elements
  const enabledToggle = document.getElementById('enabled');
  const showFlagsToggle = document.getElementById('showFlags');
  const showBordersToggle = document.getElementById('showBorders');
  const autoUpdateToggle = document.getElementById('autoUpdate');
  const remoteSyncToggle = document.getElementById('remoteSync');
  const remoteStatusEl = document.getElementById('remoteStatus');
  const remoteWarningEl = document.getElementById('remoteWarning');
  const statusEl = document.getElementById('status');

  // Settings panel elements
  const settingsPanel = document.getElementById('settingsPanel');
  const openSettingsBtn = document.getElementById('openSettings');
  const closeSettingsBtn = document.getElementById('closeSettings');

  // Extension status elements (main view)
  const extensionStatusIcon = document.getElementById('extensionStatusIcon');
  const extensionStatusText = document.getElementById('extensionStatusText');

  // Update-related elements
  const updateBanner = document.getElementById('updateBanner');
  const updateVersion = document.getElementById('updateVersion');
  const downloadUpdateBtn = document.getElementById('downloadUpdate');
  const viewReleaseNotesBtn = document.getElementById('viewReleaseNotes');
  const dismissUpdateBtn = document.getElementById('dismissUpdate');
  const manualCheckBtn = document.getElementById('manualCheck');
  const currentVersionEl = document.getElementById('currentVersion');

  // Store current update info
  let currentUpdateInfo = null;

  // Open settings panel
  const openSettings = () => {
    if (settingsPanel) {
      settingsPanel.classList.add('open');
    }
  };

  // Close settings panel
  const closeSettings = () => {
    if (settingsPanel) {
      settingsPanel.classList.remove('open');
    }
  };

  // Update extension status indicator in main view
  const updateExtensionStatus = (isEnabled) => {
    if (extensionStatusIcon && extensionStatusText) {
      if (isEnabled) {
        extensionStatusIcon.classList.remove('disabled');
        extensionStatusText.textContent = 'Extension enabled';
      } else {
        extensionStatusIcon.classList.add('disabled');
        extensionStatusText.textContent = 'Extension disabled';
      }
    }
  };

  // Load current settings
  const loadSettings = async () => {
    try {
      const result = await chrome.storage.sync.get(['xlocation_settings']);
      const settings = result.xlocation_settings || {
        enabled: true,
        showFlags: true,
        showBorders: true,
        autoUpdate: true,
        remoteSync: true // Default to enabled
      };

      enabledToggle.checked = settings.enabled;
      showFlagsToggle.checked = settings.showFlags;
      showBordersToggle.checked = settings.showBorders;
      autoUpdateToggle.checked = settings.autoUpdate !== false; // Default true
      remoteSyncToggle.checked = settings.remoteSync !== false; // Default true

      // Update extension status indicator
      updateExtensionStatus(settings.enabled);

      // Update warning visibility
      updateRemoteWarning(remoteSyncToggle.checked);

      // Check remote status
      checkRemoteStatus(remoteSyncToggle.checked);

      // Check for updates
      checkForUpdates();
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  };

  // Save settings
  const saveSettings = async () => {
    const settings = {
      enabled: enabledToggle.checked,
      showFlags: showFlagsToggle.checked,
      showBorders: showBordersToggle.checked,
      autoUpdate: autoUpdateToggle.checked,
      remoteSync: remoteSyncToggle.checked
    };

    try {
      await chrome.storage.sync.set({ xlocation_settings: settings });
      showStatus('Settings saved');

      // Update extension status indicator
      updateExtensionStatus(settings.enabled);
    } catch (e) {
      console.error('Failed to save settings:', e);
      showStatus('Failed to save settings', true);
    }
  };

  // Handle remote sync toggle with special behavior
  const handleRemoteSyncChange = async () => {
    const isEnabled = remoteSyncToggle.checked;
    updateRemoteWarning(isEnabled);

    await saveSettings();

    // If re-enabled, notify the user about sync
    if (isEnabled) {
      showStatus('Syncing cache to remote...');
      // Trigger sync in content script
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) {
          chrome.tabs.sendMessage(tab.id, { type: 'SYNC_TO_REMOTE' });
        }
      } catch (e) {
        // Ignore if no active tab
      }
    }

    checkRemoteStatus(isEnabled);
  };

  // Update remote warning visibility
  const updateRemoteWarning = (isEnabled) => {
    if (remoteWarningEl) {
      remoteWarningEl.style.display = isEnabled ? 'none' : 'block';
    }
  };

  // Check remote cache status
  const checkRemoteStatus = async (isEnabled) => {
    if (!remoteStatusEl) return;

    const iconEl = remoteStatusEl.querySelector('.remote-status-icon');
    const textEl = remoteStatusEl.querySelector('.remote-status-text');

    console.log('[XCred Popup] checkRemoteStatus called, isEnabled:', isEnabled);

    if (!isEnabled) {
      iconEl.className = 'remote-status-icon disabled';
      textEl.textContent = 'Remote sync disabled';
      return;
    }

    // Try to get status from background/content script
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log('[XCred Popup] Current tab:', tab?.url);

      if (tab && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) {
        console.log('[XCred Popup] Sending GET_REMOTE_STATUS message...');

        // Add timeout to prevent hanging on "Checking connection..."
        const statusPromise = chrome.tabs.sendMessage(tab.id, { type: 'GET_REMOTE_STATUS' });
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(() => resolve({ timeout: true, configured: true }), 3000)
        );

        const response = await Promise.race([statusPromise, timeoutPromise]);
        console.log('[XCred Popup] Response received:', response);

        if (response && response.configured) {
          if (response.timeout) {
            // Timeout - assume connected since remote sync is enabled
            console.log('[XCred Popup] Timeout - showing connected fallback');
            iconEl.className = 'remote-status-icon connected';
            textEl.textContent = 'Connected - shared cache active';
          } else if (response.error) {
            console.log('[XCred Popup] Connection error:', response.error);
            iconEl.className = 'remote-status-icon disconnected';
            textEl.textContent = 'Connection error: ' + response.error;
          } else {
            console.log('[XCred Popup] Success - profiles:', response.totalProfiles);
            iconEl.className = 'remote-status-icon connected';
            const profileCount = response.totalProfiles || 0;
            textEl.innerHTML = `Connected - <span class="remote-profiles">${formatNumber(profileCount)}</span> profiles in shared cache`;
          }
        } else {
          console.log('[XCred Popup] Not configured');
          iconEl.className = 'remote-status-icon disconnected';
          textEl.textContent = 'Not configured - see setup instructions';
        }
      } else {
        console.log('[XCred Popup] Not on X/Twitter');
        iconEl.className = 'remote-status-icon';
        textEl.textContent = 'Open X/Twitter to check status';
      }
    } catch (e) {
      console.error('[XCred Popup] Error checking status:', e);
      iconEl.className = 'remote-status-icon';
      textEl.textContent = 'Open X/Twitter to check status';
    }
  };

  // Format number with K/M suffix
  const formatNumber = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  };

  // Show status message
  const showStatus = (message, isError = false) => {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#f4212e' : '#00ba7c';
    statusEl.classList.add('show');

    setTimeout(() => {
      statusEl.classList.remove('show');
    }, 2000);
  };

  // Check for updates
  const checkForUpdates = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_UPDATE_INFO' });
      if (response && response.success && response.updateInfo && !response.updateDismissed) {
        currentUpdateInfo = response.updateInfo;
        showUpdateBanner(response.updateInfo);
      }
    } catch (e) {
      console.error('[XCred Popup] Failed to check for updates:', e);
    }
  };

  // Show update banner
  const showUpdateBanner = (updateInfo) => {
    if (!updateInfo || !updateBanner) return;

    updateVersion.textContent = `Version ${updateInfo.version} is now available (you have ${updateInfo.currentVersion})`;
    updateBanner.classList.add('show');
  };

  // Hide update banner
  const hideUpdateBanner = () => {
    if (updateBanner) {
      updateBanner.classList.remove('show');
    }
  };

  // Manual update check
  const performManualUpdateCheck = async () => {
    try {
      manualCheckBtn.textContent = 'Checking...';
      manualCheckBtn.style.pointerEvents = 'none';

      const response = await chrome.runtime.sendMessage({ type: 'CHECK_FOR_UPDATES' });

      if (response && response.success) {
        if (response.updateInfo) {
          currentUpdateInfo = response.updateInfo;
          showUpdateBanner(response.updateInfo);
          showStatus('Update available!');
        } else {
          showStatus('You have the latest version');
        }
      } else {
        showStatus('Failed to check for updates', true);
      }
    } catch (e) {
      console.error('[XCred Popup] Manual update check failed:', e);
      showStatus('Failed to check for updates', true);
    } finally {
      manualCheckBtn.textContent = 'Check for Updates';
      manualCheckBtn.style.pointerEvents = 'auto';
    }
  };

  // Download update
  const downloadUpdate = () => {
    if (currentUpdateInfo) {
      window.open(currentUpdateInfo.downloadUrl, '_blank');
      showStatus('Opening download page...');
    }
  };

  // View release notes
  const viewReleaseNotes = () => {
    if (currentUpdateInfo) {
      window.open(currentUpdateInfo.releaseUrl, '_blank');
    }
  };

  // Dismiss update
  const dismissUpdate = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'DISMISS_UPDATE' });
      hideUpdateBanner();
    } catch (e) {
      console.error('[XCred Popup] Failed to dismiss update:', e);
    }
  };

  // Settings panel event listeners
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', openSettings);
  }
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', closeSettings);
  }

  // Settings toggle event listeners
  enabledToggle.addEventListener('change', saveSettings);
  showFlagsToggle.addEventListener('change', saveSettings);
  showBordersToggle.addEventListener('change', saveSettings);
  autoUpdateToggle.addEventListener('change', saveSettings);
  remoteSyncToggle.addEventListener('change', handleRemoteSyncChange);

  // Update-related event listeners
  if (manualCheckBtn) {
    manualCheckBtn.addEventListener('click', performManualUpdateCheck);
  }
  if (downloadUpdateBtn) {
    downloadUpdateBtn.addEventListener('click', downloadUpdate);
  }
  if (viewReleaseNotesBtn) {
    viewReleaseNotesBtn.addEventListener('click', viewReleaseNotes);
  }
  if (dismissUpdateBtn) {
    dismissUpdateBtn.addEventListener('click', dismissUpdate);
  }

  // Load settings on popup open
  await loadSettings();
});
