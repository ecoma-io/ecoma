package lease

import (
	"errors"
	"testing"
	"time"

	"ecoma.io/platform/engine-domain/tenant"
)

func validRequest() Request {
	return Request{
		Tenant: "acme",
		Key:    "close:2026-08",
		Holder: Holder{
			Principal: tenant.Principal{Tenant: "acme", Kind: tenant.KindAgent, ID: "a-1"},
			TaskID:    "task-1",
		},
		TTL: 30 * time.Second,
	}
}

func TestRequestValidateNamesTheRuleThatFired(t *testing.T) {
	cases := map[string]struct {
		mutate func(*Request)
		want   error
	}{
		"a request with no tenant is refused": {
			mutate: func(r *Request) { r.Tenant = "" },
			want:   ErrTenantRequired,
		},
		"a request with no key is refused": {
			mutate: func(r *Request) { r.Key = "" },
			want:   ErrKeyRequired,
		},
		"a request whose holder cannot be named is refused": {
			mutate: func(r *Request) { r.Holder.Principal = tenant.Principal{} },
			want:   ErrHolderRequired,
		},
		"a request whose holder belongs to another tenant is refused": {
			mutate: func(r *Request) { r.Holder.Principal.Tenant = "globex" },
			want:   ErrHolderRequired,
		},
		"a complete request is accepted": {
			mutate: func(*Request) {},
			want:   nil,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			request := validRequest()
			testCase.mutate(&request)
			if err := request.Validate(); !errors.Is(err, testCase.want) {
				t.Fatalf("Validate() = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestATTLIsRefusedRatherThanDefaulted(t *testing.T) {
	// working-data.md §3: the engine forces the TTL to exist so that an
	// infinite lock is structurally impossible. A default would restore
	// exactly the possibility the refusal removes — a caller who forgot the
	// TTL would get a lock whose length nobody chose — so a zero or negative
	// TTL must be an error and must leave the request unchanged.
	for name, ttl := range map[string]time.Duration{
		"a request with no TTL is refused":         0,
		"a request with a negative TTL is refused": -time.Second,
	} {
		t.Run(name, func(t *testing.T) {
			request := validRequest()
			request.TTL = ttl
			if err := request.Validate(); !errors.Is(err, ErrTTLRequired) {
				t.Fatalf("Validate() = %v, want %v", err, ErrTTLRequired)
			}
			if request.TTL != ttl {
				t.Fatalf("Validate() defaulted the TTL to %v", request.TTL)
			}
		})
	}
}

func TestExpiryIsReadAgainstTheInstantTheCallerSupplies(t *testing.T) {
	expiresAt := time.Unix(1_700_000_000, 0).UTC()
	granted := Lease{
		Tenant:     "acme",
		Key:        "close:2026-08",
		AcquiredAt: expiresAt.Add(-30 * time.Second),
		ExpiresAt:  expiresAt,
	}

	cases := map[string]struct {
		now  time.Time
		want bool
	}{
		"a lease before its expiry has not expired":     {now: expiresAt.Add(-time.Nanosecond), want: false},
		"a lease exactly at its expiry has expired":     {now: expiresAt, want: true},
		"a lease after its expiry has expired":          {now: expiresAt.Add(time.Hour), want: true},
		"expiry is read in UTC or any other zone alike": {now: expiresAt.In(time.FixedZone("x", 3600)), want: true},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			if got := granted.ExpiredAt(testCase.now); got != testCase.want {
				t.Fatalf("ExpiredAt(%v) = %v, want %v", testCase.now, got, testCase.want)
			}
		})
	}
}
