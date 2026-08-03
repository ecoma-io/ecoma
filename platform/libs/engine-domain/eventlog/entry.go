package eventlog

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"ecoma.io/platform/engine-domain/artifact"
	"ecoma.io/platform/engine-domain/tenant"
)

// EntryID identifies one entry.
//
// It is OPAQUE and supplied by the caller, deliberately on both counts. The
// writer knows what it is writing and can therefore derive an id that is
// stable across a retry; the store cannot, because a store that minted ids
// would mint a second one for the retry. That is what makes the id usable as
// the dedup key the failure-modes table names — "duplicate writes
// (at-least-once) → event-id dedup → idempotent, the duplicate is dropped".
// Nothing here parses it: an id with structure would be a second contract for
// writers to agree on, and the dedup property needs only equality.
type EntryID string

// SchemaVersion is the version of the entry's own shape. Readers are tolerant
// by it and projections rebuild across it (event-log.md §1), so an engine
// upgrade never rewrites an old entry.
type SchemaVersion uint32

// Kind names what happened.
//
// The taxonomy is OPEN (event-log.md §1). The constants below are the kinds
// the specification lists today; an entry carrying a kind this package has
// never heard of is valid, and a reader is required to tolerate it rather than
// fail on it. Nothing here refuses an unknown kind — that refusal is exactly
// the failure the openness exists to prevent.
type Kind string

const (
	KindTaskState    Kind = "task_state"
	KindAttempt      Kind = "attempt"
	KindJudgment     Kind = "judgment"
	KindViolation    Kind = "violation"
	KindConflict     Kind = "conflict"
	KindEscalation   Kind = "escalation"
	KindEffect       Kind = "effect"
	KindHandoff      Kind = "handoff"
	KindTriggerIn    Kind = "trigger_in"
	KindGC           Kind = "gc"
	KindConfigChange Kind = "config_change"
)

// StreamKind names which sort of thing owns a stream. Each task, session or
// instance is a single-writer stream (event-log.md §2) — a node is the single
// writer of its session, the engine of its task.
type StreamKind string

const (
	StreamTask     StreamKind = "task"
	StreamSession  StreamKind = "session"
	StreamInstance StreamKind = "instance"
)

// StreamRef names the single-writer stream an entry belongs to.
type StreamRef struct {
	Kind StreamKind
	ID   string
}

// IsZero reports whether the reference names no stream at all.
func (s StreamRef) IsZero() bool { return s.Kind == "" && s.ID == "" }

// Equal reports whether two references name the same stream.
func (s StreamRef) Equal(other StreamRef) bool { return s == other }

// Position is an entry's place in its stream. Order is total within a stream
// and defined nowhere else, so a Position is only ever comparable against
// another from the same StreamRef.
type Position uint64

// RunKind labels an entry as production or test. Its canonical home is here,
// and every projection declares its position on it (event-log.md §3).
type RunKind string

const (
	RunProduction RunKind = "production"
	RunTest       RunKind = "test"
)

// TestRunID identifies the test run an entry belongs to. It is required on a
// test entry and forbidden on a production one — the label is only useful to a
// projection if it can never be half-set.
type TestRunID string

// EntityRef references an entity at a version, rendered "entity@version".
//
// Two fields, matching what event-log.md §1 writes: the entity and the version
// it was seen at. There is no third component — a reference that also named a
// kind would be a second taxonomy to keep in step with the entity ids
// themselves.
type EntityRef struct {
	Entity  string
	Version string
}

// KeyID and ShredSubject are named here rather than imported from the key
// hierarchy on purpose. vault-key.md is NOT frozen at ◆G0, so importing a type
// from a package that tracks it would let an unfrozen document move a value
// inside the frozen entry schema. They are plain identifiers to this package;
// binding them to the key tree is the job of whatever resolves a key, and it
// can happen once vault-key.md settles without reopening the entry.
type (
	KeyID        string
	ShredSubject string
)

// Encryption records which subject key a payload was encrypted under, so that
// destroying that key makes the payload unreadable without the entry ever
// being rewritten (event-log.md §4 — crypto-shredding).
//
// It carries no algorithm field. The algorithm belongs to the key the KeyID
// names — a key knows how it encrypts — and repeating it on every entry would
// create a second place to disagree with the key store, on a value nobody can
// change after the fact anyway.
type Encryption struct {
	KeyID   KeyID
	Subject ShredSubject
}

// Payload is the entry's body: a small one sits inline, a large one is an
// address into the Artifact Store (event-log.md §1). Exactly one of the two,
// never both — the log holds the truth, the store holds the bytes, and an
// entry claiming both leaves no answer to which is the truth.
//
// Encryption, when set, describes the payload alone. The metadata fields of an
// Entry — id, stream, position, timestamp, kind, actor, references — are never
// encrypted and never shredded: entry metadata is permanent, because it is the
// history (event-log.md §4).
type Payload struct {
	Inline     json.RawMessage
	Blob       artifact.Address
	Encryption *Encryption
}

