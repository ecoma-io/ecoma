import { fc } from "@fast-check/vitest";

// Property tests run a bounded search whose seed varies per run — that is the
// point on a dev machine (every executed run explores new input space), and
// exactly wrong on CI: a CI red must be attributable to the change that caused
// it, never to an unlucky seed landing on an unrelated PR, and Nx task caching
// assumes same inputs → same result. So CI pins the seed; dev runs keep
// exploring. A failing dev run prints its seed in the test title
// (`with seed=…`) for replay. The write-test skill owns the cross-language
// rule; this file is the TS mechanism it points at.
//
// The seed value itself is arbitrary — any constant yields a valid fixed
// sample; there is nothing to derive it from without reintroducing the
// run-varying randomness this file exists to remove, and this is its only
// declaration (Rule 14: intrinsic-arbitrary, single site).
if (process.env.CI) {
  fc.configureGlobal({ seed: 42 });
}
