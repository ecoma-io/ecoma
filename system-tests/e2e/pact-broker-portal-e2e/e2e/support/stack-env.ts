import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared source of truth of the suite for `ROOT_HOST` / cert / namespace —
 * imported by `playwright.config.ts`, `global-setup.ts` and the `e2e/support`
 * helpers so each rule exists exactly ONCE in this suite (was: four copies).
 *
 * Reading order of `ROOT_HOST`: env first, repo-root `.env` as fallback (Nx
 * loads `.env` into the task env; a direct `npx playwright test` does not).
 * The parsed value is memoized — every consumer shares one lazy read.
 */

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

/** Repo root — walk up from this file until `pnpm-workspace.yaml` appears. */
function repoRoot(): string {
  let dir = SUITE_DIR;
  for (;;) {
    try {
      readFileSync(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error('repo root not found — no pnpm-workspace.yaml above the suite directory');
      }
      dir = parent;
    }
  }
}

/** Repo-root `.env` text, or `undefined` when the file is absent. */
function repoDotEnv(): string | undefined {
  try {
    return readFileSync(join(repoRoot(), '.env'), 'utf8');
  } catch {
    return undefined;
  }
}

let rootHostCache: string | undefined | null;
/**
 * `ROOT_HOST` from env or repo-root `.env` (trimmed), or `undefined` when
 * neither defines it. Memoized.
 */
export function rootHostRaw(): string | undefined {
  if (rootHostCache === null) {
    const fromEnv = process.env.ROOT_HOST;
    if (fromEnv !== undefined && fromEnv.trim().length > 0) {
      rootHostCache = fromEnv.trim();
    } else {
      const text = repoDotEnv();
      rootHostCache = text === undefined ? undefined : readRootHostFromDotEnv(text);
    }
  }
  return rootHostCache;
}

function readRootHostFromDotEnv(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Split a `hostname:port` value into its hostname and port. IPv6 bracket form
 * (`[::1]:443`) is honored via `URL`; a bare host gets the `443` default.
 */
export function splitHostPort(raw: string): { hostname: string; port: string } {
  const withScheme = raw.includes('://') ? raw : `//${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname.length > 0) {
      return { hostname: url.hostname, port: url.port.length > 0 ? url.port : '443' };
    }
  } catch {
    // fall through to loopback-only split below
  }
  // Non-URL-parseable input — keep the historical loopback split.
  const hostname = raw.split(':')[0];
  const port = raw.includes(':') ? (raw.split(':')[1] ?? '443') : '443';
  return { hostname, port };
}

/** Path of the committed local TLS cert, named after the resolved root host. */
export function localCertPath(): string {
  const rootHost = rootHostRaw();
  if (rootHost === undefined) {
    throw new Error(
      'ROOT_HOST is not set and no .env file defines it. ' +
        'Deploy the local stack first (Nx provisions the `local-up` prerequisites) — ' +
        'deploying writes the dynamic Traefik host:port into the repo-root .env.',
    );
  }
  return join(
    repoRoot(),
    'deploys/platform-deploy/local-certs',
    `${splitHostPort(rootHost).hostname}.crt`,
  );
}

/** PEM of the local cert, or `''` when it cannot be read (caller degrades). */
export function localCertPemOrEmpty(): string {
  try {
    return readFileSync(localCertPath(), 'utf8');
  } catch {
    return '';
  }
}

/** PEM of the local cert — throws with the remedy when cert or host is missing. */
export function localCertPem(): string {
  return readFileSync(localCertPath(), 'utf8');
}

/**
 * Namespace of the worktree stack that publishes `port` on loopback, found by
 * scanning `docker ps`. Non-throwing variant: Docker absent or no match ⇒
 * `undefined` (the config/graph-eval path must never throw; global-setup is
 * the fail-closed gate). `failureDetail` collects what was seen so the
 * throwing variant's error can distinguish "no traefik" from "wrong port".
 */
export function traefikNamespaceOrNull(port: string): {
  namespace: string | undefined;
  failureDetail: string;
} {
  let ps: string;
  try {
    ps = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { namespace: undefined, failureDetail: `docker ps failed (${message})` };
  }
  const traefikContainers: string[] = [];
  for (const line of ps.split(/\r?\n/u)) {
    const match = /^ecoma-([a-z0-9]+)-traefik\t(.*)$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    const [, namespace, ports] = match;
    if (namespace === undefined) {
      continue;
    }
    traefikContainers.push(namespace);
    if (
      /^w[a-z0-9]{12}$/u.test(namespace) &&
      ports !== undefined &&
      // Static strings on both sides — no RegExp built from untrusted input.
      (ports.includes(`:${port}->443`) || ports.includes(`[::]:${port}->443`))
    ) {
      return { namespace, failureDetail: '' };
    }
  }
  return {
    namespace: undefined,
    failureDetail:
      traefikContainers.length === 0
        ? 'no ecoma traefik container is running'
        : `traefik containers seen (namespaces: ${traefikContainers.join(', ')}), none publishes port ${port}`,
  };
}
