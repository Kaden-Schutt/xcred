/**
 * XCred - Content Script
 * Injects transparency indicators into X/Twitter timeline
 */

(function() {
  'use strict';

  const XLocation = {
    // Configuration
    config: {
      enabled: true,
      showFlags: true,
      showBorders: true
    },

    // Track pending requests (not processed tweets - we check DOM for indicators instead)
    pendingRequests: new Map(),

    // Rate limiting
    requestQueue: [],
    isProcessingQueue: false,
    RATE_LIMIT_DELAY: 500, // ms between requests (increased)
    RATE_LIMIT_PAUSED: false,
    RATE_LIMIT_PAUSE_UNTIL: 0,
    RATE_LIMIT_BASE_PAUSE: 60000, // 1 minute base pause
    RATE_LIMIT_CURRENT_PAUSE: 60000, // Current pause duration (increases with repeated 429s)
    RATE_LIMIT_MAX_PAUSE: 300000, // Max 5 minute pause
    RATE_LIMIT_CONSECUTIVE: 0, // Count consecutive rate limits

    // Batch processing limits
    BATCH_SIZE: 5, // Process max 5 requests per batch
    BATCH_DELAY: 3000, // 3 second pause between batches
    MAX_QUEUE_SIZE: 50, // Don't queue more than 50 requests

    // Auth tokens (extracted dynamically)
    authToken: null,
    csrfToken: null,

    // Fallback public bearer token (limited access)
    PUBLIC_BEARER: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',

    // Tier colors for credibility system
    TIER_COLORS: {
      1: '#1DA1F2', // Dark Blue - Highest credibility (iOS + Clean + Match)
      2: '#17BF63', // Green - High credibility (Android + Match + Clean)
      3: '#FACC15', // Yellow - Medium credibility (VPN or minor issues)
      4: '#FB923C', // Orange - Low credibility (Multiple red flags)
      5: '#EF4444', // Red - Extremely suspicious (Major mismatch)
      6: '#9CA3AF', // Grey - No data
      government: '#C0C0C0' // Silver - Government verified
    },

    // Government affiliate keywords for party detection
    DEMOCRAT_AFFILIATES: ['housedems', 'housedemocrats', 'senatedems', 'senatedemocrats', 'democrats', 'thedemocrats'],
    REPUBLICAN_AFFILIATES: ['housegop', 'houserepublicans', 'senategop', 'senaterepublicans', 'republicans', 'gop'],

    // Five Eyes alliance - trusted VPN corridor (English-speaking intelligence alliance)
    FIVE_EYES_COUNTRIES: ['US', 'GB', 'CA', 'AU', 'NZ'],

    // Adversary nations - instant credibility nuke with Android/Web + VPN
    ADVERSARY_COUNTRIES: ['RU', 'CN', 'IR', 'KP'],

    // Bot farm risk countries - severe penalty with Android/Web + VPN
    BOT_FARM_COUNTRIES: ['IN', 'BD', 'PK', 'PH', 'NG', 'VN', 'ID', 'EG'],

    // Region to risk mapping (X uses regional strings like "South Asia", "Eastern Europe")
    REGION_RISK: {
      // High risk regions
      'south asia': 'high',
      'eastern europe': 'high',
      'southeast asia': 'medium',
      'middle east': 'medium',
      'africa': 'medium',
      // Low risk regions
      'north america': 'low',
      'western europe': 'low',
      'europe': 'low',
      'oceania': 'low',
      'australia': 'low',
      // Neutral
      'latin america': 'neutral',
      'south america': 'neutral',
      'east asia': 'neutral',
      'asia': 'neutral',
      'asia pacific': 'neutral'
    },

    // Legacy - keeping for backwards compatibility but using new system
    MAJOR_GEO_COUNTRIES: ['US', 'RU', 'CN', 'IR', 'KP', 'IL', 'UA', 'TW', 'SA'],

    // Neighboring country pairs (for tier adjustment)
    NEIGHBORING_COUNTRIES: {
      'US': ['CA', 'MX'],
      'CA': ['US'],
      'MX': ['US', 'GT', 'BZ'],
      'GB': ['IE'],
      'IE': ['GB'],
      'DE': ['AT', 'CH', 'FR', 'PL', 'NL', 'BE', 'CZ', 'DK'],
      'FR': ['DE', 'ES', 'IT', 'CH', 'BE'],
      'ES': ['PT', 'FR'],
      'PT': ['ES'],
      'IT': ['FR', 'CH', 'AT'],
      'CH': ['DE', 'FR', 'IT', 'AT'],
      'AT': ['DE', 'CH', 'IT', 'HU', 'CZ'],
      'PL': ['DE', 'CZ', 'UA'],
      'UA': ['PL', 'RO', 'HU'],
      'RU': ['UA', 'BY', 'KZ'],
      'CN': ['HK', 'TW', 'KR', 'JP', 'VN'],
      'HK': ['CN'],
      'TW': ['CN'],
      'JP': ['KR'],
      'KR': ['JP'],
      'AU': ['NZ'],
      'NZ': ['AU']
    },

    /**
     * Extract auth tokens from page for API access
     */
    extractAuthTokens() {
      // Get CSRF token from cookies
      const cookies = document.cookie;
      this.csrfToken = cookies.match(/ct0=([^;]+)/)?.[1] || null;

      // Try to extract bearer token from page scripts
      // X embeds the auth token in their main JS bundle
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';
        // Look for bearer token pattern in script content
        const bearerMatch = content.match(/Bearer\s+(AAAAAAAAAAAAA[A-Za-z0-9%]+)/);
        if (bearerMatch && bearerMatch[1] !== this.PUBLIC_BEARER) {
          this.authToken = bearerMatch[1];
          break;
        }
      }

      // Also check window object for exposed tokens
      if (!this.authToken && window.__INITIAL_STATE__) {
        // Sometimes token is in initial state
        const stateStr = JSON.stringify(window.__INITIAL_STATE__);
        const match = stateStr.match(/Bearer\s+(AAAAAAAAAAAAA[A-Za-z0-9%]+)/);
        if (match) {
          this.authToken = match[1];
        }
      }

      // Fallback to public token
      if (!this.authToken) {
        this.authToken = this.PUBLIC_BEARER;
      }

    },

    /**
     * Initialize the extension
     */
    async init() {
      console.log('[XCred] Initializing...');

      // Load settings
      await this.loadSettings();

      if (!this.config.enabled) {
        console.log('[XCred] Extension disabled');
        return;
      }

      // Extract auth tokens for API access
      this.extractAuthTokens();

      // Process existing tweets
      this.processTimeline();

      // Observe for new tweets
      this.observeTimeline();

      console.log('[XCred] Initialized successfully');
    },

    /**
     * Load settings from storage
     */
    async loadSettings() {
      try {
        const result = await chrome.storage.sync.get(['xlocation_settings']);
        if (result.xlocation_settings) {
          this.config = { ...this.config, ...result.xlocation_settings };
        }
      } catch (e) {
        console.warn('[XCred] Could not load settings:', e);
      }
    },

    /**
     * Find all tweet articles in the page
     */
    findTweets() {
      return document.querySelectorAll('article[data-testid="tweet"]');
    },

    /**
     * Extract username from a tweet element
     * @param {Element} tweetElement - The tweet article element
     * @returns {string|null} Username without @ or null
     */
    extractUsername(tweetElement) {
      // Look for the username link
      const userLinks = tweetElement.querySelectorAll('a[href^="/"]');

      for (const link of userLinks) {
        const href = link.getAttribute('href');
        // Match pattern: /username (no additional path segments)
        const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
        if (match && match[1] !== 'home' && match[1] !== 'explore' && match[1] !== 'notifications') {
          // Verify this is in the user info section, not in tweet content
          const isInHeader = link.closest('[data-testid="User-Name"]') !== null;
          if (isInHeader) {
            return match[1];
          }
        }
      }

      // Fallback: look for @username text
      const userNameDiv = tweetElement.querySelector('[data-testid="User-Name"]');
      if (userNameDiv) {
        const text = userNameDiv.textContent;
        const atMatch = text.match(/@([a-zA-Z0-9_]+)/);
        if (atMatch) {
          return atMatch[1];
        }
      }

      return null;
    },

    /**
     * Find the avatar container to inject the indicator below
     * @param {Element} tweetElement - The tweet article element
     * @returns {Element|null} The avatar container element for injection
     */
    findInjectionTarget(tweetElement) {
      // Try to find the avatar container using common X/Twitter selectors
      // The avatar is typically in the first column of the tweet layout

      // Method 1: Look for avatar by data-testid
      const avatarByTestId = tweetElement.querySelector('[data-testid="Tweet-User-Avatar"]');
      if (avatarByTestId) {
        return avatarByTestId;
      }

      // Method 2: Look for the avatar link (links to profile with just username)
      // The avatar is usually the first profile link that contains an img
      const profileLinks = tweetElement.querySelectorAll('a[href^="/"]');
      for (const link of profileLinks) {
        const href = link.getAttribute('href');
        // Match pattern: /username (no additional path segments)
        if (href && /^\/[a-zA-Z0-9_]+$/.test(href)) {
          // Check if this link contains an image (avatar)
          const hasImage = link.querySelector('img') ||
                          link.querySelector('[style*="background-image"]') ||
                          link.querySelector('div[style*="background"]');
          if (hasImage) {
            return link;
          }
        }
      }

      // Method 3: Fallback - find the first img in the tweet that looks like an avatar
      // Avatars are typically small circular images at the start
      const images = tweetElement.querySelectorAll('img');
      for (const img of images) {
        const src = img.getAttribute('src') || '';
        // Twitter profile images contain "profile_images" in the URL
        if (src.includes('profile_images')) {
          // Return the closest link or container
          const container = img.closest('a') || img.parentElement;
          if (container) {
            return container;
          }
        }
      }

      return null;
    },

    /**
     * Process all tweets in the timeline
     */
    processTimeline() {
      const tweets = this.findTweets();
      tweets.forEach(tweet => this.processTweet(tweet));
    },

    /**
     * Process a single tweet
     * @param {Element} tweetElement - The tweet article element
     */
    async processTweet(tweetElement) {
      // Skip if indicator already exists on this element (more reliable than WeakSet)
      if (tweetElement.querySelector('.xlocation-indicator')) {
        return;
      }

      const username = this.extractUsername(tweetElement);
      if (!username) {
        return;
      }

      // ALWAYS check cache first
      try {
        const cached = await XLocationCache.get(username);
        if (cached && !cached.rateLimited) {
          this.injectIndicator(tweetElement, cached);
          return;
        }
      } catch (e) {
        // Cache lookup failed, continue to API
      }

      // Not in cache (both memory and IndexedDB missed) - check if we're already fetching this user
      if (this.pendingRequests.has(username)) {
        // Add this element to the pending request's element list
        this.pendingRequests.get(username).elements.push(tweetElement);
        return;
      }

      // Queue profile fetch (will check rate limits internally)
      this.queueProfileFetch(username, tweetElement);
    },

    /**
     * Queue a profile fetch request
     * @param {string} username - The username to fetch
     * @param {Element} tweetElement - The tweet element to update
     */
    queueProfileFetch(username, tweetElement) {
      // Don't queue if already at max queue size
      if (this.requestQueue.length >= this.MAX_QUEUE_SIZE) {
        return;
      }

      // Don't queue if already in queue (prevent duplicates)
      if (this.requestQueue.includes(username)) {
        return;
      }

      // Create pending request entry
      this.pendingRequests.set(username, {
        elements: [tweetElement]
      });

      this.requestQueue.push(username);
      this.processRequestQueue();
    },

    /**
     * Process the request queue with rate limiting and batching
     */
    async processRequestQueue() {
      if (this.isProcessingQueue || this.requestQueue.length === 0) {
        return;
      }

      // Check if we're in a rate limit pause
      if (this.RATE_LIMIT_PAUSED && Date.now() < this.RATE_LIMIT_PAUSE_UNTIL) {
        // Schedule retry after pause ends
        setTimeout(() => this.processRequestQueue(), this.RATE_LIMIT_PAUSE_UNTIL - Date.now() + 100);
        return;
      }

      // Clear pause flag if time has passed
      if (this.RATE_LIMIT_PAUSED && Date.now() >= this.RATE_LIMIT_PAUSE_UNTIL) {
        this.RATE_LIMIT_PAUSED = false;
      }

      this.isProcessingQueue = true;

      // Process in batches
      while (this.requestQueue.length > 0) {
        // Check for rate limit pause during processing
        if (this.RATE_LIMIT_PAUSED) {
          this.isProcessingQueue = false;
          this.processRequestQueue(); // Will handle the pause
          return;
        }

        // Process one batch
        const batchSize = Math.min(this.BATCH_SIZE, this.requestQueue.length);

        for (let i = 0; i < batchSize; i++) {
          if (this.RATE_LIMIT_PAUSED) break;

          const username = this.requestQueue.shift();
          if (username) {
            await this.fetchProfile(username);
            // Delay between individual requests within a batch
            await new Promise(resolve => setTimeout(resolve, this.RATE_LIMIT_DELAY));
          }
        }

        // If there are more requests, wait before next batch
        if (this.requestQueue.length > 0 && !this.RATE_LIMIT_PAUSED) {
          await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY));
        }
      }

      this.isProcessingQueue = false;
    },

    /**
     * Fetch profile data from X via GraphQL API (optimized)
     * @param {string} username - The username to fetch
     */
    async fetchProfile(username) {
      const pending = this.pendingRequests.get(username);
      if (!pending) return;

      // CRITICAL: Check cache AGAIN right before API call
      // User might have been cached while waiting in queue
      try {
        const cached = await XLocationCache.get(username);
        if (cached && !cached.rateLimited && !cached.error) {
          pending.elements.forEach(element => {
            if (document.contains(element) && !element.querySelector('.xlocation-indicator')) {
              this.injectIndicator(element, cached);
            }
          });
          this.pendingRequests.delete(username);
          return;
        }
      } catch (e) {
        // Continue to API call if cache check fails
      }

      try {
        // Lightweight API-only approach
        let profileData = await this.fetchFromAPI(username);

        // Handle rate limiting - try cache first, then re-queue
        if (profileData && profileData.rateLimited) {
          // Try to show cached data even if we're rate limited
          try {
            const cached = await XLocationCache.get(username);
            if (cached && !cached.rateLimited && !cached.error) {
              pending.elements.forEach(element => {
                if (document.contains(element)) {
                  this.injectIndicator(element, cached);
                }
              });
              this.pendingRequests.delete(username);
              return;
            }
          } catch (e) {
            // Ignore cache errors during rate limit fallback
          }

          // No cached data - re-queue for later
          this.requestQueue.push(username);
          return; // Keep pending request for retry
        }

        if (!profileData) {
          profileData = {
            username: username,
            location: null,
            locationCountry: null,
            error: true
          };
        }

        // Cache the result (skip rate limit errors)
        await XLocationCache.set(username, profileData, true);

        // Update all tweet elements for this user
        pending.elements.forEach(element => {
          if (document.contains(element)) {
            this.injectIndicator(element, profileData);
          }
        });

        this.pendingRequests.delete(username);

      } catch (e) {
        // Cache the failure to avoid repeated requests (but with short TTL)
        await XLocationCache.set(username, {
          username: username,
          location: null,
          locationCountry: null,
          error: true
        });
        this.pendingRequests.delete(username);
      }
    },

    /**
     * Fetch profile data from X's AboutAccountQuery GraphQL API
     * This endpoint is specifically for the /about page and contains location data
     * @param {string} username - The username to fetch
     * @returns {object|null} Profile data or null
     */
    async fetchFromAPI(username) {
      try {
        // Ensure we have auth tokens
        if (!this.csrfToken) {
          this.extractAuthTokens();
        }

        if (!this.csrfToken) {
          return null;
        }

        // AboutAccountQuery uses camelCase screenName
        const variables = JSON.stringify({
          screenName: username
        });

        // AboutAccountQuery - dedicated endpoint for about page data
        // Query ID: XRqGa7EeokUU5kppkh13EA
        const response = await fetch(
          `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(variables)}`,
          {
            credentials: 'include',
            headers: {
              'authorization': `Bearer ${this.authToken}`,
              'x-csrf-token': this.csrfToken,
              'x-twitter-active-user': 'yes',
              'x-twitter-auth-type': 'OAuth2Session',
              'x-twitter-client-language': 'en',
              'content-type': 'application/json'
            }
          }
        );

        // Handle rate limiting - pause all requests with exponential backoff
        if (response.status === 429) {
          this.RATE_LIMIT_CONSECUTIVE++;

          // Exponential backoff: double pause duration on each consecutive 429, up to max
          this.RATE_LIMIT_CURRENT_PAUSE = Math.min(
            this.RATE_LIMIT_BASE_PAUSE * Math.pow(1.5, this.RATE_LIMIT_CONSECUTIVE - 1),
            this.RATE_LIMIT_MAX_PAUSE
          );

          const pauseSeconds = Math.round(this.RATE_LIMIT_CURRENT_PAUSE / 1000);
          console.warn(`[XCred] Rate limited! (${this.RATE_LIMIT_CONSECUTIVE}x) Pausing for ${pauseSeconds}s...`);

          this.RATE_LIMIT_PAUSED = true;
          this.RATE_LIMIT_PAUSE_UNTIL = Date.now() + this.RATE_LIMIT_CURRENT_PAUSE;
          this.RATE_LIMIT_DELAY = Math.min(this.RATE_LIMIT_DELAY * 1.5, 2000);

          // Show prompt to enable remote sync if disabled
          if (typeof XLocationRemote !== 'undefined' && !XLocationRemote.isEnabled && XLocationRemote.isConfigured) {
            XLocationRemote.showRateLimitPrompt();
          }

          // Return special marker so we don't cache this as a permanent error
          return { rateLimited: true };
        }

        if (!response.ok) {
          return null;
        }

        // Reset rate limit counters on success
        this.RATE_LIMIT_DELAY = 500;
        this.RATE_LIMIT_CONSECUTIVE = 0;
        this.RATE_LIMIT_CURRENT_PAUSE = this.RATE_LIMIT_BASE_PAUSE;

        const data = await response.json();
        return this.parseAPIResponse(data, username);

      } catch (e) {
        return null;
      }
    },

    /**
     * Detect party affiliation from affiliate username
     * @param {string} affiliateUsername - The affiliate username (e.g., "HouseDemocrats")
     * @returns {string|null} 'democrat', 'republican', 'other', or null
     */
    detectPartyAffiliation(affiliateUsername) {
      if (!affiliateUsername) return null;

      const affiliate = affiliateUsername.toLowerCase();

      // Check Democrat affiliates
      for (const keyword of this.DEMOCRAT_AFFILIATES) {
        if (affiliate.includes(keyword)) {
          return 'democrat';
        }
      }

      // Check Republican affiliates
      for (const keyword of this.REPUBLICAN_AFFILIATES) {
        if (affiliate.includes(keyword)) {
          return 'republican';
        }
      }

      // Has affiliate but unknown party
      return 'other';
    },

    /**
     * Parse the AboutAccountQuery GraphQL API response
     * Response structure: data.user_result_by_screen_name.result.about_profile
     * @param {object} data - API response data
     * @param {string} username - Username for logging
     * @returns {object|null} Parsed profile data
     */
    parseAPIResponse(data, username) {
      try {
        // AboutAccountQuery response path
        const user = data?.data?.user_result_by_screen_name?.result;
        if (!user) {
          return null;
        }

        const aboutProfile = user.about_profile || {};
        const core = user.core || {};
        const verification = user.verification || {};

        // Check for government verification
        const isGovernmentVerified = verification.verified_type === 'Government';
        const affiliateUsername = aboutProfile.affiliate_username || null;
        const party = isGovernmentVerified ? this.detectPartyAffiliation(affiliateUsername) : null;

        // Check for business verification (verified_type === 'Business')
        const isBusinessVerified = verification.verified_type === 'Business';
        const isBlueVerified = user.is_blue_verified || (verification.verified && !isGovernmentVerified && !isBusinessVerified);

        const profileData = {
          username: username,
          location: null,
          locationCountry: null,
          displayLocation: null, // AboutAccountQuery doesn't include self-reported location
          accountBasedIn: null,
          connectedVia: null,
          vpnDetected: false,
          locationAccurate: true,
          usernameChanges: 0,
          verified: isBlueVerified || isBusinessVerified || isGovernmentVerified,
          isBlueVerified: isBlueVerified,
          isBusinessVerified: isBusinessVerified,
          displayName: core.name || username,
          // createdAt is ALWAYS present in valid API responses - used to detect failed fetches
          createdAt: aboutProfile.created_at || user.created_at || null,
          screenName: core.screen_name || username,
          // Government verification fields
          isGovernmentVerified: isGovernmentVerified,
          verifiedType: verification.verified_type || null,
          party: party,
          affiliateUsername: affiliateUsername,
          // Tier will be calculated later
          tier: null
        };

        // Extract from about_profile structure
        // Structure: { account_based_in, location_accurate, source, username_changes }
        if (aboutProfile) {
          // "Account based in" - IP-derived location from X
          profileData.accountBasedIn = aboutProfile.account_based_in || null;

          // "source" is where they connected from (e.g., "United States App Store")
          profileData.connectedVia = aboutProfile.source || null;

          // KEY FIELD: location_accurate === false means VPN/proxy detected
          // When true or undefined, treat as accurate
          profileData.locationAccurate = aboutProfile.location_accurate !== false;
          profileData.vpnDetected = aboutProfile.location_accurate === false;

          // Username changes count
          if (aboutProfile.username_changes) {
            profileData.usernameChanges = parseInt(aboutProfile.username_changes.count, 10) || 0;
          }
        }

        // Parse country from account_based_in location
        if (profileData.accountBasedIn) {
          profileData.location = profileData.accountBasedIn;
          profileData.locationCountry = XLocationFlags.parseLocation(profileData.accountBasedIn);
        }

        // Calculate credibility tier (government accounts get special 'government' tier)
        profileData.tier = this.calculateTier(profileData);

        return profileData;

      } catch (e) {
        return null;
      }
    },

    /**
     * Extract country code from App Store/Play Store string
     * @param {string} connectedVia - e.g., "United States App Store", "Russian Federation Android App"
     * @returns {string|null} Country code or null
     */
    extractAppStoreCountry(connectedVia) {
      if (!connectedVia) return null;
      // Parse the country name from the string
      return XLocationFlags.parseLocation(connectedVia);
    },

    /**
     * Check if two countries are neighbors
     * @param {string} country1 - First country code
     * @param {string} country2 - Second country code
     * @returns {boolean} True if neighbors
     */
    isNeighboringCountries(country1, country2) {
      if (!country1 || !country2) return false;
      const neighbors = this.NEIGHBORING_COUNTRIES[country1];
      return neighbors && neighbors.includes(country2);
    },

    /**
     * Check if this is a major geopolitical mismatch (tier 5 worthy)
     * @param {string} accountCountry - Account based in country
     * @param {string} appStoreCountry - App store country
     * @returns {boolean} True if major mismatch
     */
    isMajorGeopoliticalMismatch(accountCountry, appStoreCountry) {
      if (!accountCountry || !appStoreCountry) return false;

      // Both countries must be different
      if (accountCountry === appStoreCountry) return false;

      // Check if either is a major geopolitical country
      const accountIsMajor = this.MAJOR_GEO_COUNTRIES.includes(accountCountry);
      const appStoreIsMajor = this.MAJOR_GEO_COUNTRIES.includes(appStoreCountry);

      // Major mismatch if connecting from adversary nation's app store
      // e.g., US account using Russian app store, or vice versa
      if (accountIsMajor && appStoreIsMajor && accountCountry !== appStoreCountry) {
        return true;
      }

      // Or if a major nation is misrepresented
      if ((accountIsMajor || appStoreIsMajor) && !this.isNeighboringCountries(accountCountry, appStoreCountry)) {
        return true;
      }

      return false;
    },

    /**
     * Calculate account age in years from createdAt date
     * @param {string} createdAt - ISO date string or X date format
     * @returns {number} Age in years (decimal)
     */
    calculateAccountAge(createdAt) {
      if (!createdAt) return 0;

      try {
        const created = new Date(createdAt);
        if (isNaN(created.getTime())) return 0;

        const now = new Date();
        const ageMs = now - created;
        const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
        return Math.max(0, ageYears);
      } catch (e) {
        return 0;
      }
    },

    /**
     * Determine platform type from connectedVia string
     * @param {string} connectedVia - e.g., "United States App Store", "Android App", "Web"
     * @returns {string} 'ios' | 'android' | 'web'
     */
    getPlatformType(connectedVia) {
      if (!connectedVia) return 'web';
      const lower = connectedVia.toLowerCase();
      if (lower.includes('app store')) return 'ios';
      if (lower.includes('android')) return 'android';
      return 'web';
    },

    /**
     * Check if country is in Five Eyes alliance
     * @param {string} countryCode - Two-letter country code
     * @returns {boolean}
     */
    isFiveEyes(countryCode) {
      return countryCode && this.FIVE_EYES_COUNTRIES.includes(countryCode);
    },

    /**
     * Check if country/region is adversary nation
     * @param {string} countryCode - Two-letter country code
     * @param {string} accountBasedIn - Raw "Account based in" string (may be region)
     * @returns {boolean}
     */
    isAdversaryOrigin(countryCode, accountBasedIn) {
      if (countryCode && this.ADVERSARY_COUNTRIES.includes(countryCode)) {
        return true;
      }
      // Check regional strings
      if (accountBasedIn) {
        const lower = accountBasedIn.toLowerCase();
        if (lower.includes('russia') || lower.includes('china') || lower.includes('iran') || lower.includes('north korea')) {
          return true;
        }
      }
      return false;
    },

    /**
     * Check if country/region is known bot farm origin
     * @param {string} countryCode - Two-letter country code
     * @param {string} accountBasedIn - Raw "Account based in" string (may be region)
     * @returns {boolean}
     */
    isBotFarmOrigin(countryCode, accountBasedIn) {
      if (countryCode && this.BOT_FARM_COUNTRIES.includes(countryCode)) {
        return true;
      }
      // Check regional strings
      if (accountBasedIn) {
        const lower = accountBasedIn.toLowerCase();
        const risk = this.REGION_RISK[lower];
        if (risk === 'high') return true;
      }
      return false;
    },

    /**
     * Get region risk level from accountBasedIn string
     * @param {string} accountBasedIn - Raw "Account based in" string
     * @returns {string} 'high' | 'medium' | 'low' | 'neutral' | null
     */
    getRegionRisk(accountBasedIn) {
      if (!accountBasedIn) return null;
      const lower = accountBasedIn.toLowerCase().trim();
      return this.REGION_RISK[lower] || null;
    },

    /**
     * Check if there's a regional mismatch (e.g., "South Asia" account using "North America" app store)
     * @param {string} accountBasedIn - Account location string
     * @param {string} connectedVia - Connected via string
     * @returns {object} { isMismatch: boolean, accountRisk: string, appStoreRisk: string }
     */
    checkRegionalMismatch(accountBasedIn, connectedVia) {
      const accountRisk = this.getRegionRisk(accountBasedIn);
      const appStoreRisk = this.getRegionRisk(connectedVia);

      // If we have risk levels for both, check for significant mismatch
      if (accountRisk && appStoreRisk) {
        const isMismatch = (accountRisk === 'high' && appStoreRisk === 'low') ||
                          (accountRisk === 'medium' && appStoreRisk === 'low');
        return { isMismatch, accountRisk, appStoreRisk };
      }

      return { isMismatch: false, accountRisk, appStoreRisk };
    },

    /**
     * Calculate credibility score based on all factors with full transparency logging
     * @param {object} profileData - The profile data
     * @returns {object} Score breakdown { total, factors, instantTier, accountAge, debug }
     */
    calculateCredibilityScore(profileData) {
      const factors = [];
      let score = 0;
      let instantTier = null; // For instant nuke scenarios

      const connectedVia = profileData.connectedVia || '';
      const accountBasedIn = profileData.accountBasedIn || '';
      const platform = this.getPlatformType(connectedVia);
      const hasVPN = profileData.vpnDetected;
      const usernameChanges = profileData.usernameChanges || 0;
      const accountCountry = profileData.locationCountry;
      const appStoreCountry = this.extractAppStoreCountry(connectedVia);
      const accountAge = this.calculateAccountAge(profileData.createdAt);

      // Location match checks
      const locationMatch = accountCountry && appStoreCountry && accountCountry === appStoreCountry;
      const isNeighbor = accountCountry && appStoreCountry && this.isNeighboringCountries(accountCountry, appStoreCountry);
      const bothFiveEyes = this.isFiveEyes(accountCountry) && this.isFiveEyes(appStoreCountry);
      const isAdversary = this.isAdversaryOrigin(accountCountry, accountBasedIn);
      const isBotFarm = this.isBotFarmOrigin(accountCountry, accountBasedIn);
      const regionalMismatch = this.checkRegionalMismatch(accountBasedIn, connectedVia);

      // === INSTANT NUKE CHECK ===
      // Adversary nation + Android/Web + VPN = instant Tier 5
      if (isAdversary && (platform === 'android' || platform === 'web') && hasVPN) {
        instantTier = 5;
        factors.push({ name: 'ADVERSARY + Android/Web + VPN', value: 'NUKE', type: 'critical' });
        debug.push('*** INSTANT TIER 5: Adversary nation + Android/Web + VPN ***');
      }

      // === PLATFORM BASE TRUST ===
      if (platform === 'ios') {
        score += 1;
        factors.push({ name: 'iOS platform', value: +1 });
      } else if (platform === 'web') {
        score -= 1;
        factors.push({ name: 'Web platform (less trusted)', value: -1 });
      }
      // Android is neutral (0)

      // === LOCATION MATCH BONUSES ===
      if (locationMatch) {
        if (platform === 'ios') {
          score += 3;
          factors.push({ name: 'iOS + geo match', value: +3 });
        } else if (platform === 'android') {
          score += 2;
          factors.push({ name: 'Android + geo match', value: +2 });
        } else {
          score += 1;
          factors.push({ name: 'Web + geo match', value: +1 });
        }
      } else if (isNeighbor && !hasVPN) {
        score += 1;
        factors.push({ name: 'Neighbor country (no VPN)', value: +1 });
      }

      // === VERIFICATION BONUSES ===
      if (profileData.isBusinessVerified) {
        score += 3;
        factors.push({ name: 'Business verified', value: +3 });
      } else if (profileData.isBlueVerified) {
        score += 2;
        factors.push({ name: 'Blue verified', value: +2 });
      }

      // === ACCOUNT AGE BONUSES ===
      if (accountAge >= 5) {
        score += 3;
        factors.push({ name: 'Account 5yr+', value: +3 });
      } else if (accountAge >= 3) {
        score += 2;
        factors.push({ name: 'Account 3-5yr', value: +2 });
      } else if (accountAge >= 1) {
        score += 1;
        factors.push({ name: 'Account 1-3yr', value: +1 });
      }

      // === VPN PENALTIES (Context-Aware) ===
      if (hasVPN) {
        if (locationMatch && platform === 'ios') {
          // iOS + VPN + geo match = privacy-conscious user, minimal penalty
          score -= 1;
          factors.push({ name: 'VPN (iOS + geo match)', value: -1 });
        } else if (bothFiveEyes) {
          // Five Eyes VPN corridor - reduced penalty
          score -= 1;
          factors.push({ name: 'VPN (Five Eyes corridor)', value: -1 });
        } else if (platform === 'ios') {
          // iOS + VPN + mismatch - standard penalty
          score -= 2;
          factors.push({ name: 'VPN (iOS + mismatch)', value: -2 });
        } else if (isBotFarm) {
          // Bot farm origin + Android/Web + VPN - severe
          score -= 4;
          factors.push({ name: 'VPN (bot farm + Android/Web)', value: -4 });
        } else {
          // Android/Web + VPN + mismatch - suspicious
          score -= 3;
          factors.push({ name: 'VPN (Android/Web + mismatch)', value: -3 });
        }
      }

      // === GEO MISMATCH PENALTIES (No VPN) ===
      if (!hasVPN && !locationMatch && appStoreCountry) {
        if (platform === 'ios') {
          // iOS + no VPN + mismatch = likely expat/traveler, no penalty
          factors.push({ name: 'Geo mismatch (iOS, no VPN)', value: 0, note: 'likely expat/traveler' });
        } else if (platform === 'android') {
          score -= 1;
          factors.push({ name: 'Geo mismatch (Android, no VPN)', value: -1 });
        } else {
          score -= 2;
          factors.push({ name: 'Geo mismatch (Web, no VPN)', value: -2 });
        }
      }

      // === REGIONAL MISMATCH PENALTY ===
      if (regionalMismatch.isMismatch) {
        score -= 2;
        factors.push({ name: `Regional mismatch (${regionalMismatch.accountRisk} → ${regionalMismatch.appStoreRisk})`, value: -2 });
      }

      // === USERNAME CHANGES PENALTY ===
      if (usernameChanges >= 10) {
        score -= 3;
        factors.push({ name: `${usernameChanges} username changes`, value: -3 });
      } else if (usernameChanges >= 6) {
        score -= 2;
        factors.push({ name: `${usernameChanges} username changes`, value: -2 });
      } else if (usernameChanges >= 3) {
        score -= 1;
        factors.push({ name: `${usernameChanges} username changes`, value: -1 });
      }

      return { total: score, factors, instantTier, accountAge };
    },

    /**
     * Calculate credibility tier based on profile data
     * Uses a scoring system with mitigating factors for verification and account age
     * @param {object} profileData - The profile data
     * @returns {number|string} Tier 1-6 or 'government'
     */
    calculateTier(profileData) {
      // Government verified accounts get special tier
      if (profileData.isGovernmentVerified) {
        return 'government';
      }

      // No location data = Tier 6
      if (!profileData.locationCountry && !profileData.accountBasedIn && !profileData.connectedVia) {
        return 6;
      }

      // Calculate credibility score
      const { total: score, instantTier } = this.calculateCredibilityScore(profileData);

      // Check for instant tier override (e.g., adversary + Android/Web + VPN)
      if (instantTier !== null) {
        return instantTier;
      }

      // Map score to tier
      // Score 6+: Tier 1 (Dark Blue) - Highest
      // Score 4-5: Tier 2 (Green) - High
      // Score 2-3: Tier 3 (Yellow) - Medium
      // Score 0-1: Tier 4 (Orange) - Low
      // Score -1 or below: Tier 5 (Red) - Suspicious
      if (score >= 6) {
        return 1;
      } else if (score >= 4) {
        return 2;
      } else if (score >= 2) {
        return 3;
      } else if (score >= 0) {
        return 4;
      } else {
        return 5;
      }
    },


    /**
     * Inject the location indicator below the avatar
     * @param {Element} tweetElement - The tweet article element
     * @param {object} profileData - The profile data
     */
    injectIndicator(tweetElement, profileData) {
      // Check if indicator already exists
      if (tweetElement.querySelector('.xlocation-indicator')) {
        return;
      }

      const avatarElement = this.findInjectionTarget(tweetElement);
      if (!avatarElement) {
        return;
      }

      // Create indicator element
      const indicator = this.createIndicator(profileData);

      // Create a wrapper to position the indicator below the avatar
      // We need to find or create a container that holds both avatar and indicator vertically
      const avatarContainer = avatarElement.parentElement;

      if (avatarContainer) {
        // Insert the indicator after the avatar element within its container
        avatarElement.insertAdjacentElement('afterend', indicator);
      } else {
        // Fallback: insert after avatar's parent
        avatarElement.parentNode.insertBefore(indicator, avatarElement.nextSibling);
      }
    },

    /**
     * Get the icon/emoji for government accounts based on party
     * @param {string|null} party - 'democrat', 'republican', 'other', or null
     * @returns {string} Emoji icon
     */
    // Government icon SVG URLs from govicons
    GOV_ICONS: {
      democrat: 'https://raw.githubusercontent.com/540co/govicons/refs/heads/develop/raw-svg/donkey.svg',
      republican: 'https://raw.githubusercontent.com/540co/govicons/refs/heads/develop/raw-svg/elephant.svg',
      other: null // Will use capitol emoji as fallback
    },

    /**
     * Get government icon URL and fallback emoji
     * @param {string} party - 'democrat', 'republican', or 'other'
     * @returns {object} { url: string|null, emoji: string, bgColor: string }
     */
    getGovernmentIcon(party) {
      switch (party) {
        case 'democrat':
          return {
            url: this.GOV_ICONS.democrat,
            emoji: '🫏',
            bgColor: '#0052A5' // Royal blue
          };
        case 'republican':
          return {
            url: this.GOV_ICONS.republican,
            emoji: '🐘',
            bgColor: '#BF0A30' // Red
          };
        case 'other':
        default:
          return {
            url: null,
            emoji: '🏛️',
            bgColor: '#C0C0C0' // Silver
          };
      }
    },

    /**
     * Get tier description for tooltips
     * @param {number|string} tier - Tier 1-6 or 'government'
     * @returns {string} Description
     */
    getTierDescription(tier) {
      // Normalize tier - convert string numbers to integers, preserve 'government'
      const normalizedTier = tier === 'government' ? tier : parseInt(tier, 10);
      switch (normalizedTier) {
        case 1:
          return 'Highest Credibility - iOS + Location Match + Clean History';
        case 2:
          return 'High Credibility - Verified Location Match';
        case 3:
          return 'Medium Credibility - Minor Issues Detected';
        case 4:
          return 'Low Credibility - Multiple Red Flags';
        case 5:
          return 'SUSPICIOUS - Major Location Mismatch';
        case 6:
          return 'Unknown - No Location Data';
        case 'government':
          return 'Government Verified Account';
        default:
          return 'Unknown Credibility';
      }
    },

    /**
     * Create the indicator element
     * @param {object} profileData - The profile data
     * @returns {Element} The indicator element
     */
    createIndicator(profileData) {
      const indicator = document.createElement('span');
      indicator.className = 'xlocation-indicator';

      // Calculate tier if not already set
      const rawTier = profileData.tier || this.calculateTier(profileData);
      // Normalize tier - convert string numbers to integers, preserve 'government'
      const tier = rawTier === 'government' ? rawTier : parseInt(rawTier, 10);

      // Add tier-specific class
      indicator.classList.add(`xlocation-tier-${tier}`);

      // Set border color based on tier
      const tierColor = this.TIER_COLORS[tier] || this.TIER_COLORS[6];
      indicator.style.borderColor = tierColor;

      // Handle government accounts specially
      if (profileData.isGovernmentVerified) {
        const govIcon = this.getGovernmentIcon(profileData.party);
        indicator.classList.add('xlocation-government');
        indicator.style.backgroundColor = govIcon.bgColor;
        indicator.style.borderColor = govIcon.bgColor;

        if (govIcon.url) {
          // Use SVG image for Democrat/Republican
          const iconImg = document.createElement('img');
          iconImg.src = govIcon.url;
          iconImg.alt = profileData.party;
          iconImg.className = 'xlocation-gov-icon';
          iconImg.onerror = () => {
            // Fallback to emoji if SVG fails to load
            iconImg.remove();
            indicator.textContent = govIcon.emoji;
          };
          indicator.appendChild(iconImg);
        } else {
          // Use emoji for 'other' government accounts
          indicator.textContent = govIcon.emoji;
        }
      }
      // Get flag (SVG image for countries, emoji for regions)
      else if (this.config.showFlags) {
        const flagUrl = profileData.locationCountry
          ? XLocationFlags.getFlagUrl(profileData.locationCountry)
          : null;

        if (flagUrl) {
          // Use SVG flag image
          const flagImg = document.createElement('img');
          flagImg.src = flagUrl;
          flagImg.alt = profileData.locationCountry;
          flagImg.className = 'xlocation-flag-img';
          flagImg.onerror = () => {
            // Fallback to emoji if image fails to load
            flagImg.remove();
            indicator.textContent = XLocationFlags.getFlagEmoji(profileData.locationCountry) || '🌐';
          };
          indicator.appendChild(flagImg);
        } else {
          // Use emoji for regions or unknown
          indicator.textContent = XLocationFlags.getFlagEmoji(profileData.locationCountry) || '🌐';
        }
      } else {
        // No flag display, just show globe for non-government
        indicator.textContent = '🌐';
      }

      // Add tooltip
      const tooltipText = this.getTooltipText(profileData);
      indicator.setAttribute('title', tooltipText);
      indicator.setAttribute('data-xlocation-tooltip', tooltipText);

      // Add click handler for detailed info
      indicator.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showDetailedInfo(profileData, indicator);
      });

      return indicator;
    },

    /**
     * Determine credibility class based on profile data
     * @param {object} profileData - The profile data
     * @returns {string} Credibility class name
     */
    getCredibilityClass(profileData) {
      // Error fetching
      if (profileData.error) {
        return 'unknown';
      }

      // VPN/Proxy detected (location_accurate === false)
      // This takes priority - orange warning
      if (profileData.vpnDetected || profileData.locationAccurate === false) {
        return 'vpn'; // Orange - VPN/proxy detected
      }

      // Has "Account based in" data (IP-based location from X)
      // This is the verified connection location
      if (profileData.accountBasedIn) {
        return 'match'; // Green - has verified connection location
      }

      // Has "Connected via" data but no "Account based in"
      // (e.g., "United States App Store")
      if (profileData.connectedVia) {
        return 'connection'; // Blue - has some connection data
      }

      return 'unknown';
    },

    /**
     * Get tooltip text for indicator
     * @param {object} profileData - The profile data
     * @returns {string} Tooltip text
     */
    getTooltipText(profileData) {
      const parts = [];
      const tier = profileData.tier || this.calculateTier(profileData);

      // Government account header
      if (profileData.isGovernmentVerified) {
        parts.push('✓ Government Verified Account');
        if (profileData.party === 'democrat') {
          parts.push('Affiliation: Democratic Party');
        } else if (profileData.party === 'republican') {
          parts.push('Affiliation: Republican Party');
        } else if (profileData.affiliateUsername) {
          parts.push(`Affiliate: @${profileData.affiliateUsername}`);
        }
        return parts.join('\n');
      }

      // Tier description
      parts.push(this.getTierDescription(tier));

      // VPN warning
      if (profileData.vpnDetected || profileData.locationAccurate === false) {
        parts.push('⚠ VPN/Proxy Detected');
      }

      if (profileData.accountBasedIn) {
        parts.push(`Account based in: ${profileData.accountBasedIn}`);
      }

      if (profileData.connectedVia) {
        parts.push(`Connected via: ${profileData.connectedVia}`);
      }

      if (profileData.usernameChanges > 0) {
        parts.push(`Username changes: ${profileData.usernameChanges}`);
      }

      if (parts.length === 1) {
        return 'No location data available';
      }

      return parts.join('\n');
    },

    /**
     * Detect if X is in dark mode by checking the background color
     * @returns {boolean} True if dark mode is active
     */
    isXDarkMode() {
      // X uses data-theme or background color to indicate dark mode
      const body = document.body;
      const bgColor = window.getComputedStyle(body).backgroundColor;

      // Parse RGB values
      const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (match) {
        const [, r, g, b] = match.map(Number);
        // Dark mode typically has low RGB values (dark background)
        const brightness = (r + g + b) / 3;
        return brightness < 128;
      }

      // Fallback: check for dark mode classes/attributes X might use
      return document.documentElement.classList.contains('dark') ||
             document.body.classList.contains('dark') ||
             document.documentElement.getAttribute('data-theme') === 'dark';
    },

    /**
     * Show detailed location info popup
     * @param {object} profileData - The profile data
     * @param {Element} indicator - The indicator element
     */
    showDetailedInfo(profileData, indicator) {
      // Remove any existing popup
      const existing = document.querySelector('.xlocation-popup');
      if (existing) {
        existing.remove();
      }

      const popup = document.createElement('div');
      popup.className = 'xlocation-popup';

      // Apply dark mode class based on X's current theme
      if (this.isXDarkMode()) {
        popup.classList.add('xlocation-dark');
      }

      const rawTier = profileData.tier || this.calculateTier(profileData);
      // Normalize tier - convert string numbers to integers, preserve 'government'
      const tier = rawTier === 'government' ? rawTier : parseInt(rawTier, 10);
      const tierColor = this.TIER_COLORS[tier] || this.TIER_COLORS[6];
      let statusText = '';
      let statusClass = '';

      // Handle government accounts
      if (profileData.isGovernmentVerified) {
        statusText = 'Government Verified';
        statusClass = 'xlocation-status-government';

        let partyText = '';
        const govIcon = this.getGovernmentIcon(profileData.party);
        if (profileData.party === 'democrat') {
          partyText = `<div class="xlocation-popup-party xlocation-party-democrat">
            <img src="${govIcon.url}" alt="Democrat" class="xlocation-party-icon-img" onerror="this.outerHTML='🫏'">
            <span>Democratic Party</span>
          </div>`;
        } else if (profileData.party === 'republican') {
          partyText = `<div class="xlocation-popup-party xlocation-party-republican">
            <img src="${govIcon.url}" alt="Republican" class="xlocation-party-icon-img" onerror="this.outerHTML='🐘'">
            <span>Republican Party</span>
          </div>`;
        } else if (profileData.affiliateUsername) {
          partyText = `<div class="xlocation-popup-row"><strong>Affiliate</strong>@${this.escapeHtml(profileData.affiliateUsername)}</div>`;
        }

        popup.innerHTML = `
          <div class="xlocation-popup-header">
            <span class="xlocation-popup-title">Government Account</span>
            <span class="xlocation-popup-close">&times;</span>
          </div>
          <div class="xlocation-popup-status ${statusClass}">${statusText}</div>
          ${partyText}
          <div class="xlocation-popup-content">
            ${profileData.usernameChanges > 0 ? `<div class="xlocation-popup-row"><strong>Username changes</strong>${profileData.usernameChanges}</div>` : ''}
          </div>
          <div class="xlocation-popup-footer">
            This account has been verified by X as an official government account.
          </div>
        `;
      } else {
        // Regular account - show tier-based status
        switch (tier) {
          case 1:
            statusText = 'Highest Credibility';
            statusClass = 'xlocation-status-tier1';
            break;
          case 2:
            statusText = 'High Credibility';
            statusClass = 'xlocation-status-tier2';
            break;
          case 3:
            statusText = 'Medium Credibility';
            statusClass = 'xlocation-status-tier3';
            break;
          case 4:
            statusText = 'Low Credibility';
            statusClass = 'xlocation-status-tier4';
            break;
          case 5:
            statusText = 'SUSPICIOUS';
            statusClass = 'xlocation-status-tier5';
            break;
          default:
            statusText = 'No Location Data';
            statusClass = 'xlocation-status-tier6';
        }

        const isVpn = profileData.vpnDetected || profileData.locationAccurate === false;

        // Calculate score breakdown for display
        const scoreData = this.calculateCredibilityScore(profileData);
        const accountAge = scoreData.accountAge;
        const ageDisplay = accountAge >= 1 ? `${Math.floor(accountAge)}yr` : `${Math.floor(accountAge * 12)}mo`;

        // Build score factors HTML with full transparency
        let factorsHtml = '';
        if (scoreData.factors.length > 0) {
          const factorChips = scoreData.factors.map(f => {
            // Handle special "NUKE" values for instant tier assignments
            if (f.type === 'critical') {
              return `<span class="xlocation-factor critical">${f.name}</span>`;
            }
            // Handle zero-value factors with notes
            if (f.value === 0 && f.note) {
              return `<span class="xlocation-factor neutral">${f.name}</span>`;
            }
            // Regular positive/negative factors
            const valueStr = typeof f.value === 'number' ? (f.value >= 0 ? `+${f.value}` : `${f.value}`) : f.value;
            const className = f.value > 0 ? 'positive' : (f.value < 0 ? 'negative' : 'neutral');
            return `<span class="xlocation-factor ${className}">${valueStr} ${f.name}</span>`;
          }).join('');

          factorsHtml = `
            <div class="xlocation-popup-score">
              <div class="xlocation-popup-row"><strong>Credibility Score</strong>${scoreData.instantTier ? 'OVERRIDE' : (scoreData.total >= 0 ? '+' : '') + scoreData.total}</div>
              <div class="xlocation-score-factors">
                ${factorChips}
              </div>
            </div>
          `;
        }

        popup.innerHTML = `
          <div class="xlocation-popup-header">
            <span class="xlocation-popup-title">Location Info</span>
            <span class="xlocation-popup-close">&times;</span>
          </div>
          <div class="xlocation-popup-status ${statusClass}" style="border-left: 4px solid ${tierColor};">${statusText}</div>
          ${isVpn ? `<div class="xlocation-popup-vpn-warning">
            <strong>⚠ Warning:</strong> X has indicated this account may be connecting via a proxy or VPN, which may change the displayed location.
          </div>` : ''}
          <div class="xlocation-popup-content">
            ${profileData.accountBasedIn ? `<div class="xlocation-popup-row"><strong>Account based in</strong>${this.escapeHtml(profileData.accountBasedIn)}</div>` : ''}
            ${profileData.connectedVia ? `<div class="xlocation-popup-row"><strong>Connected via</strong>${this.escapeHtml(profileData.connectedVia)}</div>` : ''}
            ${profileData.createdAt ? `<div class="xlocation-popup-row"><strong>Account age</strong>${ageDisplay}</div>` : ''}
            ${profileData.usernameChanges > 0 ? `<div class="xlocation-popup-row"><strong>Username changes</strong>${profileData.usernameChanges}</div>` : ''}
            ${profileData.isBlueVerified ? `<div class="xlocation-popup-row"><strong>Verification</strong>Blue verified</div>` : ''}
            ${profileData.isBusinessVerified ? `<div class="xlocation-popup-row"><strong>Verification</strong>Business verified</div>` : ''}
          </div>
          ${factorsHtml}
          <div class="xlocation-popup-footer">
            Data from X's account transparency info
          </div>
        `;
      }

      // Position popup using absolute positioning (scrolls with page)
      const rect = indicator.getBoundingClientRect();
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

      popup.style.position = 'absolute';
      popup.style.top = `${rect.bottom + scrollTop + 8}px`;
      popup.style.left = `${rect.left + scrollLeft}px`;

      document.body.appendChild(popup);

      // Adjust if popup goes off-screen to the right
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.right > window.innerWidth - 16) {
        popup.style.left = `${window.innerWidth - popupRect.width - 16 + scrollLeft}px`;
      }

      // Close button handler
      popup.querySelector('.xlocation-popup-close').addEventListener('click', () => {
        popup.remove();
      });

      // Close on click outside
      const closeHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== indicator) {
          popup.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => {
        document.addEventListener('click', closeHandler);
      }, 0);
    },

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} Escaped text
     */
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },

    /**
     * Observe timeline for new tweets
     */
    observeTimeline() {
      const observer = new MutationObserver((mutations) => {
        let shouldProcess = false;

        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            shouldProcess = true;
            break;
          }
        }

        if (shouldProcess) {
          // Debounce processing
          if (this.processTimeout) {
            clearTimeout(this.processTimeout);
          }
          this.processTimeout = setTimeout(() => {
            this.processTimeline();
          }, 100);
        }
      });

      // Observe the main content area
      const target = document.querySelector('main') || document.body;
      observer.observe(target, {
        childList: true,
        subtree: true
      });
    }
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => XLocation.init());
  } else {
    XLocation.init();
  }

  // Listen for settings updates
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.xlocation_settings) {
      XLocation.config = { ...XLocation.config, ...changes.xlocation_settings.newValue };

      // Update remote cache enabled state
      if (typeof XLocationRemote !== 'undefined') {
        XLocationRemote.isEnabled = changes.xlocation_settings.newValue.remoteSync !== false;
        XLocationCache.useRemoteCache = XLocationRemote.isEnabled;
      }

      console.log('[XCred] Settings updated');
    }
  });

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SYNC_TO_REMOTE') {
      // Trigger sync from IndexedDB to remote
      if (typeof XLocationRemote !== 'undefined' && XLocationRemote.isEnabled) {
        XLocationRemote.syncLocalToRemote().then(() => {
          sendResponse({ success: true });
        }).catch(e => {
          sendResponse({ success: false, error: e.message });
        });
        return true; // Keep channel open for async response
      }
      sendResponse({ success: false, error: 'Remote not enabled' });
    }

    if (message.type === 'GET_REMOTE_STATUS') {
      console.log('[XCred Content] GET_REMOTE_STATUS received');
      // Get remote cache status
      if (typeof XLocationRemote !== 'undefined') {
        const configured = XLocationRemote.isConfigured;
        console.log('[XCred Content] XLocationRemote configured:', configured);
        if (!configured) {
          sendResponse({ configured: false });
          return;
        }

        console.log('[XCred Content] Calling getStats()...');
        XLocationRemote.getStats().then(stats => {
          console.log('[XCred Content] getStats() returned:', stats);
          sendResponse({
            configured: true,
            enabled: XLocationRemote.isEnabled,
            totalProfiles: stats.totalProfiles || 0,
            error: stats.error || null
          });
        }).catch(e => {
          console.error('[XCred Content] getStats() error:', e);
          sendResponse({
            configured: true,
            enabled: XLocationRemote.isEnabled,
            error: e.message
          });
        });
        return true; // Keep channel open for async response
      }
      console.log('[XCred Content] XLocationRemote not defined');
      sendResponse({ configured: false });
    }

    return false;
  });
})();
