# XCred - Account Transparency for X/Twitter

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.6-blue.svg)](https://github.com/Kaden-Schutt/xcred/releases/latest)

**See who you're really talking to.** XCred is a free, open-source Chrome extension that adds credibility indicators to your X/Twitter timeline.

## Why Open Source?

- **Transparency** - You can verify exactly what the code does
- **Trust** - No hidden tracking or data collection
- **Community** - Contributions welcome to improve for everyone
- **Security** - Public code review catches vulnerabilities

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

## Installation

### From Chrome Web Store
Visit the [Chrome Web Store](https://chrome.google.com/webstore) and click "Add to Chrome".

### From Source
1. Clone this repository
2. Open `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the cloned directory

## Development

```bash
# Clone the repo
git clone https://github.com/Kaden-Schutt/xcred.git
cd xcred

# Load in Chrome
# 1. chrome://extensions/
# 2. Enable Developer mode
# 3. Load unpacked -> select this directory
```

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
    ├── api-client.js   # XCredAPI - server validation client
    ├── cache.js        # Three-tier caching system
    ├── flags.js        # Country flag utilities
    ├── gun.js          # P2P consensus layer
    └── supabase.js     # Remote cache (read-only)
```

### Testing Changes

- **Content script**: Refresh the X/Twitter tab
- **Background script**: Click refresh on extension card
- **Popup**: Close and reopen

## Privacy & Security

- Uses only **publicly available** X transparency data
- **No personal data** collection
- Processing happens **locally** in your browser
- Server-validated shared cache to reduce API calls
- [Full Privacy Policy](https://www.xcred.org/privacy.html)

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
