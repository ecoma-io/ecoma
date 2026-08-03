// Contract area 1 of 5 — the Event Log entry schema (ADR-0008 §4.2;
// shared/libs/doctrine/spec/event-log.md).
//
// The file is named and empty on purpose: the schema it arbitrates is frozen
// at ◆G0, and an assertion written before the type exists would be a guess
// pinned as a contract. What it must cover, in full:
//
// TODO: required fields — id, timestamp, kind, the entry's schema version, the
// full actor identity, entity@version references, run_kind with its test-run
// id, and the payload (inline, or a hash into the Artifact Store).
// TODO: ordering keys — total order per single-writer stream, and that no
// global clock is required for it.
// TODO: the entry-kind taxonomy — open, and a reader tolerant of an unknown
// kind rather than failing on one.
// TODO: the crypto-shred fields — which parts of an entry a destroyed subject
// key makes unreadable, and that the entry itself is never rewritten.
package conformanceg0
