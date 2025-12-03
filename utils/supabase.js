/**
 * Supabase Remote Cache for XCred (READ-ONLY)
 * All writes now go through the API validation server
 * This client only provides read access to validated profile data
 */

const XLocationRemote = {
  // Configuration
  SUPABASE_URL: 'https://fltltydwaaveotuzlnxb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_ez4XpVROziphVz9uiKvjPg_Q-beTTxM',
  // NOTE: Anon key now only has SELECT permissions (writes go through API)

  // Cache settings
  REMOTE_CACHE_DURATION: 7 * 24 * 60 * 60 * 1000, // 7 days (same as local)
  BATCH_SIZE: 50, // Max profiles to sync at once

  // State
  isEnabled: true, // Default on per user's preference
  isConfigured: false,
  lastSyncTime: null,
  syncInProgress: false,
  remoteStats: { totalProfiles: 0 },

  /**
   * Initialize the remote cache client
   */
  init() {
    // Check if Supabase is configured
    this.isConfigured = this.SUPABASE_URL !== 'YOUR_SUPABASE_URL' &&
                        this.SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';

    if (!this.isConfigured) {
      return false;
    }

    // Load enabled state from storage
    this.loadSettings();

    return true;
  },

  /**
   * Load remote sync settings from storage
   */
  async loadSettings() {
    try {
      const result = await chrome.storage.sync.get(['xlocation_settings', 'xlocation_initial_sync_done']);
      if (result.xlocation_settings) {
        // Default to true if not explicitly set
        this.isEnabled = result.xlocation_settings.remoteSync !== false;
      }

      // Trigger initial sync if enabled and never synced before
      if (this.isEnabled && this.isConfigured && !result.xlocation_initial_sync_done) {
        // Mark as synced first to prevent duplicate syncs
        await chrome.storage.sync.set({ xlocation_initial_sync_done: true });
        // Delay slightly to let the page load
        setTimeout(() => this.syncLocalToRemote(), 3000);
      }
    } catch (e) {
      // Settings load failed, use defaults
    }
  },

  /**
   * Save remote sync enabled state
   */
  async setEnabled(enabled) {
    this.isEnabled = enabled;
    try {
      const result = await chrome.storage.sync.get(['xlocation_settings']);
      const settings = result.xlocation_settings || {};
      settings.remoteSync = enabled;
      await chrome.storage.sync.set({ xlocation_settings: settings });
      // Note: Writes now go through API, no local-to-remote sync needed
    } catch (e) {
      // Settings save failed
    }
  },

  /**
   * Build Supabase REST API URL
   */
  buildUrl(table, query = '') {
    return `${this.SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  },

  /**
   * Get headers for Supabase requests
   */
  getHeaders(options = {}) {
    const headers = {
      'apikey': this.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${this.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    };
    // Add Prefer header if specified
    if (options.prefer) {
      headers['Prefer'] = options.prefer;
    }
    return headers;
  },

  // ========== CONSENSUS TRACKING ==========

  /**
   * Check if profile exists in Supabase
   * @param {string} username - The username to check
   * @returns {Promise<boolean>} Whether profile exists
   */
  async exists(username) {
    if (!this.isConfigured) return false;

    try {
      const key = username.toLowerCase();
      const url = this.buildUrl('profiles', `username=eq.${encodeURIComponent(key)}&select=username`);

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) return false;

      const data = await response.json();
      return data && data.length > 0;
    } catch (e) {
      return false;
    }
  },

  /**
   * Check if Supabase data is stale (older than threshold)
   * @param {Object} data - Profile data with timestamp
   * @param {number} maxAgeHours - Max age in hours (default 24)
   * @returns {boolean} Whether data is stale
   */
  isStale(data, maxAgeHours = 24) {
    if (!data || !data.timestamp) return true;
    const age = Date.now() - data.timestamp;
    return age > (maxAgeHours * 60 * 60 * 1000);
  },

  /**
   * INSERT new profile - DEPRECATED
   * Writes now go through API validation server
   * @deprecated Use XCredAPI.requestValidation() instead
   */
  async insert(username, profileData) {
    console.warn('[XCred] Direct Supabase writes disabled - use API validation');
    return false;
  },

  /**
   * MERGE update from consensus - DEPRECATED
   * Writes now go through API validation server
   * @deprecated Use XCredAPI.requestValidation() instead
   */
  async mergeFromConsensus(username, data, consensusCount) {
    console.warn('[XCred] Direct Supabase writes disabled - use API validation');
    return false;
  },

  /**
   * Fetch a profile from remote cache
   * @param {string} username - The username to look up
   * @returns {Promise<object|null>} Cached data or null if not found/expired
   */
  async get(username) {
    if (!this.isEnabled || !this.isConfigured) {
      return null;
    }

    try {
      const key = username.toLowerCase();
      const url = this.buildUrl('profiles', `username=eq.${encodeURIComponent(key)}&select=*`);

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data || data.length === 0) {
        return null;
      }

      const profile = data[0];

      // Check if remote cache has expired
      const cachedAt = new Date(profile.cached_at).getTime();
      const age = Date.now() - cachedAt;

      if (age > this.REMOTE_CACHE_DURATION) {
        return null; // Expired
      }

      // Convert from database format to app format
      return this.dbToProfile(profile);

    } catch (e) {
      return null;
    }
  },

  /**
   * Save a profile to remote cache - DEPRECATED
   * Writes now go through API validation server
   * @deprecated Use XCredAPI.requestValidation() instead
   */
  async set(username, profileData) {
    console.warn('[XCred] Direct Supabase writes disabled - use API validation');
    return;
  },

  /**
   * Check if profile data is valid for remote storage
   */
  isValidForRemote(data) {
    if (!data) return false;

    // Must have at least createdAt (indicates valid API response)
    if (data.createdAt) return true;

    // Or connectedVia (indicates some data)
    if (data.connectedVia) return true;

    // Or accountBasedIn
    if (data.accountBasedIn) return true;

    // Or is government verified
    if (data.isGovernmentVerified) return true;

    return false;
  },

  /**
   * Convert profile data to database format
   * IMPORTANT: Always include ALL fields with consistent types to avoid PostgREST batch errors
   */
  profileToDb(username, data) {
    // Ensure tier is a string (handles both number tiers 1-6 and 'government')
    let tier = data.tier;
    if (tier !== null && tier !== undefined) {
      tier = String(tier);
    } else {
      tier = null;
    }

    return {
      username: String(username).toLowerCase(),
      location: data.location ? String(data.location) : null,
      location_country: data.locationCountry ? String(data.locationCountry) : null,
      account_based_in: data.accountBasedIn ? String(data.accountBasedIn) : null,
      connected_via: data.connectedVia ? String(data.connectedVia) : null,
      vpn_detected: Boolean(data.vpnDetected),
      location_accurate: data.locationAccurate !== false,
      tier: tier,
      username_changes: parseInt(data.usernameChanges, 10) || 0,
      verified: Boolean(data.verified),
      is_blue_verified: Boolean(data.isBlueVerified),
      is_business_verified: Boolean(data.isBusinessVerified),
      is_government_verified: Boolean(data.isGovernmentVerified),
      verified_type: data.verifiedType ? String(data.verifiedType) : null,
      party: data.party ? String(data.party) : null,
      affiliate_username: data.affiliateUsername ? String(data.affiliateUsername) : null,
      display_name: data.displayName ? String(data.displayName) : String(username),
      screen_name: data.screenName ? String(data.screenName) : String(username),
      created_at: data.createdAt ? String(data.createdAt) : null,
      cached_at: new Date().toISOString()
    };
  },

  /**
   * Convert database format to profile data
   */
  dbToProfile(row) {
    return {
      username: row.username,
      location: row.location,
      locationCountry: row.location_country,
      accountBasedIn: row.account_based_in,
      connectedVia: row.connected_via,
      vpnDetected: Boolean(row.vpn_detected),
      locationAccurate: row.location_accurate !== false,
      tier: row.tier,
      usernameChanges: parseInt(row.username_changes, 10) || 0,
      verified: Boolean(row.verified),
      isBlueVerified: Boolean(row.is_blue_verified),
      isBusinessVerified: Boolean(row.is_business_verified),
      isGovernmentVerified: Boolean(row.is_government_verified),
      verifiedType: row.verified_type,
      party: row.party,
      affiliateUsername: row.affiliate_username,
      displayName: row.display_name,
      screenName: row.screen_name,
      createdAt: row.created_at,
      timestamp: new Date(row.cached_at).getTime(),
      _cacheSource: 'remote'
    };
  },

  /**
   * Sync local to remote - DEPRECATED
   * Writes now go through API validation server
   * @deprecated Local data is validated through API before being stored remotely
   */
  async syncLocalToRemote() {
    console.warn('[XCred] Direct Supabase sync disabled - use API validation');
    return;
  },

  /**
   * Get remote cache statistics
   */
  async getStats() {
    if (!this.isConfigured) {
      return { error: 'Not configured', totalProfiles: 0 };
    }

    try {
      // Use Supabase's count feature with HEAD request
      const url = this.buildUrl('profiles', 'select=count');

      let response = await fetch(url, {
        method: 'HEAD',
        headers: {
          ...this.getHeaders(),
          'Prefer': 'count=exact'
        }
      });

      // Fallback to GET if HEAD fails (some browsers/contexts block HEAD)
      if (!response.ok) {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            ...this.getHeaders(),
            'Prefer': 'count=exact'
          }
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentRange = response.headers.get('content-range');
      const count = contentRange ? parseInt(contentRange.split('/')[1] || '0', 10) : 0;

      this.remoteStats = {
        totalProfiles: count,
        lastChecked: Date.now()
      };

      return this.remoteStats;

    } catch (e) {
      console.warn('[XCred] Stats fetch failed:', e);
      return { error: e.message || 'Stats unavailable', totalProfiles: 0 };
    }
  },

  /**
   * Show rate limit prompt to user
   * Called when X API rate limits are hit and remote sync is disabled
   */
  showRateLimitPrompt() {
    if (this.isEnabled || !this.isConfigured) {
      return; // Already enabled or not configured
    }

    // Create toast notification
    const toast = document.createElement('div');
    toast.className = 'xlocation-rate-limit-toast';
    toast.innerHTML = `
      <div class="xlocation-toast-content">
        <strong>XLocation Rate Limited</strong>
        <p>Enable remote sync to use our shared cache and avoid X API limits.</p>
        <div class="xlocation-toast-actions">
          <button class="xlocation-toast-enable">Enable Remote Sync</button>
          <button class="xlocation-toast-dismiss">Dismiss</button>
        </div>
      </div>
    `;

    // Style the toast
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #15202b;
      color: #fff;
      padding: 16px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 999999;
      max-width: 320px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
    `;

    const style = document.createElement('style');
    style.textContent = `
      .xlocation-toast-content strong {
        display: block;
        margin-bottom: 8px;
        color: #1da1f2;
      }
      .xlocation-toast-content p {
        margin: 0 0 12px 0;
        opacity: 0.9;
      }
      .xlocation-toast-actions {
        display: flex;
        gap: 8px;
      }
      .xlocation-toast-enable {
        background: #1da1f2;
        color: #fff;
        border: none;
        padding: 8px 16px;
        border-radius: 20px;
        cursor: pointer;
        font-weight: 600;
      }
      .xlocation-toast-enable:hover {
        background: #1a91da;
      }
      .xlocation-toast-dismiss {
        background: transparent;
        color: #8899a6;
        border: 1px solid #38444d;
        padding: 8px 16px;
        border-radius: 20px;
        cursor: pointer;
      }
      .xlocation-toast-dismiss:hover {
        background: rgba(255,255,255,0.1);
      }
    `;
    document.head.appendChild(style);

    // Add event listeners
    toast.querySelector('.xlocation-toast-enable').addEventListener('click', async () => {
      await this.setEnabled(true);
      toast.remove();
      // Show success message
      this.showToast('Remote sync enabled! Syncing your cache...', 'success');
    });

    toast.querySelector('.xlocation-toast-dismiss').addEventListener('click', () => {
      toast.remove();
    });

    document.body.appendChild(toast);

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
      if (document.body.contains(toast)) {
        toast.remove();
      }
    }, 15000);
  },

  /**
   * Show a simple toast message
   */
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${type === 'success' ? '#17bf63' : '#1da1f2'};
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
};

// Initialize on load
XLocationRemote.init();