// Entry is one Event Log record: append-only, immutable, per tenant.
type Entry struct {
	ID            EntryID
	Tenant        tenant.ID
	Stream        StreamRef
	Position      Position
	Timestamp     time.Time
	Kind          Kind
	SchemaVersion SchemaVersion
	Actor         tenant.Principal
	References    []EntityRef
	RunKind       RunKind
	TestRunID     TestRunID
	Payload       Payload
}

// Refusals Validate can carry. Each names one rule of the frozen entry schema,
// so a caller can tell which rule fired without reading a message.
var (
	ErrIDRequired            = errors.New("eventlog: entry has no id")
	ErrTenantRequired        = errors.New("eventlog: entry has no tenant")
	ErrStreamRequired        = errors.New("eventlog: entry names no stream")
	ErrTimestampRequired     = errors.New("eventlog: entry has no timestamp")
	ErrKindRequired          = errors.New("eventlog: entry has no kind")
	ErrSchemaVersionRequired = errors.New("eventlog: entry has no schema version")
	ErrActorRequired         = errors.New("eventlog: entry has no valid actor")
	ErrRunKindRequired       = errors.New("eventlog: entry has no run kind")
	ErrTestRunIDRequired     = errors.New("eventlog: test entry has no test-run id")
	ErrTestRunIDOnProduction = errors.New("eventlog: production entry carries a test-run id")
	ErrPayloadAmbiguous      = errors.New("eventlog: payload is both inline and a blob address")
	ErrActorTenantMismatch   = errors.New("eventlog: actor belongs to another tenant")
)

// Validate reports why an entry does not satisfy the frozen schema, or nil.
//
// Position is not checked. Where a stream starts numbering is a storage
// decision, and refusing zero here would invent a rule the specification does
// not state.
func (e Entry) Validate() error {
	if e.ID == "" {
		return ErrIDRequired
	}
	if e.Tenant == "" {
		return ErrTenantRequired
	}
	if e.Stream.Kind == "" || e.Stream.ID == "" {
		return ErrStreamRequired
	}
	if e.Timestamp.IsZero() {
		return ErrTimestampRequired
	}
	if e.Kind == "" {
		return ErrKindRequired
	}
	if e.SchemaVersion == 0 {
		return ErrSchemaVersionRequired
	}
	if err := e.Actor.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrActorRequired, err)
	}
	if !e.Actor.InTenant(e.Tenant) {
		return ErrActorTenantMismatch
	}
	switch e.RunKind {
	case RunTest:
		if e.TestRunID == "" {
			return ErrTestRunIDRequired
		}
	case RunProduction:
		if e.TestRunID != "" {
			return ErrTestRunIDOnProduction
		}
	default:
		return ErrRunKindRequired
	}
	for _, reference := range e.References {
		if err := reference.Validate(); err != nil {
			return err
		}
	}
	if len(e.Payload.Inline) > 0 && !e.Payload.Blob.IsZero() {
		return ErrPayloadAmbiguous
	}
	if !e.Payload.Blob.IsZero() {
		return e.Payload.Blob.Validate()
	}
	return nil
}

// Precedes reports whether e comes before other in the stream they share.
//
// Order is a comparison of positions and of nothing else — two entries stamped
// at the same instant still order, which is what "no global clock is required"
// means in practice (event-log.md §2). Across streams it is always false:
// causality there travels through provenance and handoff references, not
// through a comparison this function could make.
func (e Entry) Precedes(other Entry) bool {
	return e.Stream.Equal(other.Stream) && e.Position < other.Position
}

// Refusals ParseEntityRef and EntityRef.Validate can carry.
var (
	ErrEntityRefMalformed = errors.New("eventlog: reference is not entity@version")
	ErrEntityRequired     = errors.New("eventlog: reference has no entity")
	ErrVersionRequired    = errors.New("eventlog: reference has no version")
)

// Validate reports why a reference cannot be rendered unambiguously, or nil.
// Neither half may contain "@", which is what keeps String and ParseEntityRef
// exact inverses of one another.
func (r EntityRef) Validate() error {
	if r.Entity == "" {
		return ErrEntityRequired
	}
	if r.Version == "" {
		return ErrVersionRequired
	}
	if strings.Contains(r.Entity, "@") || strings.Contains(r.Version, "@") {
		return fmt.Errorf("%w: %q", ErrEntityRefMalformed, r.Entity+"@"+r.Version)
	}
	return nil
}

// String renders the reference as "entity@version".
func (r EntityRef) String() string { return r.Entity + "@" + r.Version }

// ParseEntityRef reads the rendered form back, refusing anything String would
// never have produced.
func ParseEntityRef(s string) (EntityRef, error) {
	entity, version, found := strings.Cut(s, "@")
	if !found {
		return EntityRef{}, fmt.Errorf("%w: %q", ErrEntityRefMalformed, s)
	}
	reference := EntityRef{Entity: entity, Version: version}
	if err := reference.Validate(); err != nil {
		return EntityRef{}, err
	}
	return reference, nil
}
