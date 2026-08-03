package artifact

import (
	"errors"
	"strings"
	"testing"
)

const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestAddressRendersAsAlgorithmColonDigest(t *testing.T) {
	address := Address{Algorithm: SHA256, Digest: digest}
	if got, want := address.String(), "sha256:"+digest; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

func TestParseAddressRefusesWhatStringWouldNeverProduce(t *testing.T) {
	cases := map[string]struct {
		input string
		want  error
	}{
		"a string with no separator is refused": {
			input: digest,
			want:  ErrAddressMalformed,
		},
		"an algorithm other than sha256 is refused": {
			input: "md5:" + digest,
			want:  ErrAlgorithmUnsupported,
		},
		"an uppercase digest is refused, because two spellings are two keys": {
			input: "sha256:" + strings.ToUpper(digest),
			want:  ErrDigestMalformed,
		},
		"a digest of the wrong length is refused": {
			input: "sha256:" + digest[:len(digest)-1],
			want:  ErrDigestMalformed,
		},
		"a digest that is not hex is refused": {
			input: "sha256:" + strings.Repeat("z", len(digest)),
			want:  ErrDigestMalformed,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseAddress(testCase.input); !errors.Is(err, testCase.want) {
				t.Fatalf("ParseAddress(%q) error = %v, want %v", testCase.input, err, testCase.want)
			}
		})
	}
}

func TestZeroAddressNamesNothing(t *testing.T) {
	// A payload that sits inline carries no address, and that state has to be
	// distinguishable from a malformed one.
	if !(Address{}).IsZero() {
		t.Fatal("the zero Address does not report itself as empty")
	}
	if (Address{Algorithm: SHA256, Digest: digest}).IsZero() {
		t.Fatal("a real address reported itself as empty")
	}
}

// FuzzAddressRoundTrip pins the inverse property: whatever ParseAddress
// accepts, String renders back to the same text, and parsing that text again
// yields the same value. Seeds are the corpus; `go test` replays exactly them,
// so a CI run is a regression check rather than a random search (root
// CLAUDE.md — property and fuzz tests are a unit-tier technique, deterministic
// on CI).
func FuzzAddressRoundTrip(f *testing.F) {
	f.Add("sha256:" + digest)
	f.Add("sha256:" + strings.Repeat("0", 64))
	f.Add("sha256:" + strings.Repeat("f", 64))
	f.Add("sha256:")
	f.Add("sha256:sha256:" + digest)
	f.Add(":")
	f.Add("")
	f.Add("SHA256:" + digest)

	f.Fuzz(func(t *testing.T, input string) {
		address, err := ParseAddress(input)
		if err != nil {
			return
		}
		if address.String() != input {
			t.Fatalf("ParseAddress(%q).String() = %q", input, address.String())
		}
		again, err := ParseAddress(address.String())
		if err != nil {
			t.Fatalf("re-parsing %q failed: %v", address.String(), err)
		}
		if again != address {
			t.Fatalf("round trip changed %#v into %#v", address, again)
		}
	})
}
