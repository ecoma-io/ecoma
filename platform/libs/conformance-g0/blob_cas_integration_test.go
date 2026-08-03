// Contract area 3 of 5 — the Artifact Store's content-addressed blob
// interface, against both blob backends (ADR-0008 §4.2 and §4;
// shared/libs/doctrine/spec/artifact-store.md).
//
// TODO: put — content addressing, and that putting the same bytes twice is the
// same address.
// TODO: get — the bytes back, and the failure shape for an address nothing was
// put at.
// TODO: exists — agreeing with get on every address, including after delete.
// TODO: delete — and what the log holding the truth still says afterwards.
// TODO: run every case against the small stack's filesystem store.
// TODO: run every case against the reference stack's S3-compatible store.
package conformanceg0
