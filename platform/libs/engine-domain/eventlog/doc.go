// Package eventlog holds the Event Log's entry: append-only, immutable and
// per tenant.
//
// The entry is what ◆G0 freezes — its required fields (id, the stream it
// belongs to and its position in that stream, timestamp, kind, schema version,
// the full actor identity, entity@version references, run_kind with its
// test-run id, payload), its ordering keys (total order per single-writer
// stream, no global clock), the open entry-kind taxonomy, and the crypto-shred
// fields. Stream and position are entry fields, not a storage property —
// ordering and gap detection read them through the schema. The log holds the truth; a large payload is a hash
// into the Artifact Store, which holds the bytes.
//
// TODO: no types yet. The entry lands with the frozen schema in
// shared/libs/doctrine/spec/event-log.md, and conformance-g0 is what arbitrates
// it.
package eventlog
