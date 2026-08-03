package artifact

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// Algorithm names the hash function an Address is keyed by. It is a named
// type rather than a bare string so that widening the set later is a change to
// this package rather than to every caller that spelled a literal.
type Algorithm string

// SHA256 is the only algorithm ◆G0 freezes. Artifact Store §2 keeps the
// backend taxonomy open, but the address itself has to be one agreed spelling
// or two stores disagree about whether they hold the same blob.
const SHA256 Algorithm = "sha256"

// digestLen is the rendered length of a SHA-256 digest, derived from the hash
// itself rather than written as 64 — the two can then never disagree.
var digestLen = hex.EncodedLen(sha256.Size)

// Address is the content address of a blob: an algorithm and the digest it
// produced. Its rendered form is "sha256:<lowercase hex>".
type Address struct {
	Algorithm Algorithm
	Digest    string
}

// Refusals ParseAddress and Validate can carry.
var (
	ErrAddressMalformed     = errors.New("artifact: address is not <algorithm>:<digest>")
	ErrAlgorithmUnsupported = errors.New("artifact: unsupported address algorithm")
	ErrDigestMalformed      = errors.New("artifact: digest is not lowercase hex of the algorithm's length")
)

// IsZero reports whether the address names nothing — the state a payload that
// sits inline is in.
func (a Address) IsZero() bool {
	return a.Algorithm == "" && a.Digest == ""
}

// Validate reports why an Address is not a usable content address, or nil.
//
// The digest must be lowercase hex of exactly the algorithm's length. Case is
// part of the contract rather than a nicety: two spellings of one digest are
// two keys in a content-addressed store, and dedup that misses is the whole
// value of content addressing lost.
func (a Address) Validate() error {
	if a.Algorithm != SHA256 {
		return fmt.Errorf("%w: %q", ErrAlgorithmUnsupported, a.Algorithm)
	}
	if len(a.Digest) != digestLen || strings.ToLower(a.Digest) != a.Digest {
		return fmt.Errorf("%w: %q", ErrDigestMalformed, a.Digest)
	}
	if _, err := hex.DecodeString(a.Digest); err != nil {
		return fmt.Errorf("%w: %q", ErrDigestMalformed, a.Digest)
	}
	return nil
}

// String renders the address as "<algorithm>:<digest>". It is the inverse of
// ParseAddress for every address ParseAddress accepts.
func (a Address) String() string {
	return string(a.Algorithm) + ":" + a.Digest
}

// ParseAddress reads the rendered form back into an Address, refusing anything
// String would never have produced.
func ParseAddress(s string) (Address, error) {
	algorithm, digest, found := strings.Cut(s, ":")
	if !found {
		return Address{}, fmt.Errorf("%w: %q", ErrAddressMalformed, s)
	}
	address := Address{Algorithm: Algorithm(algorithm), Digest: digest}
	if err := address.Validate(); err != nil {
		return Address{}, err
	}
	return address, nil
}
