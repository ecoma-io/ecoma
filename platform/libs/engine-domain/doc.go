// Package enginedomain is the root of the engine's domain vocabulary.
//
// It holds no types of its own: every concept lives in one of the sibling
// packages below, and that package boundary is the seam a future split cuts
// along (ADR-0008 §7 — a package is promoted to a library of its own, keeping
// its import path, once it earns an independent consumer).
//
//	eventlog    the append-only per-tenant entry and its ordering
//	role        the capability contract for a position of labour
//	task        one instance of work assigned to a Role
//	checkpoint  Gate, Judgment, Criterion, Conflict
//	handoff     an Artifact transfer under an explicit Contract
//	escalation  the declared path out of every deviation
//	calibration the assessment space keyed by CalKey
//	composition process definitions and their instances
//	tenant      the tenant boundary and the Principal schema
//	lease       the only serialisation primitive in the system
//	keytree     the three-tier key hierarchy crypto-shredding rests on
//	artifact    the content address naming a blob in the Artifact Store
//
// Four of the twelve hold types today — eventlog, tenant, lease and artifact,
// the vocabulary the ◆G0 interfaces are written in. The other eight are named
// and empty; each fills together with the specification it implements. None of
// them may import a port, an adapter or a wire protocol (platform/CLAUDE.md —
// the layer axis is review-enforced for Go).
package enginedomain
