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
// The suite holds no assertions yet. Each contract area has a file naming it
// and enumerating its cases; the assertions land together with the interfaces
// they check, which is also why the ◆G0 freeze is a separate act after this
// suite is green.
package conformanceg0
