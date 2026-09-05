# Security Policy

## Supported Versions

Currently, we are in active development (v0.x). Security updates will be applied to the latest version.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please follow these steps:

### 🔒 Private Disclosure

**DO NOT** create a public GitHub issue for security vulnerabilities.

Instead, please report security issues privately:

1. **Email**: Send details to the project maintainers (update with actual contact)
2. **GitHub Security Advisories**: Use the [GitHub Security Advisory](https://github.com/YOUR_USERNAME/ads/security/advisories/new) feature

### 📝 What to Include

Please provide the following information:

- **Description**: Clear description of the vulnerability
- **Impact**: What an attacker could achieve
- **Steps to Reproduce**: Detailed steps to reproduce the issue
- **Affected Versions**: Which versions are affected
- **Suggested Fix**: If you have ideas on how to fix it (optional)
- **Proof of Concept**: Code or commands demonstrating the issue (if applicable)

### ⏱️ Response Timeline

- **Initial Response**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 14 days
  - Medium: Within 30 days
  - Low: Next release cycle

### 🏆 Recognition

We appreciate security researchers who help keep ADS safe:

- We will acknowledge your contribution in the release notes (unless you prefer to remain anonymous)
- We may add you to a security contributors list

## Security Best Practices

### For Users

#### Environment Variables

- **NEVER** commit `.env` or `.env.*` files to version control
- Store sensitive credentials securely (use password managers or secret management tools)
- Rotate API keys and tokens regularly
- Use `.env.example` as a template, not production config

#### File Permissions

- Set proper permissions on sensitive files:
  ```bash
  chmod 600 .env
  ```
- Ensure the Telegram bot script validates file permissions before starting

#### Telegram Connector Security

- **Whitelist Users**: Set `TELEGRAM_ALLOWED_USER_ID` in the connector service environment. Do not put Telegram credentials in the ADS Core environment.
- **Connector Authentication**: Set the same high-entropy `ADS_CONNECTOR_TOKEN` for Core and the connector. Treat it as a credential with access to the configured Core workspace.
- **Limit Directories**: Use `ALLOWED_DIRS`（全端共享）限制 Core 可访问路径
- **Sandbox Mode**: Use `read-only` or `workspace-write` mode unless absolutely necessary
  - `read-only`: Core can only read files
  - `workspace-write`: Core can write within allowed directories
  - `danger-full-access`: ⚠️ Use with extreme caution
- **Token Security**: Keep `TELEGRAM_BOT_TOKEN` private in the connector service environment
  - If leaked, immediately revoke via [@BotFather](https://t.me/BotFather)
  - Generate a new token

#### API Keys

- Use separate API keys for development and production
- Implement rate limiting to prevent abuse
- Monitor API usage for anomalies
- Use environment-specific `.env` files (`.env.development`, `.env.production`)

### For Contributors

#### Code Review

- Review code for potential security issues
- Look for hardcoded credentials
- Check for SQL injection, command injection, path traversal vulnerabilities
- Validate user inputs

#### Dependencies

- Keep dependencies up to date
- Run `npm audit` regularly
- Address high and critical vulnerabilities promptly

#### Secrets in Git

Before committing:
```bash
# Check for potential secrets
git diff --cached

# Use git-secrets or similar tools to prevent commits with secrets
```

If you accidentally commit a secret:
1. **Immediately** revoke/rotate the credential
2. Remove it from Git history using `git filter-repo` or `git filter-branch`
3. Force push (if not yet public) or notify maintainers

## Known Security Considerations

### Current Limitations

1. **Telegram Connector Access**: The connector can submit prompts to ADS Core with `ADS_CONNECTOR_TOKEN`. Run it separately, restrict `TELEGRAM_ALLOWED_USER_ID`, and configure Core `ALLOWED_DIRS` and sandbox mode conservatively.

2. **SQLite Database**: Workspace databases live under the centralized ADS state dir (default `.ads/workspaces/<workspaceId>/ads.db`, plus `.ads/state.db` for shared state) and may contain sensitive information. Ensure they are not committed to version control (covered by `.gitignore`).

3. **Environment Files**: `.env` and any overrides contain secrets. Ensure all `.env*` files stay out of Git.
   - Keep Core and connector environment files separate so Telegram credentials never need to be loaded by ADS Core.

### Mitigation

- Follow the security best practices above
- Regularly review access logs
- Keep the software updated
- Report any security concerns

## Security Updates

Security updates will be announced via:

- GitHub Security Advisories
- Release notes
- CHANGELOG.md

Subscribe to repository notifications to stay informed.

## Questions?

For general security questions (not vulnerabilities), feel free to:

- Open a discussion on GitHub
- Refer to our documentation in `docs/`

Thank you for helping keep ADS and its users safe!
