# Security Policy

## Supported Versions

Ecoma is **pre-release**. No version has been released yet — the repository carries no tags, and no installable build is distributed. There is therefore no supported-version matrix to publish.

**What is supported: the current `main` branch.** Security fixes land there. If you are running Ecoma at all, you are running it from source, and updating means pulling `main`.

This covers every product surface in the repository. Today that is three
trees. `shared/` — cross-product libraries (the design system, the
desktop-shell webview plumbing), workspace tooling (`dev-cli`, local ESLint
rules, `repo-care`), and workspace-owned app shells (a Storybook host, the
doctrine reading surface, and their e2e harnesses). `platform/` — the engine's
Go libraries (domain vocabulary, ports, adapters, and the ◆G0 conformance
suite): package skeletons that are deliberately type-free today, with no
running service behind them. `website/` — the ecoma.io shell, a fully
prerendered Nuxt app whose build output is static HTML: no server runtime, no
data store, no credential handling of its own.

The security-relevant surfaces the engine will bring — credential vault,
authentication and directory sync, a tool proxy, a running process engine,
artifact serving, and any exposed API — exist only as those type-free package
seams, not as anything that executes or listens. Each will be covered here as
it actually runs, along with any operator-trust posture worth calling out
explicitly. Until then, treat a claim in this file about a product surface as
a bug in this file.

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
