// Package engineports is the root of the interfaces the engine's domain
// exposes to the outside.
//
// A port names what the engine needs — an append-only log store, a
// content-addressed blob store, a lease, a key store, a SQL read surface, a
// metrics projection — in the domain's own vocabulary, so the engine stays
// swappable behind it. A port may name domain types; it never reaches an
// adapter, and it never speaks a wire format.
//
// One port is deliberately absent and named rather than forgotten: the vector
// port, together with its adapter and its case in the storage-port contract
// tests, is deferred until Knowledge — its first consumer — exists
// (ADR-0008 §7).
//
// TODO: no interfaces yet. Each lands with the specification it serves, and
// conformance-g0 is what holds the ◆G0 ones to their contract.
package engineports
