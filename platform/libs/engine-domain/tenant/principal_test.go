package tenant

import (
	"encoding/json"
	"errors"
	"testing"
)

func validPrincipal() Principal {
	return Principal{Tenant: "acme", Kind: KindUser, ID: "u-1"}
}

func TestPrincipalValidateNamesTheMissingField(t *testing.T) {
	cases := map[string]struct {
		principal Principal
		want      error
	}{
		"a principal with no tenant is refused": {
			principal: Principal{Kind: KindUser, ID: "u-1"},
			want:      ErrTenantRequired,
		},
		"a principal with no kind is refused": {
			principal: Principal{Tenant: "acme", ID: "u-1"},
			want:      ErrPrincipalKindRequired,
		},
		"a principal with no id is refused": {
			principal: Principal{Tenant: "acme", Kind: KindUser},
			want:      ErrPrincipalIDRequired,
		},
		"a complete principal is accepted": {
			principal: validPrincipal(),
			want:      nil,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			if err := testCase.principal.Validate(); !errors.Is(err, testCase.want) {
				t.Fatalf("Validate() = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestPrincipalTaxonomyIsOpen(t *testing.T) {
	// A kind this package has never heard of validates. tenant-identity.md §1
	// keeps the taxonomy open, so a validator refusing an unknown kind would
	// make every new actor kind a breaking change to this package.
	unknown := Principal{Tenant: "acme", Kind: PrincipalKind("swarm"), ID: "s-1"}
	if err := unknown.Validate(); err != nil {
		t.Fatalf("Validate() on an unknown kind = %v, want nil", err)
	}
}

func TestPrincipalDetailStaysOpaque(t *testing.T) {
	// Detail is an unparsed JSON document on purpose: the per-kind identities
	// live in documents ◆G0 does not freeze, so this package must carry them
	// without giving them a shape.
	principal := validPrincipal()
	principal.Kind = KindAgent
	principal.Detail = json.RawMessage(`{"model":"m","version":"3","config_hash":"abc"}`)
	if err := principal.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(principal.Detail, &decoded); err != nil {
		t.Fatalf("Detail is not the JSON the caller put there: %v", err)
	}
	if decoded["model"] != "m" {
		t.Fatalf("Detail round-tripped to %v", decoded)
	}
}

func TestInTenantRefusesEveryCrossingOfTheBoundary(t *testing.T) {
	principal := validPrincipal()

	t.Run("a principal is in its own tenant", func(t *testing.T) {
		if !principal.InTenant("acme") {
			t.Fatal("InTenant(own tenant) = false")
		}
	})

	t.Run("a principal is never in another tenant", func(t *testing.T) {
		if principal.InTenant("globex") {
			t.Fatal("InTenant(other tenant) = true")
		}
	})

	t.Run("a principal with no tenant is in no tenant", func(t *testing.T) {
		if (Principal{Kind: KindUser, ID: "u-1"}).InTenant("acme") {
			t.Fatal("a tenant-less principal matched a real tenant")
		}
	})

	t.Run("the empty tenant matches nothing, not even another empty one", func(t *testing.T) {
		// Two blanks comparing equal is how a cross-tenant read succeeds by
		// accident, so the zero value must answer false on both sides.
		if principal.InTenant("") {
			t.Fatal("a real principal matched the empty tenant")
		}
		if (Principal{}).InTenant("") {
			t.Fatal("two unset tenants compared equal")
		}
	})
}
