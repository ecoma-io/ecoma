# Security Policy

## Supported Versions

Ecoma is **pre-release**. No version has been released yet — the repository carries no tags, and no installable build is distributed. There is therefore no supported-version matrix to publish.

**What is supported: the current `main` branch.** Security fixes land there. If you are running Ecoma at all, you are running it from source, and updating means pulling `main`.

This covers every product surface in the repository. Today that is exactly one
tree: `shared/` — cross-product libraries (the design system, the desktop-shell
webview plumbing), workspace tooling (`dev-cli`, local ESLint rules,
`repo-care`), and two workspace-owned app shells (a Storybook host and its e2e
harness) that serve shared infrastructure rather than any product. No product
domain has taken root yet, and no product app exists, so the repository
currently exposes no network surface, no data store, and no credential
handling of its own.

The security-relevant surfaces a product domain will bring — credential vault,
authentication and directory sync, a tool proxy, an external process engine,
artifact serving, and any exposed API — do not exist in this tree in any form,
not even as stubs. Each will be covered here as it actually lands, along with
any operator-trust posture worth calling out explicitly. Until then, treat a
claim in this file about a product surface as a bug in this file.

Release tags and a per-product support policy are planned once releases
exist; this section will be replaced then, not amended.

## Reporting a Vulnerability

If you discover a security vulnerability in any Ecoma product, **please do NOT report it via public issue tracker**. Instead:

1. **Email:** john.itvn@gmail.com

Please include:

- A clear description of the vulnerability
- Steps to reproduce (if possible)
- The affected version(s)
- Any suggested fixes or mitigations

## Security Response Timeline

- **Initial Response:** Within 48 hours
- **Acknowledgment:** Within 1 week
- **Fix Development:** Target within 2 weeks (depends on severity)
- **Public Disclosure:** After a fix is released or 90 days from initial report, whichever comes first

## Responsible Disclosure

We appreciate responsible disclosure and request that reporters:

- Allow us time to develop and release a fix before public disclosure
- Avoid accessing data beyond what's necessary to demonstrate the vulnerability
- Not leak or share the vulnerability with third parties
- Not modify or delete user data

## Security Best Practices

When using Ecoma products:

- **Keep Dependencies Updated:** Run `pnpm update` regularly
- **Secure Your API Keys:** Never commit credentials to version control; use environment variables
- **Report Suspected Breaches:** Contact us immediately if you suspect a compromise
- **Follow the Principle of Least Privilege:** Run with minimal permissions needed

## Contact

**Security Email:** john.itvn@gmail.com

---

Thank you for helping keep Ecoma secure!
