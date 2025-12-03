/**
 * XCred API Client
 * Handles communication with the server-signed validation API
 */

const XCredAPI = {
  // Server configuration
  API_URL: 'https://api.xcred.org',

  // Server public key (Ed25519) - loaded dynamically
  serverPublicKey: null,

  // Node ID for this extension instance
  nodeId: null,

  // Heartbeat interval
  heartbeatInterval: null,
  HEARTBEAT_INTERVAL: 60 * 1000, // 1 minute

  // Initialized flag
  initialized: false,

  /**
   * Initialize the API client
   * @returns {Promise<boolean>} True if initialization succeeded
   */
  async init() {
    if (this.initialized) return true;

    try {
      // Generate or retrieve node ID
      this.nodeId = await this.getOrCreateNodeId();

      // Fetch server public key
      await this.fetchPublicKey();

      // Register as validator
      await this.register();

      // Start heartbeat
      this.startHeartbeat();

      this.initialized = true;
      console.log('[XCred API] Initialized, node ID:', this.nodeId);
      return true;

    } catch (err) {
      console.error('[XCred API] Initialization failed:', err.message);
      return false;
    }
  },

  /**
   * Get or create a unique node ID for this extension instance
   * @returns {Promise<string>} Node ID
   */
  async getOrCreateNodeId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['xcred_node_id'], (result) => {
        if (result.xcred_node_id) {
          resolve(result.xcred_node_id);
        } else {
          const nodeId = 'node_' + Math.random().toString(36).substring(2, 15) +
                         Math.random().toString(36).substring(2, 15);
          chrome.storage.local.set({ xcred_node_id: nodeId });
          resolve(nodeId);
        }
      });
    });
  },

  /**
   * Fetch server public key for signature verification
   */
  async fetchPublicKey() {
    const response = await fetch(`${this.API_URL}/api/public-key`);
    if (!response.ok) {
      throw new Error(`Failed to fetch public key: ${response.status}`);
    }
    const data = await response.json();
    this.serverPublicKey = data.publicKey;
    console.log('[XCred API] Server public key loaded');
  },

  /**
   * Register this node as a validator
   */
  async register() {
    const response = await fetch(`${this.API_URL}/api/validator/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: this.nodeId,
        metadata: {
          version: chrome.runtime.getManifest().version,
          userAgent: navigator.userAgent.substring(0, 100)
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Registration failed: ${response.status}`);
    }

    const data = await response.json();
    console.log('[XCred API] Registered, reputation:', data.validator?.reputation);
  },

  /**
   * Start heartbeat to keep validator status online
   */
  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL);

    // Send initial heartbeat
    this.sendHeartbeat();
  },

  /**
   * Send heartbeat to server
   */
  async sendHeartbeat() {
    try {
      await fetch(`${this.API_URL}/api/validator/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: this.nodeId })
      });
    } catch (err) {
      console.warn('[XCred API] Heartbeat failed:', err.message);
    }
  },

  /**
   * Request validation for a profile
   * @param {string} username - Username to validate
   * @returns {Promise<object>} Validation response
   */
  async requestValidation(username) {
    if (!this.initialized) {
      await this.init();
    }

    const response = await fetch(`${this.API_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.toLowerCase(),
        requesterId: this.nodeId
      })
    });

    if (!response.ok) {
      throw new Error(`Validation request failed: ${response.status}`);
    }

    return response.json();
  },

  /**
   * Submit validation result to server
   * @param {string} taskId - Task ID
   * @param {object} result - Validation result data
   * @returns {Promise<boolean>} True if accepted
   */
  async submitValidationResult(taskId, result) {
    if (!this.initialized) {
      await this.init();
    }

    const response = await fetch(`${this.API_URL}/api/validator/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        nodeId: this.nodeId,
        result
      })
    });

    if (!response.ok) {
      console.error('[XCred API] Result submission failed:', response.status);
      return false;
    }

    const data = await response.json();
    return data.success === true;
  },

  /**
   * Get validation task status
   * @param {string} taskId - Task ID
   * @returns {Promise<object>} Task status
   */
  async getTaskStatus(taskId) {
    const response = await fetch(`${this.API_URL}/api/task/${taskId}`);
    if (!response.ok) {
      return null;
    }
    return response.json();
  },

  /**
   * Get validated profile from server
   * @param {string} username - Username
   * @returns {Promise<object|null>} Profile data or null
   */
  async getValidatedProfile(username) {
    const response = await fetch(`${this.API_URL}/api/profile/${encodeURIComponent(username.toLowerCase())}`);
    if (!response.ok) {
      return null;
    }
    return response.json();
  },

  /**
   * Verify a server signature (Ed25519)
   * Uses SubtleCrypto for signature verification
   * @param {object} data - Original data object
   * @param {string} signature - Base64 encoded signature
   * @returns {Promise<boolean>} True if signature is valid
   */
  async verifyServerSignature(data, signature) {
    if (!this.serverPublicKey) {
      console.error('[XCred API] No server public key loaded');
      return false;
    }

    try {
      // Decode base64 public key and signature
      const publicKeyBytes = this.base64ToUint8Array(this.serverPublicKey);
      const signatureBytes = this.base64ToUint8Array(signature);
      const messageBytes = new TextEncoder().encode(JSON.stringify(data));

      // Import Ed25519 public key
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        publicKeyBytes,
        { name: 'Ed25519' },
        false,
        ['verify']
      );

      // Verify signature
      const isValid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        cryptoKey,
        signatureBytes,
        messageBytes
      );

      return isValid;

    } catch (err) {
      console.error('[XCred API] Signature verification error:', err.message);
      return false;
    }
  },

  /**
   * Convert base64 string to Uint8Array
   * @param {string} base64 - Base64 encoded string
   * @returns {Uint8Array} Decoded bytes
   */
  base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  },

  /**
   * Get server stats
   * @returns {Promise<object>} Stats object
   */
  async getStats() {
    try {
      const response = await fetch(`${this.API_URL}/api/stats`);
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  },

  /**
   * Get node info for display
   * @returns {object} Node info
   */
  getNodeInfo() {
    return {
      nodeId: this.nodeId,
      initialized: this.initialized,
      serverUrl: this.API_URL,
      hasPublicKey: !!this.serverPublicKey
    };
  },

  /**
   * Cleanup on unload
   */
  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
};

// Make available globally (keep XLocationVPS alias for backward compatibility)
if (typeof window !== 'undefined') {
  window.XCredAPI = XCredAPI;
  window.XLocationVPS = XCredAPI; // Backward compatibility alias
}
