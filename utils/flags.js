/**
 * Country flag utilities using SVG flags from country-flag-icons
 * https://github.com/catamphetamine/country-flag-icons
 */

const XLocationFlags = {
  // CDN URL for SVG flags
  FLAG_CDN_BASE: 'https://purecatamphetamine.github.io/country-flag-icons/3x2',

  /**
   * Get the URL for a country flag SVG
   * @param {string} countryCode - Two-letter country code (e.g., 'US', 'GB')
   * @returns {string|null} URL to SVG flag or null if invalid/region
   */
  getFlagUrl(countryCode) {
    if (!countryCode || countryCode.length !== 2) {
      return null;
    }

    const code = countryCode.toUpperCase();

    // Check if it's a region code - no flag available
    if (this.isRegionCode(code)) {
      return null;
    }

    // Validate characters are A-Z
    const firstChar = code.charCodeAt(0);
    const secondChar = code.charCodeAt(1);
    if (firstChar < 65 || firstChar > 90 || secondChar < 65 || secondChar > 90) {
      return null;
    }

    return `${this.FLAG_CDN_BASE}/${code}.svg`;
  },

  /**
   * Get flag emoji (fallback for regions or when SVG not available)
   * @param {string} countryCode - Two-letter country code or region code
   * @returns {string} Flag emoji or globe emoji
   */
  getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) {
      return '🌐';
    }

    const code = countryCode.toUpperCase();

    // Check if it's a region code - return appropriate globe emoji
    const region = this.getRegionByCode(code);
    if (region) {
      return region.emoji;
    }

    // Regional Indicator Symbol offset
    const OFFSET = 127397;

    try {
      const firstChar = code.charCodeAt(0);
      const secondChar = code.charCodeAt(1);

      if (firstChar < 65 || firstChar > 90 || secondChar < 65 || secondChar > 90) {
        return '🌐';
      }

      return String.fromCodePoint(firstChar + OFFSET, secondChar + OFFSET);
    } catch (e) {
      return '🌐';
    }
  },

  /**
   * Legacy method - returns emoji (for backwards compatibility)
   */
  getFlag(countryCode) {
    return this.getFlagEmoji(countryCode);
  },

  /**
   * Regional locations that X uses (not country-specific)
   * These return special codes that we handle separately
   */
  regionMapping: {
    'north america': { code: 'NA', emoji: '🌎', name: 'North America' },
    'south america': { code: 'SA', emoji: '🌎', name: 'South America' },
    'latin america': { code: 'LA', emoji: '🌎', name: 'Latin America' },
    'europe': { code: 'EU', emoji: '🌍', name: 'Europe' },
    'africa': { code: 'AF', emoji: '🌍', name: 'Africa' },
    'asia': { code: 'AS', emoji: '🌏', name: 'Asia' },
    'asia pacific': { code: 'AP', emoji: '🌏', name: 'Asia Pacific' },
    'middle east': { code: 'ME', emoji: '🌍', name: 'Middle East' },
    'oceania': { code: 'OC', emoji: '🌏', name: 'Oceania' },
  },

  /**
   * Common country name to ISO code mapping
   */
  countryNameToCode: {
    // North America
    'united states': 'US',
    'usa': 'US',
    'america': 'US',
    'canada': 'CA',
    'mexico': 'MX',

    // Europe
    'united kingdom': 'GB',
    'uk': 'GB',
    'england': 'GB',
    'scotland': 'GB',
    'wales': 'GB',
    'germany': 'DE',
    'france': 'FR',
    'italy': 'IT',
    'spain': 'ES',
    'portugal': 'PT',
    'netherlands': 'NL',
    'holland': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'austria': 'AT',
    'poland': 'PL',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'ireland': 'IE',
    'greece': 'GR',
    'czech republic': 'CZ',
    'czechia': 'CZ',
    'romania': 'RO',
    'hungary': 'HU',
    'ukraine': 'UA',
    'russia': 'RU',
    'russian federation': 'RU',

    // Asia
    'china': 'CN',
    'japan': 'JP',
    'south korea': 'KR',
    'korea': 'KR',
    'india': 'IN',
    'indonesia': 'ID',
    'thailand': 'TH',
    'vietnam': 'VN',
    'philippines': 'PH',
    'malaysia': 'MY',
    'singapore': 'SG',
    'pakistan': 'PK',
    'bangladesh': 'BD',
    'taiwan': 'TW',
    'hong kong': 'HK',

    // Middle East
    'israel': 'IL',
    'saudi arabia': 'SA',
    'united arab emirates': 'AE',
    'uae': 'AE',
    'turkey': 'TR',
    'türkiye': 'TR',
    'iran': 'IR',
    'islamic republic of iran': 'IR',
    'iraq': 'IQ',
    'egypt': 'EG',
    'qatar': 'QA',
    'kuwait': 'KW',
    'bahrain': 'BH',
    'oman': 'OM',
    'jordan': 'JO',
    'lebanon': 'LB',
    'syria': 'SY',
    'yemen': 'YE',

    // Oceania
    'australia': 'AU',
    'new zealand': 'NZ',

    // South America
    'brazil': 'BR',
    'argentina': 'AR',
    'colombia': 'CO',
    'chile': 'CL',
    'peru': 'PE',
    'venezuela': 'VE',

    // Africa
    'south africa': 'ZA',
    'nigeria': 'NG',
    'kenya': 'KE',
    'morocco': 'MA',
    'ethiopia': 'ET',
    'ghana': 'GH',
    'algeria': 'DZ',
    'tunisia': 'TN',
    'libya': 'LY',

    // Eastern Europe & Central Asia
    'belarus': 'BY',
    'kazakhstan': 'KZ',
    'uzbekistan': 'UZ',
    'georgia': 'GE',
    'armenia': 'AM',
    'azerbaijan': 'AZ',
    'moldova': 'MD',
    'serbia': 'RS',
    'croatia': 'HR',
    'bulgaria': 'BG',
    'slovakia': 'SK',
    'slovenia': 'SI',
    'lithuania': 'LT',
    'latvia': 'LV',
    'estonia': 'EE',

    // Additional
    'north korea': 'KP',
    'democratic people\'s republic of korea': 'KP',
    'republic of korea': 'KR'
  },

  /**
   * Parse location string and extract country code or region code
   * @param {string} location - Location string (e.g., "New York, USA" or "North America")
   * @returns {string|null} ISO country code, region code, or null
   */
  parseLocation(location) {
    if (!location) return null;

    const normalized = location.toLowerCase().trim();

    // Check for regional locations first (e.g., "North America", "Europe")
    for (const [name, regionData] of Object.entries(this.regionMapping)) {
      if (normalized === name || normalized.includes(name)) {
        return regionData.code; // Return region code like 'NA', 'EU'
      }
    }

    // Check direct country name match
    for (const [name, code] of Object.entries(this.countryNameToCode)) {
      if (normalized === name || normalized.endsWith(`, ${name}`) || normalized.endsWith(` ${name}`)) {
        return code;
      }
    }

    // Check if it contains a country name
    for (const [name, code] of Object.entries(this.countryNameToCode)) {
      if (normalized.includes(name)) {
        return code;
      }
    }

    // Try to extract ISO code if present (e.g., "NYC, US")
    const isoMatch = normalized.match(/\b([a-z]{2})\s*$/i);
    if (isoMatch) {
      const potentialCode = isoMatch[1].toUpperCase();
      // Validate it's a real country code
      if (Object.values(this.countryNameToCode).includes(potentialCode)) {
        return potentialCode;
      }
    }

    return null;
  },

  /**
   * Check if a code is a region code (not a country)
   * @param {string} code - The code to check
   * @returns {boolean} True if it's a region code
   */
  isRegionCode(code) {
    if (!code) return false;
    return Object.values(this.regionMapping).some(r => r.code === code);
  },

  /**
   * Get region data by code
   * @param {string} code - Region code (e.g., 'NA', 'EU')
   * @returns {object|null} Region data or null
   */
  getRegionByCode(code) {
    if (!code) return null;
    for (const regionData of Object.values(this.regionMapping)) {
      if (regionData.code === code) {
        return regionData;
      }
    }
    return null;
  },

  /**
   * Get flag emoji from location string
   * @param {string} location - Location string
   * @returns {string} Flag emoji or globe emoji if unknown
   */
  getFlagFromLocation(location) {
    const code = this.parseLocation(location);
    if (code) {
      return this.getFlag(code);
    }
    return '🌐'; // Globe for unknown locations
  }
};
