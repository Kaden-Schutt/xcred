# Contributing to XCred

Thank you for your interest in contributing to XCred! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. XCred is built for transparency, not harassment.

## How to Contribute

### Reporting Bugs

1. **Search existing issues** first to avoid duplicates
2. Use the bug report template when creating a new issue
3. Include:
   - Chrome version
   - Extension version
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots if applicable

### Suggesting Features

1. Check if the feature has already been requested
2. Describe the use case and benefit
3. Consider if the feature fits XCred's core mission (transparency)

**Note:** Some features may be reserved for XCred+ (premium). Features involving analytics, filtering, or export capabilities will generally be premium-only.

### Submitting Code

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Test thoroughly in Chrome
5. Commit with clear messages
6. Push and create a Pull Request

## Development Setup

1. Clone your fork
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `xcred-extension/` directory
5. Make changes and refresh to test

### Testing Changes

- **Content script**: Refresh the X/Twitter tab
- **Background script**: Click refresh on extension card in `chrome://extensions/`
- **Popup**: Close and reopen the popup

## Code Style

- Use vanilla JavaScript (no frameworks)
- Follow existing code patterns
- Use descriptive variable names
- Comment complex logic
- Keep functions focused and small

### Naming Conventions

- `camelCase` for variables and functions
- `SCREAMING_SNAKE_CASE` for constants
- Prefix private/internal items with underscore

## Scope Clarification

### In Scope (Free XCred)

- Core transparency features
- Bug fixes
- Performance improvements
- Accessibility improvements
- Internationalization
- Documentation

### Out of Scope (Reserved for XCred+)

- Advanced analytics
- Custom filtering rules
- Data export features
- API access
- Priority support integrations

## Security

### Reporting Security Issues

**Do not open public issues for security vulnerabilities.**

Instead, email security concerns to: kaden.schutt@icloud.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes

We will respond within 48 hours and coordinate disclosure.

### Security Guidelines

When contributing code:
- Never log sensitive data (tokens, user info)
- Validate all external data
- Use secure defaults
- Don't introduce new permissions without justification

## Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality if applicable
3. Ensure code follows style guidelines
4. Request review from maintainers
5. Address feedback promptly

## Questions?

- Open a Discussion for general questions
- Check existing issues and discussions first
- Be patient - this is a community project

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.
