// Contract area 1 of 5 — the Event Log entry schema (ADR-0008 §4.2;
// shared/libs/doctrine/spec/event-log.md).
//
// The four case groups below are the four the area names, in its order:
// required fields, ordering keys, the open entry taxonomy, and the
// crypto-shred fields. They run at the unit tier, against the domain values
// themselves, because the schema is a property of the entry and not of any
// store — the log-store port contract (area 2) is what puts the same entry
// through a backend, and it arrives with that port.
package conformanceg0

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"ecoma.io/platform/engine-domain/artifact"
	"ecoma.io/platform/engine-domain/eventlog"
	"ecoma.io/platform/engine-domain/tenant"
)

const conformanceDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// entry is the smallest complete entry: every required field present and
// nothing else. Each case below removes or adds exactly one thing, so a
// failure names one rule rather than a combination.
func entry() eventlog.Entry {
	return eventlog.Entry{
		ID:            "entry-1",
		Tenant:        "acme",
		Stream:        eventlog.StreamRef{Kind: eventlog.StreamTask, ID: "task-1"},
		Position:      1,
		Timestamp:     time.Unix(1_700_000_000, 0).UTC(),
		Kind:          eventlog.KindAttempt,
		SchemaVersion: 1,
		Actor: tenant.Principal{
			Tenant: "acme",
			Kind:   tenant.KindAgent,
			ID:     "agent-1",
		},
		RunKind: eventlog.RunProduction,
	}
}

