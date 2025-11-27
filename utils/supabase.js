/**
 * Supabase Remote Cache for XCred
 * Provides a shared profile cache across all users to reduce X API dependency
 */

const XLocationRemote = {
  // Configuration - REPLACE THESE WITH YOUR SUPABASE PROJECT VALUES
  // See SUPABASE_SETUP.md for instructions on finding these values
  SUPABASE_URL: 'https://fltltydwaaveotuzlnxb.supabase.co', // e.g., 'https://abcdefghijkl.supabase.co'
  SUPABASE_ANON_KEY: 'sb_publishable_ez4XpVROziphVz9uiKvjPg_Q-beTTxM', // Use either:
  // - Publishable key (starts with 'sb_publishable_...') from API Keys tab, OR
  // - Legacy anon key (starts with 'eyJ...') from Legacy API Keys tab
  // Both are safe to expose in client code

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

      // If re-enabled, trigger sync from local to remote
      if (enabled) {
        this.syncLocalToRemote();
      }
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
   * INSERT new profile (no consensus required)
   * @param {string} username - The username
   * @param {Object} profileData - The profile data
   * @returns {Promise<boolean>} Success status
   */
  async insert(username, profileData) {
    if (!this.isEnabled || !this.isConfigured) return false;

    // Don't insert error or rate-limited entries
    if (profileData.error || profileData.rateLimited) return false;

    // Don't insert invalid entries
    if (!this.isValidForRemote(profileData)) return false;

    try {
      const key = username.toLowerCase();
      const dbData = this.profileToDb(key, profileData);

      // Use POST without on_conflict - will fail if exists (that's ok)
      const response = await fetch(
        this.buildUrl('profiles'),
        {
          method: 'POST',
          headers: this.getHeaders({ prefer: 'return=minimal' }),
          body: JSON.stringify(dbData)
        }
      );

      // 201 = inserted, 409 = conflict (already exists) - both are acceptable
      return response.ok || response.status === 409;
    } catch (e) {
      console.error('[XCred] Remote insert failed:', e);
      return false;
    }
  },

  /**
   * MERGE update from Gun.js consensus (consensus required)
   * @param {string} username - The username
   * @param {Object} data - Profile data from Gun.js
   * @param {number} consensusCount - Number of peers in consensus
   * @returns {Promise<boolean>} Success status
   */
  async mergeFromConsensus(username, data, consensusCount) {
    if (!this.isEnabled || !this.isConfigured) return false;

    if (consensusCount < 2) {
      console.log('[XCred] Consensus threshold not met, skipping Supabase merge');
      return false;
    }

    try {
      const key = username.toLowerCase();
      const dbData = this.profileToDb(key, data);

      // Add consensus tracking fields
      dbData.consensus_source = 'gun';
      dbData.consensus_count = consensusCount;
      dbData.consensus_at = new Date().toISOString();

      // PATCH to update existing record only
      const response = await fetch(
        this.buildUrl('profiles', `username=eq.${encodeURIComponent(key)}`),
        {
          method: 'PATCH',
          headers: this.getHeaders({ prefer: 'return=minimal' }),
          body: JSON.stringify(dbData)
        }
      );

      if (response.ok) {
        console.log(`[XCred] Merged consensus data for ${username} (${consensusCount} peers)`);
      }
      return response.ok;
    } catch (e) {
      console.error('[XCred] Remote merge failed:', e);
      return false;
    }
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
   * Save a profile to remote cache
   * @param {string} username - The username
   * @param {object} profileData - The profile data to cache
   */
  async set(username, profileData) {
    if (!this.isEnabled || !this.isConfigured) {
      return;
    }

    // Don't save error or rate-limited entries to remote
    if (profileData.error || profileData.rateLimited) {
      return;
    }

    // Don't save invalid entries
    if (!this.isValidForRemote(profileData)) {
      return;
    }

    try {
      const key = username.toLowerCase();
      const dbData = this.profileToDb(key, profileData);

      // Use upsert via on_conflict query param + resolution=merge-duplicates header
      const upsertUrl = this.buildUrl('profiles', 'on_conflict=username');

      const response = await fetch(upsertUrl, {
        method: 'POST',
        headers: this.getHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(dbData)
      });

      if (!response.ok) {
        // Handle constraint violations gracefully (invalid data rejected by server)
        if (response.status === 400) {
          const errorText = await response.text();
          if (errorText.includes('violates check constraint')) {
            console.warn('[XCred] Invalid data rejected by server:', errorText);
            return; // Silently skip - data was invalid
          }
        }
        throw new Error('Remote save failed');
      }

    } catch (e) {
      // Silently fail - don't break the app if remote is down
    }
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
   * Sync local IndexedDB cache to remote (called when remote sync is re-enabled)
   * This helps build the shared cache faster
   */
  async syncLocalToRemote() {
    if (!this.isEnabled || !this.isConfigured || this.syncInProgress) {
      return;
    }

    this.syncInProgress = true;

    try {
      // Get all valid profiles from local IndexedDB
      const profiles = await this.getAllLocalProfiles();

      if (profiles.length === 0) {
        this.syncInProgress = false;
        return;
      }

      // Batch upload
      let synced = 0;
      for (let i = 0; i < profiles.length; i += this.BATCH_SIZE) {
        const batch = profiles.slice(i, i + this.BATCH_SIZE);
        await this.batchUpload(batch);
        synced += batch.length;

        // Small delay between batches to avoid overwhelming the server
        if (i + this.BATCH_SIZE < profiles.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      this.lastSyncTime = Date.now();

    } catch (e) {
      // Sync failed
    } finally {
      this.syncInProgress = false;
    }
  },

  /**
   * Get all valid profiles from local IndexedDB
   */
  async getAllLocalProfiles() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('XLocationCache', 2);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['profiles'], 'readonly');
        const store = transaction.objectStore('profiles');
        const getAllRequest = store.getAll();

        getAllRequest.onerror = () => reject(getAllRequest.error);
        getAllRequest.onsuccess = () => {
          const profiles = getAllRequest.result.filter(p => this.isValidForRemote(p));
          resolve(profiles);
        };
      };
    });
  },

  /**
   * Batch upload profiles to remote (upsert - update if exists, insert if not)
   */
  async batchUpload(profiles) {
    if (profiles.length === 0) return;

    const dbRows = profiles.map(p => {
      try {
        return this.profileToDb(p.username, p);
      } catch (e) {
        return null;
      }
    }).filter(row => row !== null);

    if (dbRows.length === 0) return;

    // Deduplicate by username (keep the most recent entry)
    const seen = new Map();
    for (const row of dbRows) {
      const key = row.username.toLowerCase();
      if (!seen.has(key) || new Date(row.cached_at) > new Date(seen.get(key).cached_at)) {
        seen.set(key, row);
      }
    }
    const dedupedRows = Array.from(seen.values());

    // Use on_conflict=username for upsert behavior
    const url = this.buildUrl('profiles', 'on_conflict=username');

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders({ prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(dedupedRows)
    });

    if (!response.ok) {
      // Handle constraint violations gracefully
      if (response.status === 400) {
        const errorText = await response.text();
        if (errorText.includes('violates check constraint')) {
          console.warn('[XCred] Some profiles rejected by server (invalid data)');
          return; // Partial success is acceptable
        }
      }
      throw new Error('Batch upload failed');
    }
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
