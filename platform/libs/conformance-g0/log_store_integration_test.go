// Contract area 2 of 5 — the log-store port, against both deployment shapes
// (ADR-0008 §4.2; ADR-0002 defaults by shape).
//
// Integration tier by the taxonomy and not by convenience: the contract is
// only meaningful against a real store, and running it against one store would
// prove the port is implementable rather than that it is portable.
//
// TODO: the append path — append-only, per tenant, and a rejected rewrite.
// TODO: the read path — reading a stream back in its total order.
// TODO: run it against the reference stack's Postgres store.
// TODO: run it against the small stack's SQLite store, from the same cases.
package conformanceg0
