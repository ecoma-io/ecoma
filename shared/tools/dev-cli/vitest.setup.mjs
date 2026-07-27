/**
 * Runs once per test process, before any test file. Strips the git variables
 * that select a repository (`GIT_DIR` and friends) out of this process.
 *
 * Not optional: `verify` runs this suite from lefthook's `pre-push` hook, which
 * exports `GIT_DIR` pointing at the repository being pushed. Those variables
 * outrank both `cwd` and `-C`, so without this every fixture repo — and every
 * command module called in process — resolves to the developer's own checkout.
 * See `src/git-fixture.mjs` for the full hazard and the layers around it.
 */
import { scrubGitEnv } from "./src/git-fixture.mjs";

scrubGitEnv();
