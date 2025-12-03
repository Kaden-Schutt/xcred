/**
 * XCred - Gun.js P2P Cache Integration
 * Provides decentralized P2P caching with peer validation
 */

const XLocationGun = {
  gun: null,
  profiles: null,
  peerCount: 0,
  initialized: false,

  // ========== SECURITY: Rate limiting ==========
  lastWriteTime: 0,
  WRITE_COOLDOWN: 3000,  // 3 seconds between writes to prevent rapid injection

  // ========== SECURITY: Relay health tracking ==========
  relayConnected: false,
  lastRelayCheck: 0,

  // ========== INITIALIZATION ==========

  /**
   * Initialize Gun.js with relay servers
   * @returns {Promise<boolean>} Success status
   */
  async init() {
    if (this.initialized) return true;
    if (typeof Gun === 'undefined') {
      console.log('[XCred Gun] Gun.js library not loaded');
      return false;
    }

    try {
      // Check settings first
      const settings = await this.getSettings();
      if (!settings.gunSync) {
        console.log('[XCred Gun] P2P sync disabled in settings');
        return false;
      }

      this.gun = Gun({
        peers: [
          'wss://srv654779.hstgr.cloud/gun',
        ],
        localStorage: false,  // Use IndexedDB via our own cache
        radisk: false
      });

      this.profiles = this.gun.get('xcred/profiles');

      // Load validator budget state
      this.loadBudgetState();

      // Start listening for peer validation requests
      this.listenForValidationRequests();

      this.initialized = true;
      console.log('[XCred Gun] P2P initialized successfully');
      console.log(`[XCred Gun] Validator budget: ${this.validatorBudget}/${this.VALIDATOR_BUDGET_PER_HOUR}`);

      return true;
    } catch (e) {
      console.error('[XCred Gun] Initialization failed:', e);
      return false;
    }
  },

  // ========== PROFILE OPERATIONS ==========

  /**
   * SECURITY: Validate timestamp is not in the future or too old
   * @param {number} timestamp - Timestamp to validate
   * @returns {boolean} Whether timestamp is valid
   */
  isValidTimestamp(timestamp) {
    if (!timestamp) return false;
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const oneMinuteFuture = 60 * 1000;  // Allow 1 minute clock skew
    return timestamp > (now - oneDay) && timestamp < (now + oneMinuteFuture);
  },

  /**
   * SECURITY: Cross-validate Gun.js data against Supabase
   * @param {string} username - Twitter username
   * @param {Object} gunData - Data from Gun.js
   * @returns {Promise<boolean>} Whether data passes validation
   */
  async validateAgainstSupabase(username, gunData) {
    if (typeof XLocationRemote === 'undefined') return true;  // Skip if no Supabase

    try {
      const supabaseData = await XLocationRemote.get(username);
      if (!supabaseData) return true;  // No Supabase data to compare against

      // Critical fields must match if Supabase has data
      if (supabaseData.createdAt && gunData.createdAt !== supabaseData.createdAt) {
        console.warn(`[XCred Gun] SECURITY: createdAt mismatch for ${username} - possible attack`);
        return false;
      }
      return true;
    } catch (e) {
      return true;  // Fail open if Supabase unavailable
    }
  },

  /**
   * Get profile from Gun.js P2P network
   * @param {string} username - Twitter username
   * @returns {Promise<Object|null>} Profile data or null
   */
  async get(username) {
    if (!this.profiles) return null;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[XCred Gun] Timeout fetching ${username}`);
        resolve(null);
      }, 2000);

      this.profiles.get(username.toLowerCase()).once(async (data, key) => {
        clearTimeout(timeout);
        if (data && data.createdAt) {
          // SECURITY: Validate timestamp
          if (data._updatedAt && !this.isValidTimestamp(data._updatedAt)) {
            console.warn(`[XCred Gun] SECURITY: Invalid timestamp for ${username}, rejecting`);
            resolve(null);
            return;
          }

          // SECURITY: Cross-validate with Supabase
          const isValid = await this.validateAgainstSupabase(username, data);
          if (!isValid) {
            console.warn(`[XCred Gun] SECURITY: Supabase validation failed for ${username}`);
            resolve(null);
            return;
          }

          resolve({
            ...data,
            _cacheSource: 'gun',
            _peerConsensus: data._souls?.length || 1
          });
        } else {
          resolve(null);
        }
      });
    });
  },

  /**
   * Set profile to Gun.js (broadcasts to peers)
   * @param {string} username - Twitter username
   * @param {Object} data - Profile data
   * @returns {Promise<boolean>} Success status
   */
  async set(username, data) {
    if (!this.profiles) return false;

    // SECURITY: Rate limiting - prevent rapid injection attacks
    const now = Date.now();
    if (now - this.lastWriteTime < this.WRITE_COOLDOWN) {
      console.log('[XCred Gun] Write cooldown active, skipping');
      return false;
    }

    try {
      const gunData = {
        ...data,
        username: username.toLowerCase(),
        _updatedAt: now,
        _nodeId: this.getNodeId()
      };

      // Remove any Gun.js internal properties before setting
      delete gunData._;
      delete gunData._cacheSource;
      delete gunData._peerConsensus;

      this.profiles.get(username.toLowerCase()).put(gunData);
      this.lastWriteTime = now;  // Update last write time
      console.log(`[XCred Gun] Set ${username} to P2P network`);
      return true;
    } catch (e) {
      console.error(`[XCred Gun] Failed to set ${username}:`, e);
      return false;
    }
  },

  // ========== CONSENSUS OPERATIONS ==========

  /**
   * Check if multiple peers agree on profile data
   * @param {string} username - Twitter username
   * @param {number} threshold - Minimum peer count for consensus (SECURITY: increased to 3)
   * @returns {Promise<boolean>} Whether consensus is reached
   */
  async checkConsensus(username, threshold = 3) {
    // SECURITY: Require minimum 3 peers to establish consensus
    // This makes it harder for a single attacker to manipulate data
    const data = await this.get(username);
    return data && (data._peerConsensus >= threshold);
  },

  /**
   * SECURITY: Check relay server connectivity
   * @returns {Promise<boolean>} Whether at least one relay is reachable
   */
  async checkRelayHealth() {
    if (!this.gun) return false;

    // Check if we've recently verified connectivity
    const now = Date.now();
    if (now - this.lastRelayCheck < 30000 && this.relayConnected) {
      return true;  // Use cached status for 30 seconds
    }

    this.lastRelayCheck = now;

    // Test connectivity by trying to read from Gun
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.relayConnected = false;
        console.warn('[XCred Gun] SECURITY: No relay connectivity');
        resolve(false);
      }, 3000);

      // Try to read anything from the network
      this.gun.get('xcred/health').once((data) => {
        clearTimeout(timeout);
        this.relayConnected = true;
        resolve(true);
      });
    });
  },

  /**
   * Sync Gun.js consensus to Supabase
   * @param {string} username - Twitter username
   * @returns {Promise<boolean>} Success status
   */
  async syncConsensusToSupabase(username) {
    const data = await this.get(username);
    if (data && await this.checkConsensus(username)) {
      // Merge to Supabase with consensus marker
      if (typeof XLocationRemote !== 'undefined') {
        await XLocationRemote.mergeFromConsensus(username, data, data._peerConsensus);
        console.log(`[XCred Gun] Synced consensus for ${username} to Supabase`);
        return true;
      }
    }
    return false;
  },

  // ========== VALIDATOR BUDGET SYSTEM ==========

  VALIDATOR_BUDGET_PER_HOUR: 25,
  validatorBudget: 25,
  lastBudgetReset: Date.now(),

  /**
   * Check if we can perform a validation
   * @returns {boolean} Whether validation is allowed
   */
  canValidate() {
    this.resetBudgetIfNeeded();
    return this.validatorBudget > 0;
  },

  /**
   * Consume one validation from budget
   * @returns {boolean} Whether budget was consumed
   */
  consumeValidatorBudget() {
    if (this.canValidate()) {
      this.validatorBudget--;
      this.saveBudgetState();
      return true;
    }
    return false;
  },

  /**
   * Reset budget if an hour has passed
   */
  resetBudgetIfNeeded() {
    const hourMs = 60 * 60 * 1000;
    if (Date.now() - this.lastBudgetReset > hourMs) {
      this.validatorBudget = this.VALIDATOR_BUDGET_PER_HOUR;
      this.lastBudgetReset = Date.now();
      this.saveBudgetState();
      console.log('[XCred Gun] Validator budget reset');
    }
  },

  /**
   * Save budget state to localStorage
   */
  saveBudgetState() {
    try {
      localStorage.setItem('xcred_validator_budget', JSON.stringify({
        budget: this.validatorBudget,
        lastReset: this.lastBudgetReset
      }));
    } catch (e) {
      // localStorage may not be available
    }
  },

  /**
   * Load budget state from localStorage
   */
  loadBudgetState() {
    try {
      const state = JSON.parse(localStorage.getItem('xcred_validator_budget'));
      if (state) {
        this.validatorBudget = state.budget;
        this.lastBudgetReset = state.lastReset;
        this.resetBudgetIfNeeded();
      }
    } catch (e) {
      // Use defaults
    }
  },

  /**
   * Get current validator budget info
   * @returns {Object} Budget info
   */
  getBudgetInfo() {
    this.resetBudgetIfNeeded();
    const hourMs = 60 * 60 * 1000;
    const timeUntilReset = Math.max(0, hourMs - (Date.now() - this.lastBudgetReset));
    return {
      remaining: this.validatorBudget,
      max: this.VALIDATOR_BUDGET_PER_HOUR,
      resetInMinutes: Math.ceil(timeUntilReset / 60000)
    };
  },

  // ========== SERVER-SIGNED VALIDATION TASKS ==========

  /**
   * Listen for server-signed validation tasks
   * Tasks are pushed by API server to xcred/validation-tasks
   */
  listenForValidationRequests() {
    if (!this.gun) return;

    // Listen for server-signed validation tasks (new system)
    this.gun.get('xcred').get('validation-tasks').map().on(async (task, taskId) => {
      if (!task || !task.signature) return;
      await this.handleServerSignedTask(task, taskId);
    });

    console.log('[XCred Gun] Listening for server-signed validation tasks');
  },

  /**
   * Handle server-signed validation task
   * @param {Object} task - Server-signed validation task
   * @param {string} taskId - Task ID
   */
  async handleServerSignedTask(task, taskId) {
    const myNodeId = this.getNodeId();

    // Skip if we're not selected as a validator
    if (!task.selectedValidators || !task.selectedValidators.includes(myNodeId)) {
      return;
    }

    // Skip if task is too old (> 5 minutes)
    if (Date.now() - task.timestamp > 5 * 60 * 1000) {
      console.log(`[XCred Gun] Task ${taskId} expired, skipping`);
      return;
    }

    // Check if peer validation is enabled in settings
    const settings = await this.getSettings();
    if (!settings.peerValidation) return;

    // Verify server signature before processing
    if (typeof XLocationVPS !== 'undefined') {
      const dataToVerify = {
        taskId: task.taskId,
        username: task.username,
        timestamp: task.timestamp,
        selectedValidators: task.selectedValidators,
        serverPublicKey: task.serverPublicKey
      };

      const isValid = await XLocationVPS.verifyServerSignature(dataToVerify, task.signature);
      if (!isValid) {
        console.warn(`[XCred Gun] SECURITY: Invalid server signature for task ${taskId}`);
        return;
      }
    }

    // Check validator budget
    if (!this.canValidate()) {
      console.log('[XCred Gun] Validator budget exhausted, skipping task');
      return;
    }

    // Consume budget
    if (!this.consumeValidatorBudget()) return;

    console.log(`[XCred Gun] Processing validation task ${taskId} for @${task.username}`);

    // Fetch fresh data from X API
    try {
      if (typeof window.XLocation !== 'undefined' && window.XLocation.fetchProfileFromAPI) {
        const freshData = await window.XLocation.fetchProfileFromAPI(task.username);

        if (freshData && freshData.createdAt) {
          // Submit result to API server
          if (typeof XLocationVPS !== 'undefined') {
            const submitted = await XLocationVPS.submitValidationResult(task.taskId, freshData);
            if (submitted) {
              console.log(`[XCred Gun] Submitted validation result for @${task.username}`);
            }
          }

          // Also push to Gun.js for local network sync
          await this.set(task.username, {
            ...freshData,
            _validatedBy: myNodeId,
            _validatedAt: Date.now()
          });
        }
      }
    } catch (e) {
      console.error(`[XCred Gun] Validation failed for ${task.username}:`, e);
    }
  },

  /**
   * Request validation via API (server-mediated system)
   * @param {string} username - Twitter username
   */
  async requestValidation(username) {
    if (typeof XLocationVPS !== 'undefined') {
      try {
        await XLocationVPS.requestValidation(username);
        console.log(`[XCred Gun] Requested API validation for ${username}`);
      } catch (e) {
        console.error(`[XCred Gun] API validation request failed for ${username}:`, e);
      }
    }
  },

  // ========== STALE DATA HANDLING ==========

  /**
   * Handle stale data by triggering refresh via API validation
   * @param {string} username - Twitter username
   * @param {Object} staleData - Existing stale data
   * @returns {Promise<Object>} Fresh or stale data
   */
  async handleStaleData(username, staleData) {
    console.log(`[XCred Gun] Stale data detected for ${username}, initiating refresh`);

    // Request server-validated refresh via API
    await this.requestValidation(username);

    // Return stale data for now, it will be updated when validation completes
    return staleData;
  },

  // ========== UTILITIES ==========

  /**
   * Get extension settings
   * @returns {Promise<Object>} Settings object
   */
  async getSettings() {
    const defaults = { gunSync: true, peerValidation: true };
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.sync.get(['xlocation_settings'], (result) => {
          // Merge with defaults so gunSync defaults to true if not set
          resolve({ ...defaults, ...result.xlocation_settings });
        });
      } else {
        resolve(defaults);
      }
    });
  },

  /**
   * Get unique node ID for this browser
   * @returns {string} Node ID
   */
  getNodeId() {
    try {
      let nodeId = localStorage.getItem('xcred_gun_node_id');
      if (!nodeId) {
        nodeId = 'node_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('xcred_gun_node_id', nodeId);
      }
      return nodeId;
    } catch (e) {
      // Fallback for environments without localStorage
      return 'node_' + Math.random().toString(36).substr(2, 9);
    }
  },

  /**
   * Check if Gun.js is available and initialized
   * @returns {boolean} Ready status
   */
  isReady() {
    return this.initialized && this.gun !== null && this.profiles !== null;
  },

  /**
   * Get connection status info
   * @returns {Object} Status info
   */
  getStatus() {
    return {
      initialized: this.initialized,
      connected: this.isReady(),
      relayConnected: this.relayConnected,
      nodeId: this.getNodeId(),
      budget: this.getBudgetInfo(),
      securityFeatures: {
        timestampValidation: true,
        supabaseCrossValidation: true,
        writeRateLimiting: true,
        consensusThreshold: 3
      }
    };
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.XLocationGun = XLocationGun;
}
