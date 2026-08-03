package eventlog

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"ecoma.io/platform/engine-domain/artifact"
	"ecoma.io/platform/engine-domain/tenant"
)

const blobDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func validEntry() Entry {
	return Entry{
		ID:            "entry-1",
		Tenant:        "acme",
		Stream:        StreamRef{Kind: StreamTask, ID: "task-1"},
		Position:      1,
		Timestamp:     time.Unix(1_700_000_000, 0).UTC(),
		Kind:          KindAttempt,
		SchemaVersion: 1,
		Actor:         tenant.Principal{Tenant: "acme", Kind: tenant.KindAgent, ID: "a-1"},
		RunKind:       RunProduction,
	}
}

func TestEntryValidateNamesTheRuleThatFired(t *testing.T) {
	cases := map[string]struct {
		mutate func(*Entry)
		want   error
	}{
		"an entry with no id is refused": {
			mutate: func(e *Entry) { e.ID = "" },
			want:   ErrIDRequired,
		},
		"an entry with no tenant is refused": {
			mutate: func(e *Entry) { e.Tenant = "" },
			want:   ErrTenantRequired,
		},
		"an entry naming no stream is refused": {
			mutate: func(e *Entry) { e.Stream = StreamRef{} },
			want:   ErrStreamRequired,
		},
		"an entry whose stream has a kind but no id is refused": {
			mutate: func(e *Entry) { e.Stream.ID = "" },
			want:   ErrStreamRequired,
		},
		"an entry with no timestamp is refused": {
			mutate: func(e *Entry) { e.Timestamp = time.Time{} },
			want:   ErrTimestampRequired,
		},
		"an entry with no kind is refused": {
			mutate: func(e *Entry) { e.Kind = "" },
			want:   ErrKindRequired,
		},
		"an entry with no schema version is refused": {
			mutate: func(e *Entry) { e.SchemaVersion = 0 },
			want:   ErrSchemaVersionRequired,
		},
		"an entry with an incomplete actor is refused": {
			mutate: func(e *Entry) { e.Actor.ID = "" },
			want:   ErrActorRequired,
		},
		"an entry whose actor belongs to another tenant is refused": {
			mutate: func(e *Entry) { e.Actor.Tenant = "globex" },
			want:   ErrActorTenantMismatch,
		},
		"an entry with no run kind is refused": {
			mutate: func(e *Entry) { e.RunKind = "" },
			want:   ErrRunKindRequired,
		},
		"an entry labelled test without a test-run id is refused": {
			mutate: func(e *Entry) { e.RunKind = RunTest },
			want:   ErrTestRunIDRequired,
		},
		"a production entry carrying a test-run id is refused": {
			mutate: func(e *Entry) { e.TestRunID = "run-1" },
			want:   ErrTestRunIDOnProduction,
		},
		"an entry claiming both an inline payload and a blob is refused": {
			mutate: func(e *Entry) {
				e.Payload.Inline = json.RawMessage(`{"a":1}`)
				e.Payload.Blob = artifact.Address{Algorithm: artifact.SHA256, Digest: blobDigest}
			},
			want: ErrPayloadAmbiguous,
		},
		"an entry whose blob address is malformed is refused": {
			mutate: func(e *Entry) {
				e.Payload.Blob = artifact.Address{Algorithm: artifact.SHA256, Digest: "nope"}
			},
			want: artifact.ErrDigestMalformed,
		},
		"an entry with a malformed reference is refused": {
			mutate: func(e *Entry) { e.References = []EntityRef{{Entity: "order"}} },
			want:   ErrVersionRequired,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			entry := validEntry()
			testCase.mutate(&entry)
			if err := entry.Validate(); !errors.Is(err, testCase.want) {
				t.Fatalf("Validate() = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestEntryValidateAcceptsEachCompleteShape(t *testing.T) {
	cases := map[string]func(*Entry){
		"a production entry with no payload": func(*Entry) {},
		"a test entry carrying its test-run id": func(e *Entry) {
			e.RunKind = RunTest
			e.TestRunID = "run-1"
		},
		"an entry whose payload sits inline": func(e *Entry) {
			e.Payload.Inline = json.RawMessage(`{"attempt":1}`)
		},
		"an entry whose payload is an address into the Artifact Store": func(e *Entry) {
			e.Payload.Blob = artifact.Address{Algorithm: artifact.SHA256, Digest: blobDigest}
		},
		"an entry carrying entity@version references": func(e *Entry) {
			e.References = []EntityRef{{Entity: "order", Version: "3"}}
		},
		"an entry at position zero, since where a stream starts numbering is the store's": func(e *Entry) {
			e.Position = 0
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			entry := validEntry()
			mutate(&entry)
			if err := entry.Validate(); err != nil {
				t.Fatalf("Validate() = %v, want nil", err)
			}
		})
	}
}

func TestOrderIsPositionWithinAStreamAndNothingElse(t *testing.T) {
	sameInstant := time.Unix(1_700_000_000, 0).UTC()

	inStream := func(stream StreamRef, position Position) Entry {
		entry := validEntry()
		entry.Stream = stream
		entry.Position = position
		entry.Timestamp = sameInstant
		return entry
	}
	task := StreamRef{Kind: StreamTask, ID: "task-1"}
	session := StreamRef{Kind: StreamSession, ID: "session-1"}

	t.Run("two entries stamped at the same instant still order by position", func(t *testing.T) {
		// This is what "no global clock is required" means in practice: the
		// comparison never consults the timestamp, so identical timestamps do
		// not make two entries unordered.
		first, second := inStream(task, 1), inStream(task, 2)
		if !first.Precedes(second) {
			t.Fatal("position 1 did not precede position 2")
		}
		if second.Precedes(first) {
			t.Fatal("position 2 preceded position 1")
		}
	})

	t.Run("an entry does not precede itself", func(t *testing.T) {
		entry := inStream(task, 7)
		if entry.Precedes(entry) {
			t.Fatal("an entry preceded itself")
		}
	})

	t.Run("entries in different streams are never ordered against each other", func(t *testing.T) {
		// Causality across streams travels through provenance and handoff
		// references, not through a position comparison.
		fromTask, fromSession := inStream(task, 1), inStream(session, 99)
		if fromTask.Precedes(fromSession) || fromSession.Precedes(fromTask) {
			t.Fatal("a cross-stream comparison claimed an order")
		}
	})

	t.Run("two streams of different kinds sharing an id are different streams", func(t *testing.T) {
		sameID := StreamRef{Kind: StreamInstance, ID: "task-1"}
		if inStream(task, 1).Precedes(inStream(sameID, 2)) {
			t.Fatal("stream kind was ignored when comparing streams")
		}
	})
}

func TestEntityRefRendersAndParsesAsEntityAtVersion(t *testing.T) {
	reference := EntityRef{Entity: "order", Version: "3"}
	if got := reference.String(); got != "order@3" {
		t.Fatalf("String() = %q, want %q", got, "order@3")
	}
	parsed, err := ParseEntityRef("order@3")
	if err != nil {
		t.Fatalf("ParseEntityRef = %v", err)
	}
	if parsed != reference {
		t.Fatalf("ParseEntityRef = %#v, want %#v", parsed, reference)
	}
}

func TestParseEntityRefRefusesWhatStringWouldNeverProduce(t *testing.T) {
	cases := map[string]struct {
		input string
		want  error
	}{
		"a reference with no separator is refused": {input: "order", want: ErrEntityRefMalformed},
		"a reference with no entity is refused":    {input: "@3", want: ErrEntityRequired},
		"a reference with no version is refused":   {input: "order@", want: ErrVersionRequired},
		"a reference with a second @ is refused":   {input: "order@3@4", want: ErrEntityRefMalformed},
		"an empty reference is refused":            {input: "", want: ErrEntityRefMalformed},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseEntityRef(testCase.input); !errors.Is(err, testCase.want) {
				t.Fatalf("ParseEntityRef(%q) = %v, want %v", testCase.input, err, testCase.want)
			}
		})
	}
}

// FuzzEntityRefRoundTrip pins the inverse property between ParseEntityRef and
// String. Seeds are the corpus; `go test` replays exactly them, so a CI run is
// a regression check rather than a random search.
func FuzzEntityRefRoundTrip(f *testing.F) {
	f.Add("order@3")
	f.Add("order@v1.2.3")
	f.Add("a@b")
	f.Add("order@3@4")
	f.Add("@")
	f.Add("@3")
	f.Add("order@")
	f.Add("order")
	f.Add("")

	f.Fuzz(func(t *testing.T, input string) {
		reference, err := ParseEntityRef(input)
		if err != nil {
			return
		}
		if reference.String() != input {
			t.Fatalf("ParseEntityRef(%q).String() = %q", input, reference.String())
		}
		again, err := ParseEntityRef(reference.String())
		if err != nil {
			t.Fatalf("re-parsing %q failed: %v", reference.String(), err)
		}
		if again != reference {
			t.Fatalf("round trip changed %#v into %#v", reference, again)
		}
	})
}
