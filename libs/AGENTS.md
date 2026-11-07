# Repository Instructions — `libs/`

## Scope

Each `libs/<bc>-<layer>` subdirectory is one Nx project. Structure, tags and dependency boundaries → [`docs/architecture/05-code-architecture.md`](../docs/architecture/05-code-architecture.md).

## Required tags

Each project carries **exactly one** tag per dimension: `type:*`, `scope:*`, `runtime:*`. `pnpm dx arch-check` runs on the **whole workspace** in CI, not via `nx affected` — a wrong tag on a project that changes no file must still fail.

⚠️ **Two different prohibition styles live in `.oxlintrc.json`, and misreading them means writing the wrong rule:**

- `notDependOnLibsWithTags` — prohibits **transitively**: every _reachable_ project, including through intermediaries.
- `onlyDependOnLibsWithTags` — a **direct-edge** allowlist; a project outside the list is blocked on the direct import.

| `type`           | Must not depend on (transitive)                                     | Direct allowlist                                       |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `domain`         | `application`, `infrastructure`, `composition`, `tooling`           | —                                                      |
| `contracts`      | `domain`, `application`, `infrastructure`, `composition`, `tooling` | —                                                      |
| `application`    | `infrastructure`, `composition`, `tooling`                          | —                                                      |
| `infrastructure` | —                                                                   | `domain`, `application`, `contracts`, `infrastructure` |
| `composition`    | —                                                                   | `domain`, `application`, `contracts`, `infrastructure` |

⚠️ **`type:infrastructure` MAY import `type:application`.** That is the normal direction — an adapter needs the use case to call it. Do not write the rule backwards.

⚠️ **`type:contracts` must not import `type:domain`, not even transitively.** A contract is what a provider **publishes** for consumers to depend on, not a layer to travel down the dependency direction. That is why a shared type is re-declared at the contracts layer as a `wire` union instead of importing the domain's union.

⚠️ **The Nx graph does not guard the database boundary.** The bounded-context split gives `account` and `auth` their own Nx scopes (`scope:account` and `scope:auth`), but no Nx tag stops an app from declaring a binding that points at the other app's database: tags only encode the graph, not credentials. That boundary is enforced by database grants that do not allow it ([`docs/architecture/05-code-architecture.md`](../docs/architecture/05-code-architecture.md) §6.3).

## Imports

- `.oxlintrc.json` prohibits `node:*` **and** 18 bare builtins (including `crypto`) in `libs/**`. Only `*.{spec,test}.{ts,tsx,js,jsx,mts,cts}` are exempt.
- `libs/` does not use aliases: relative imports within a lib, and the package name `@ecoma-io/<name>` when an app consumes it.
- ⚠️ **An app that consumes `@ecoma-io/*` must declare the `alias` explicitly in `nuxt.config.ts`.** `tsconfig.base.json#paths` is empty and `vite.resolve.tsconfigPaths` does **not** resolve workspace packages at runtime.

## Contracts with peer services

⚠️ **Sharing a contract must be a decision with an issue, not a coding-time convenience.** Contracts are owned **by provider**: the account-side contract lib (`libs/account-contracts`, `scope:account`) owns the account-status contract, and the auth-side contract lib (`libs/auth-contracts`, `scope:auth`) owns the session-verified/consent contracts. Cross-scope consumers import the platform contract `libs/internal-auth-contracts` (`scope:platform`), which both re-export. Sharing happens only after the contract's boundary is pinned down in documentation. A drift in a canonical string, a header name, the skew window or the replay check fails **silently on both ends** — no compile error catches it.

## Language

Follow the root [`AGENTS.md`](../AGENTS.md) Language policy. No libs-specific language rule: comment and JSDoc stay Vietnamese, and everything else follows the root policy as written.

## Checks

```bash
pnpm nx run-many -t test lint typecheck -p <project> --skip-nx-cache
pnpm dx arch-check
```

⚠️ `--skip-nx-cache` is mandatory when you just edited a file that is only read **at runtime** (for example commitlint config): Nx caches the previous green result and the test re-runs against the old file exactly as before.
