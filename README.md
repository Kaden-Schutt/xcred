# XCred - Account Transparency for X/Twitter

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

**See who you're really talking to.** XCred is a free, open-source Chrome extension that adds credibility indicators to your X/Twitter timeline.

## Quick Install (3 Easy Steps)

1. **Download** the [latest release](https://github.com/Kaden-Schutt/xcred/releases/latest) (.zip file)
2. **Extract** the zip to a folder on your computer
3. **Load in Chrome:**
   - Go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the extracted folder

That's it! Visit X/Twitter to see credibility indicators.

## Features

### Country Flags
Instantly see where each account is based with country flag icons displayed right below their avatar.

### 6-Tier Credibility System
Quick visual indicators:
- **Government** (Silver) - Government Verified accounts
- **Tier 1** (Blue) - Strong authenticity signals
- **Tier 2** (Green) - Good authenticity signals
- **Tier 3** (Yellow) - Some inconsistencies
- **Tier 4** (Orange) - Multiple concerns
- **Tier 5** (Red) - Significant red flags
- **Tier 6** (Grey) - Insufficient data

### Platform Detection
Know how they connected - iOS App Store, Android, or Web.

### VPN Detection
X flags accounts using VPNs or proxies. We surface this info.

### Government Accounts
Identify verified government accounts with party affiliation.

### Username History
See if accounts have changed their username frequently.

## Why Open Source?

- **Transparency** - You can verify exactly what the code does
- **Trust** - No hidden tracking or data collection
- **Community** - Contributions welcome to improve for everyone
- **Security** - Public code review catches vulnerabilities

## Privacy & Security

- Uses only **publicly available** X transparency data
- **No personal data** collection
- Processing happens **locally** in your browser
- Optional shared cache to reduce API calls
- [Full Privacy Policy](https://www.xcred.org/privacy.html)

## Development (For Contributors)

### Architecture

```
xcred/
├── manifest.json       # Chrome extension manifest (v3)
├── background.js       # Service worker
├── content.js          # Main content script (injected into X)
├── popup.html/js       # Extension popup UI
├── styles.css          # Injected styles
├── icons/              # Extension icons
└── utils/
    ├── cache.js        # Three-tier caching system
    ├── flags.js        # Country flag utilities
    └── supabase.js     # Remote cache integration
```

### Testing Changes

- **Content script**: Refresh the X/Twitter tab
- **Background script**: Click refresh on extension card
- **Popup**: Close and reopen

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

AGPL-3.0 License - see [LICENSE](LICENSE) for details.

## Links

- Website: [xcred.org](https://www.xcred.org)
- Support: [xcred.org/support](https://www.xcred.org/support.html)
- Buy Me a Coffee: [buymeacoffee.com/kadenschutt](https://buymeacoffee.com/kadenschutt)

---

Built for transparency, not harassment.

Copyright (c) 2025 Will Power Media LLC