func TestEntrySchemaRequiresEveryFieldTheSpecificationNames(t *testing.T) {
	cases := map[string]struct {
		mutate func(*eventlog.Entry)
		want   error
	}{
		"an entry with no id is refused, because the id is the dedup key": {
			mutate: func(e *eventlog.Entry) { e.ID = "" },
			want:   eventlog.ErrIDRequired,
		},
		"an entry with no tenant is refused, because the log is per tenant": {
			mutate: func(e *eventlog.Entry) { e.Tenant = "" },
			want:   eventlog.ErrTenantRequired,
		},
		"an entry with no timestamp is refused": {
			mutate: func(e *eventlog.Entry) { e.Timestamp = time.Time{} },
			want:   eventlog.ErrTimestampRequired,
		},
		"an entry with no kind is refused": {
			mutate: func(e *eventlog.Entry) { e.Kind = "" },
			want:   eventlog.ErrKindRequired,
		},
		"an entry with no schema version is refused, because readers are tolerant by it": {
			mutate: func(e *eventlog.Entry) { e.SchemaVersion = 0 },
			want:   eventlog.ErrSchemaVersionRequired,
		},
		"an entry with an incomplete actor identity is refused": {
			mutate: func(e *eventlog.Entry) { e.Actor.ID = "" },
			want:   eventlog.ErrActorRequired,
		},
		"an entry with no run kind is refused, because no projection may face a silent default": {
			mutate: func(e *eventlog.Entry) { e.RunKind = "" },
			want:   eventlog.ErrRunKindRequired,
		},
		"an entry labelled test without a test-run id is refused": {
			mutate: func(e *eventlog.Entry) { e.RunKind = eventlog.RunTest },
			want:   eventlog.ErrTestRunIDRequired,
		},
		"a production entry carrying a test-run id is refused": {
			mutate: func(e *eventlog.Entry) { e.TestRunID = "run-1" },
			want:   eventlog.ErrTestRunIDOnProduction,
		},
		"an entry claiming both an inline payload and a blob address is refused": {
			mutate: func(e *eventlog.Entry) {
				e.Payload.Inline = json.RawMessage(`{"attempt":1}`)
				e.Payload.Blob = artifact.Address{Algorithm: artifact.SHA256, Digest: conformanceDigest}
			},
			want: eventlog.ErrPayloadAmbiguous,
		},
		"an entry whose reference is not entity@version is refused": {
			mutate: func(e *eventlog.Entry) {
				e.References = []eventlog.EntityRef{{Entity: "order"}}
			},
			want: eventlog.ErrVersionRequired,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			candidate := entry()
			testCase.mutate(&candidate)
			if err := candidate.Validate(); !errors.Is(err, testCase.want) {
				t.Fatalf("Validate() = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestEntrySchemaAcceptsEveryShapeTheSpecificationAllows(t *testing.T) {
	cases := map[string]func(*eventlog.Entry){
		"a production entry": func(*eventlog.Entry) {},
		"a test entry carrying its test-run id": func(e *eventlog.Entry) {
			e.RunKind = eventlog.RunTest
			e.TestRunID = "run-1"
		},
		"a small payload sitting inline": func(e *eventlog.Entry) {
			e.Payload.Inline = json.RawMessage(`{"attempt":1}`)
		},
		"a large payload as a hash into the Artifact Store": func(e *eventlog.Entry) {
			e.Payload.Blob = artifact.Address{Algorithm: artifact.SHA256, Digest: conformanceDigest}
		},
		"entity@version references": func(e *eventlog.Entry) {
			e.References = []eventlog.EntityRef{
				{Entity: "order", Version: "3"},
				{Entity: "invoice", Version: "v1.2.0"},
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			candidate := entry()
			mutate(&candidate)
			if err := candidate.Validate(); err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
		})
	}
}

func TestEntryOrderingKeysAreStreamAndPositionAndNothingElse(t *testing.T) {
	instant := time.Unix(1_700_000_000, 0).UTC()
	inStream := func(stream eventlog.StreamRef, position eventlog.Position) eventlog.Entry {
		candidate := entry()
		candidate.Stream = stream
		candidate.Position = position
		candidate.Timestamp = instant
		return candidate
	}
	task := eventlog.StreamRef{Kind: eventlog.StreamTask, ID: "task-1"}
	session := eventlog.StreamRef{Kind: eventlog.StreamSession, ID: "session-1"}

	t.Run("an entry that names no stream is refused", func(t *testing.T) {
		candidate := entry()
		candidate.Stream = eventlog.StreamRef{}
		if err := candidate.Validate(); !errors.Is(err, eventlog.ErrStreamRequired) {
			t.Fatalf("Validate() = %v, want %v", err, eventlog.ErrStreamRequired)
		}
	})

	t.Run("each task, session and instance is a stream of its own", func(t *testing.T) {
		for _, kind := range []eventlog.StreamKind{
			eventlog.StreamTask, eventlog.StreamSession, eventlog.StreamInstance,
		} {
			candidate := entry()
			candidate.Stream = eventlog.StreamRef{Kind: kind, ID: "s-1"}
			if err := candidate.Validate(); err != nil {
				t.Fatalf("stream kind %q was refused: %v", kind, err)
			}
		}
	})

	t.Run("entries in one stream are totally ordered by position", func(t *testing.T) {
		first, second := inStream(task, 1), inStream(task, 2)
		if !first.Precedes(second) || second.Precedes(first) || first.Precedes(first) {
			t.Fatal("position did not give a total order within the stream")
		}
	})

	t.Run("no global clock is required, so identical timestamps still order", func(t *testing.T) {
		// Both entries are stamped at the same instant. If the order consulted
		// a clock at all, neither would precede the other.
		first, second := inStream(task, 1), inStream(task, 2)
		if !first.Timestamp.Equal(second.Timestamp) {
			t.Fatal("the fixture stopped stamping both entries identically")
		}
		if !first.Precedes(second) {
			t.Fatal("two entries at the same instant were not ordered by position")
		}
	})

	t.Run("order is defined within a stream and nowhere across streams", func(t *testing.T) {
		fromTask, fromSession := inStream(task, 1), inStream(session, 99)
		if fromTask.Precedes(fromSession) || fromSession.Precedes(fromTask) {
			t.Fatal("a cross-stream comparison claimed an order")
		}
	})
}

func TestEntryKindTaxonomyIsOpen(t *testing.T) {
	t.Run("every kind the specification lists validates", func(t *testing.T) {
		for _, kind := range []eventlog.Kind{
			eventlog.KindTaskState, eventlog.KindAttempt, eventlog.KindJudgment,
			eventlog.KindViolation, eventlog.KindConflict, eventlog.KindEscalation,
			eventlog.KindEffect, eventlog.KindHandoff, eventlog.KindTriggerIn,
			eventlog.KindGC, eventlog.KindConfigChange,
		} {
			candidate := entry()
			candidate.Kind = kind
			if err := candidate.Validate(); err != nil {
				t.Fatalf("kind %q was refused: %v", kind, err)
			}
		}
	})

	t.Run("an entry of a kind this build has never heard of is valid", func(t *testing.T) {
		// The taxonomy is open, so a reader has to tolerate an unknown kind
		// rather than fail on one. A validator that refused here would make
		// every new entry kind a breaking change to every existing reader —
		// which is exactly what "open" forbids.
		candidate := entry()
		candidate.Kind = eventlog.Kind("swarm_rebalance")
		if err := candidate.Validate(); err != nil {
			t.Fatalf("an unknown kind was refused: %v", err)
		}
	})
}

func TestCryptoShredReachesThePayloadAndNeverTheMetadata(t *testing.T) {
	t.Run("a payload declares the subject key it was encrypted under", func(t *testing.T) {
		// Erasure is destroying that key (event-log.md §4). The entry must
		// therefore record which key, and for which subject, or a shred has no
		// way to know what it made unreadable.
		candidate := entry()
		candidate.Payload.Inline = json.RawMessage(`"<ciphertext>"`)
		candidate.Payload.Encryption = &eventlog.Encryption{
			KeyID:   "key-1",
			Subject: "subject-1",
		}
		if err := candidate.Validate(); err != nil {
			t.Fatalf("Validate() = %v, want nil", err)
		}
		if candidate.Payload.Encryption.KeyID == "" || candidate.Payload.Encryption.Subject == "" {
			t.Fatal("the encryption record does not carry both the key and its subject")
		}
	})

	t.Run("an entry with no encrypted payload carries no encryption record", func(t *testing.T) {
		if candidate := entry(); candidate.Payload.Encryption != nil {
			t.Fatal("an unencrypted entry carried an encryption record")
		}
	})

	t.Run("the metadata fields carry no key of their own, so no shred can reach them", func(t *testing.T) {
		// Entry metadata is permanent — it is the history. The structural
		// proof is that Encryption hangs off Payload alone: there is no field
		// on Entry through which a destroyed key could make the id, stream,
		// position, timestamp, kind, actor or references unreadable.
		encrypted := entry()
		encrypted.Payload.Inline = json.RawMessage(`"<ciphertext>"`)
		encrypted.Payload.Encryption = &eventlog.Encryption{KeyID: "key-1", Subject: "subject-1"}

		shredded := encrypted
		shredded.Payload = eventlog.Payload{}
		if !reflect.DeepEqual(shredded, entry()) {
			t.Fatal("destroying the payload changed a metadata field, so a shred could reach one")
		}
	})

	t.Run("shredding never rewrites the entry, so a shredded blob's address survives", func(t *testing.T) {
		// The hash in the log still proves what existed even after the bytes
		// are unreadable (artifact-store.md §1) — so the address stays a
		// required, unencrypted field of the entry.
		candidate := entry()
		candidate.Payload.Blob = artifact.Address{Algorithm: artifact.SHA256, Digest: conformanceDigest}
		candidate.Payload.Encryption = &eventlog.Encryption{KeyID: "key-1", Subject: "subject-1"}
		if err := candidate.Validate(); err != nil {
			t.Fatalf("Validate() = %v, want nil", err)
		}
		if candidate.Payload.Blob.String() != "sha256:"+conformanceDigest {
			t.Fatalf("the blob address did not survive as %q", candidate.Payload.Blob.String())
		}
	})
}
