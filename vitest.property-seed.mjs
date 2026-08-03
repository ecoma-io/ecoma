/**
 * Pins fast-check's seed when `CI` is set, for every vitest project that runs
 * property tests. Loaded through each such project's `setupFiles`, so it runs
 * once per test process before any test file.
 *
 * Property tests run a bounded search whose seed varies per run — that is the
 * point on a dev machine (every executed run explores new input space), and
 * exactly wrong on CI: a CI red must be attributable to the change that caused
 * it, never to an unlucky seed landing on an unrelated PR, and Nx task caching
 * assumes same inputs → same result. So CI pins the seed; dev runs keep
 * exploring. A failing dev run prints its seed in the test title
 * (`with seed=…`) for replay. The write-test skill owns the cross-language
 * rule; this file is the TS/JS mechanism it points at.
 *
 * It sits at the repo root, beside the other cross-project single sources
 * (`coverage.config.json` and friends), for the reason those do: several Nx
 * projects run property tests, and a per-project copy of this pin would be an
 * unsynced config rather than a hardcode (Rule 14) — while a cross-project
 * source import would be an edge the project graph cannot see. The seed value
 * itself is arbitrary: any constant yields a valid fixed sample, and there is
 * nothing to derive it from without reintroducing the run-varying randomness
 * this file exists to remove. `nx.json`'s `test` target inputs name this file,
 * so changing it re-runs the suites it governs instead of replaying a cached
 * green.
 */
import { fc } from "@fast-check/vitest";

if (process.env.CI) {
  fc.configureGlobal({ seed: 42 });
}
