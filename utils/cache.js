/**
 * IndexedDB-based caching for profile location data
 * Three-tier cache: Memory -> IndexedDB -> Remote (Supabase)
 */

const XLocationCache = {
  DB_NAME: 'XLocationCache',
  DB_VERSION: 2, // Bumped for lastAccessed index
  STORE_NAME: 'profiles',
  CACHE_DURATION: 24 * 60 * 60 * 1000, // 1 day in milliseconds (reduced - remote is source of truth)
  ERROR_CACHE_DURATION: 30 * 60 * 1000, // 30 minutes for errors (retry sooner)

  // Storage quota management - reduced since remote cache is primary
  MAX_STORAGE_MB: 50,
  MAX_ENTRIES: 5000, // Keep local cache small - remote is primary
  EVICTION_BATCH_SIZE: 500, // Delete this many entries when cleaning up

  db: null,

  // In-memory cache for faster lookups (avoids IndexedDB latency)
  memoryCache: new Map(),
  MEMORY_CACHE_MAX: 200, // Max entries in memory (reduced)

  // Remote cache integration flag
  useRemoteCache: true, // Can be toggled via settings

  /**
   * Check if a cached entry is valid (not a failed/incomplete fetch)
   *
   * Valid entries have:
   * - createdAt populated (always present in valid API responses)
   * - OR connectedVia is "web" (legitimate no-location account)
   * - OR error: true with connectedVia present (actual error, not silent fail)
   * - OR isGovernmentVerified is true (government accounts may not have location)
   *
   * Invalid entries (need re-fetch):
   * - createdAt is null AND connectedVia is null (API likely failed silently)
   *
   * @param {object} data - Cached profile data
   * @returns {boolean} True if entry is valid, false if needs re-fetch
   */
  isValidCacheEntry(data) {
    if (!data) return false;

    // Government verified accounts are always valid
    // They may not have location data but that's expected
    if (data.isGovernmentVerified) {
      return true;
    }

    // If createdAt is present, the API returned real data
    if (data.createdAt) {
      return true;
    }

    // If connectedVia is present (even with null location), it's valid
    // e.g., "web", "United States App Store", etc.
    if (data.connectedVia) {
      return true;
    }

    // If it has accountBasedIn, it's definitely valid
    if (data.accountBasedIn) {
      return true;
    }

    // If it has a tier assigned, it was processed successfully
    if (data.tier !== null && data.tier !== undefined) {
      return true;
    }

    // If explicitly marked as error with some data, accept it
    if (data.error && data.displayName && data.displayName !== data.username) {
      return true;
    }

    // Everything is null - likely a failed API fetch, invalidate
    return false;
  },

  /**
   * Initialize the IndexedDB database
   */
  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // Create store if it doesn't exist
        let store;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          store = db.createObjectStore(this.STORE_NAME, { keyPath: 'username' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        } else {
          // Get existing store for index updates
          store = event.target.transaction.objectStore(this.STORE_NAME);
        }

        // Add lastAccessed index if upgrading from v1
        if (oldVersion < 2 && store && !store.indexNames.contains('lastAccessed')) {
          store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        }
      };
    });
  },

  /**
   * Get cached profile data
   * Three-tier lookup: Memory -> IndexedDB -> Remote (Supabase)
   * @param {string} username - The username to look up
   * @returns {Promise<object|null>} Cached data or null if not found/expired
   */
  async get(username) {
    const key = username.toLowerCase();

    // TIER 1: Check memory cache first (fastest)
    if (this.memoryCache.has(key)) {
      const memData = this.memoryCache.get(key);
      const age = Date.now() - memData.timestamp;
      const maxAge = memData.error ? this.ERROR_CACHE_DURATION : this.CACHE_DURATION;

      if (age <= maxAge) {
        // Validate entry before returning
        if (!this.isValidCacheEntry(memData)) {
          this.memoryCache.delete(key);
          this.delete(username); // Also remove from IndexedDB
          return null;
        }
        // Update lastAccessed in memory
        memData.lastAccessed = Date.now();
        memData._cacheSource = 'memory';
        return memData;
      } else {
        this.memoryCache.delete(key);
      }
    }

    // TIER 2: Check IndexedDB
    await this.init();

    const indexedDBResult = await new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const data = request.result;

        if (!data) {
          resolve(null);
          return;
        }

        // Check if cache has expired (shorter TTL for errors)
        const age = Date.now() - data.timestamp;
        const maxAge = data.error ? this.ERROR_CACHE_DURATION : this.CACHE_DURATION;

        if (age > maxAge) {
          this.delete(username);
          resolve(null);
          return;
        }

        // Validate entry before returning
        if (!this.isValidCacheEntry(data)) {
          this.delete(username);
          resolve(null);
          return;
        }

        // Update lastAccessed for LRU tracking
        data.lastAccessed = Date.now();
        store.put(data);

        // Add to memory cache for faster subsequent lookups
        this.addToMemoryCache(key, data);

        // Mark source as IndexedDB
        data._cacheSource = 'indexeddb';
        resolve(data);
      };
    });

    if (indexedDBResult) {
      return indexedDBResult;
    }

    // TIER 3: Check remote cache (Supabase)
    if (this.useRemoteCache && typeof XLocationRemote !== 'undefined' && XLocationRemote.isEnabled) {
      try {
        const remoteData = await XLocationRemote.get(username);
        if (remoteData && this.isValidCacheEntry(remoteData)) {
          // Backfill to local caches for faster future access
          this.addToMemoryCache(key, remoteData);
          await this.setLocal(username, remoteData); // Save to IndexedDB without re-uploading to remote

          return remoteData;
        }
      } catch (e) {
        // Remote cache error, continue without it
      }
    }

    return null;
  },

  /**
   * Add entry to memory cache with LRU eviction
   */
  addToMemoryCache(key, data) {
    // Evict oldest entries if at capacity
    if (this.memoryCache.size >= this.MEMORY_CACHE_MAX) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(key, data);
  },

  /**
   * Store profile data in cache (both local and remote)
   * @param {string} username - The username
   * @param {object} profileData - The profile data to cache
   * @param {boolean} skipOnRateLimit - If true, don't cache rate limit errors
   */
  async set(username, profileData, skipOnRateLimit = false) {
    // Don't cache rate limit errors - we want to retry these
    if (skipOnRateLimit && profileData.rateLimited) {
      return;
    }

    const key = username.toLowerCase();
    const now = Date.now();

    const data = {
      username: key,
      ...profileData,
      timestamp: now,
      lastAccessed: now
    };

    // Don't cache invalid entries (likely failed API fetches)
    // Exception: if explicitly marked as error, still cache with short TTL
    if (!this.isValidCacheEntry(data) && !profileData.error) {
      return;
    }

    // Always update memory cache immediately
    this.addToMemoryCache(key, data);

    await this.init();

    // Check if we need to evict old entries (do this periodically, not every write)
    if (Math.random() < 0.05) { // 5% chance to check on each write
      this.checkAndEvict();
    }

    // Save to IndexedDB
    await new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      const request = store.put(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });

    // Also save to remote cache (fire and forget - don't block on this)
    if (this.useRemoteCache && typeof XLocationRemote !== 'undefined' && XLocationRemote.isEnabled) {
      XLocationRemote.set(username, profileData).catch(e => {
        // Silently ignore remote save errors
      });
    }
  },

  /**
   * Store profile data in local cache only (used for backfilling from remote)
   * @param {string} username - The username
   * @param {object} profileData - The profile data to cache
   */
  async setLocal(username, profileData) {
    const key = username.toLowerCase();
    const now = Date.now();

    const data = {
      username: key,
      ...profileData,
      timestamp: now,
      lastAccessed: now
    };

    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      const request = store.put(data);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  },

  /**
   * Delete cached profile data
   * @param {string} username - The username to delete
   */
  async delete(username) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.delete(username.toLowerCase());

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  },

  /**
   * Clear all cached data
   */
  async clear() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  },

  /**
   * Clean up expired entries
   */
  async cleanup() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const index = store.index('timestamp');
      const expiredTime = Date.now() - this.CACHE_DURATION;
      const range = IDBKeyRange.upperBound(expiredTime);

      const request = index.openCursor(range);

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  },

  /**
   * Check storage usage and evict if necessary
   */
  async checkAndEvict() {
    try {
      await this.init();

      // Get entry count
      const count = await this.getEntryCount();

      if (count > this.MAX_ENTRIES) {
        await this.evictLRU(this.EVICTION_BATCH_SIZE);
      }

      // Also check storage estimate if available
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        const usedMB = (estimate.usage || 0) / (1024 * 1024);

        if (usedMB > this.MAX_STORAGE_MB) {
          await this.evictLRU(this.EVICTION_BATCH_SIZE);
        }
      }
    } catch (e) {
      // Storage check failed
    }
  },

  /**
   * Get total entry count in IndexedDB
   */
  async getEntryCount() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.count();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  },

  /**
   * Evict least recently accessed entries
   * @param {number} count - Number of entries to evict
   */
  async evictLRU(count) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      // Try to use lastAccessed index, fallback to timestamp if not available
      let index;
      try {
        index = store.index('lastAccessed');
      } catch (e) {
        index = store.index('timestamp');
      }

      let deleted = 0;
      const request = index.openCursor();

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && deleted < count) {
          // Also remove from memory cache
          this.memoryCache.delete(cursor.value.username);
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
    });
  },

  /**
   * Get cache statistics
   */
  async getStats() {
    await this.init();

    const count = await this.getEntryCount();
    let storageMB = 0;

    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      storageMB = (estimate.usage || 0) / (1024 * 1024);
    }

    return {
      entries: count,
      maxEntries: this.MAX_ENTRIES,
      storageMB: storageMB.toFixed(2),
      maxStorageMB: this.MAX_STORAGE_MB,
      memoryCacheSize: this.memoryCache.size
    };
  }
};

// Initialize cache on load
XLocationCache.init().catch(() => {
  // Cache initialization failed
});
