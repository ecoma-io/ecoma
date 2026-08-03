// Package conformanceg0 is the suite that arbitrates ◆G0.
//
// Roadmap rule #7: a gate is a frozen text plus a conformance suite that runs
// independently — a gate with no suite is a paper gate. This project is that
// suite for ◆G0, and its complete scope is fixed by ADR-0008 §4.2: the Event
// Log entry schema, the log-store port contract against both stacks, the
// blob-CAS contract against both blob backends, the Lease contract, and
// Principal identity. Nothing else, ever, under this gate.
//
// It is self-hosting: it drives ports and adapters directly and depends on no
// application service, because it must run before one exists.
//
// Two of the five areas are arbitrated today, and three are not:
//
//	(1) the entry schema      arbitrated — entry_schema_test.go
//	(2) the log-store port    TODO, pending the port and its two adapters
//	(3) the blob-CAS port     TODO, pending the port and its two backends
//	(4) the Lease contract    TODO, pending the lease-store port
//	(5) Principal identity    arbitrated — principal_test.go
//
// The two that run do so at the unit tier, against the domain values
// themselves, because both areas are properties of a value rather than of a
// store. The three that do not are port contracts: each needs a real adapter
// on both stacks, and an assertion written before the interface exists would
// be a guess pinned as a contract. Their files name their cases and assert
// nothing, which is the honest state rather than an empty test function
// reporting a contract as checked.
//
// The ◆G0 `status: frozen` flip has NOT happened and must not, until all five
// areas are green — freezing earlier is the paper gate roadmap rule #7 names,
// and the conformance executor fails it.
//
// One pin here is weaker than the specification it serves, and says so where
// it is made: tenant-identity.md §1's SSO litmus is pinned structurally rather
// than behaviourally (principal_test.go's header).
package conformanceg0
