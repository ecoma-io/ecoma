package lease

import (
	"errors"
	"time"

	"ecoma.io/platform/engine-domain/tenant"
)

// Key names what is being serialised: a definition key for a `singleton: true`
// process, a correlation key for a business mutex, a serialization_key for a
// handoff queue. One primitive, several faces (working-data.md §3).
type Key string

// Holder is who holds a lease. Provenance always knows who is holding the key,
// so the holder is a full Principal rather than an opaque token — a lease
// whose holder cannot be named is a lock, which is the thing this primitive
// exists instead of.
type Holder struct {
	Principal tenant.Principal
	TaskID    string
}

// Request asks for a lease.
type Request struct {
	Tenant tenant.ID
	Key    Key
	Holder Holder
	TTL    time.Duration
}

// Lease is a granted, time-bounded right to a Key.
//
// RenewedAt is zero until the first renewal; ExpiresAt is the only field
// expiry is read from, so a renewal moves one value rather than requiring
// every reader to recompute AcquiredAt plus a TTL.
type Lease struct {
	Tenant     tenant.ID
	Key        Key
	Holder     Holder
	AcquiredAt time.Time
	RenewedAt  time.Time
	ExpiresAt  time.Time
}

// Refusals a lease request or a lease operation can carry. The store-facing
// ones live here with the vocabulary they belong to, so an adapter reports the
// domain's refusal rather than inventing a parallel set.
var (
	ErrTenantRequired = errors.New("lease: request has no tenant")
	ErrKeyRequired    = errors.New("lease: request has no key")
	ErrHolderRequired = errors.New("lease: request has no valid holder")
	ErrTTLRequired    = errors.New("lease: request has no TTL")
	ErrHeld           = errors.New("lease: key is held by another holder")
	ErrNotHolder      = errors.New("lease: caller is not the holder")
	ErrExpired        = errors.New("lease: lease has expired")
	ErrNotFound       = errors.New("lease: no lease for this key")
)

// Validate reports why a request cannot be granted, or nil.
//
// A non-positive TTL is REFUSED, never defaulted. The engine forces the TTL to
// exist so that an infinite lock is structurally impossible rather than merely
// discouraged (working-data.md §3) — and a default would restore exactly the
// possibility the refusal removes, since a caller who forgot the TTL would get
// a lock whose length nobody chose.
func (r Request) Validate() error {
	if r.Tenant == "" {
		return ErrTenantRequired
	}
	if r.Key == "" {
		return ErrKeyRequired
	}
	if err := r.Holder.Principal.Validate(); err != nil {
		return ErrHolderRequired
	}
	if !r.Holder.Principal.InTenant(r.Tenant) {
		return ErrHolderRequired
	}
	if r.TTL <= 0 {
		return ErrTTLRequired
	}
	return nil
}

// ExpiredAt reports whether the lease has expired as of now.
//
// The instant is an argument rather than a call to time.Now inside: expiry is
// the one lease behaviour a test has to drive, and a lease that read its own
// clock could only be tested by sleeping. It is also what keeps the answer
// from depending on whichever machine's clock happened to be asked.
func (l Lease) ExpiredAt(now time.Time) bool {
	return !now.Before(l.ExpiresAt)
}
