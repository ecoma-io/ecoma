// Contract area 5 of 5 — Principal identity (ADR-0008 §4.2;
// shared/libs/doctrine/spec/tenant-identity.md §1).
//
// The area names two halves: the principal schema, and its tenant scoping.
// Both run at the unit tier, against the domain value, because both are
// properties of the identity itself rather than of any store that holds one.
//
// A NAMED EXCEPTION, weaker than the specification's own litmus. §1's promise
// is that changing SSO provider changes an auth adapter and never the actor id
// already written into the log. Exercising that needs two auth adapters and a
// log to compare across, none of which exist at ◆G0 — so what is pinned here
// is the STRUCTURE the promise rests on: the Principal carries no
// identity-provider field, and the per-kind identity stays an opaque document.
// That is a structural pin, not the litmus; the behavioural half arrives with
// the first auth adapter and is arbitrated there.
package conformanceg0

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"ecoma.io/platform/engine-domain/tenant"
)

func principal() tenant.Principal {
	return tenant.Principal{Tenant: "acme", Kind: tenant.KindUser, ID: "user-1"}
}

func TestPrincipalIsOneSchemaForEveryActorKind(t *testing.T) {
	t.Run("every standard kind uses the same shape", func(t *testing.T) {
		// One schema for every actor kind is the claim; the proof is that a
		// person, a model, deterministic code, a device and an outside party
		// all validate as the same type, with no per-kind field between them.
		for _, kind := range []tenant.PrincipalKind{
			tenant.KindUser, tenant.KindAgent, tenant.KindRule,
			tenant.KindNode, tenant.KindExternal,
		} {
			candidate := principal()
			candidate.Kind = kind
			if err := candidate.Validate(); err != nil {
				t.Fatalf("kind %q was refused: %v", kind, err)
			}
		}
	})

	t.Run("the taxonomy is open, so a kind this build has never heard of is valid", func(t *testing.T) {
		// tenant-identity.md §1 keeps the taxonomy open rather than an
		// enumeration a new kind has to break.
		candidate := principal()
		candidate.Kind = tenant.PrincipalKind("swarm")
		if err := candidate.Validate(); err != nil {
			t.Fatalf("an unknown kind was refused: %v", err)
		}
	})

	t.Run("a principal missing a required field is refused, and the refusal names it", func(t *testing.T) {
		cases := map[string]struct {
			mutate func(*tenant.Principal)
			want   error
		}{
			"no tenant": {
				mutate: func(p *tenant.Principal) { p.Tenant = "" },
				want:   tenant.ErrTenantRequired,
			},
			"no kind": {
				mutate: func(p *tenant.Principal) { p.Kind = "" },
				want:   tenant.ErrPrincipalKindRequired,
			},
			"no id": {
				mutate: func(p *tenant.Principal) { p.ID = "" },
				want:   tenant.ErrPrincipalIDRequired,
			},
		}
		for name, testCase := range cases {
			t.Run(name, func(t *testing.T) {
				candidate := principal()
				testCase.mutate(&candidate)
				if err := candidate.Validate(); !errors.Is(err, testCase.want) {
					t.Fatalf("Validate() = %v, want %v", err, testCase.want)
				}
			})
		}
	})

	t.Run("the per-kind identity is carried opaquely, so no unfrozen document shapes this one", func(t *testing.T) {
		// An agent's (model, version, config_hash) belongs to Role §3, a
		// node's keypair to the RPA North Star. Neither document is frozen at
		// ◆G0, so the schema carries them without giving them a shape.
		candidate := principal()
		candidate.Kind = tenant.KindAgent
		candidate.Detail = json.RawMessage(`{"model":"m","version":"3","config_hash":"abc"}`)
		if err := candidate.Validate(); err != nil {
			t.Fatalf("Validate() = %v, want nil", err)
		}
		var decoded map[string]string
		if err := json.Unmarshal(candidate.Detail, &decoded); err != nil {
			t.Fatalf("Detail did not survive as the caller's own JSON: %v", err)
		}
		if decoded["config_hash"] != "abc" {
			t.Fatalf("Detail round-tripped to %v", decoded)
		}
	})

	t.Run("no field names an identity provider, which is what keeps the actor id stable", func(t *testing.T) {
		// See the named exception in this file's header. Swapping SSO
		// providers cannot change an id whose schema has nowhere to record a
		// provider — that absence is the structure, and this is the half of
		// the promise ◆G0 can actually check.
		forbidden := map[string]bool{
			"idp": true, "identityprovider": true, "provider": true,
			"issuer": true, "sso": true, "subject": true, "externalsubject": true,
			"authprovider": true, "connection": true, "realm": true,
		}
		shape := reflect.TypeOf(tenant.Principal{})
		for i := range shape.NumField() {
			name := shape.Field(i).Name
			if forbidden[strings.ToLower(name)] {
				t.Fatalf("Principal grew the field %q, putting the identity vendor inside the identity", name)
			}
		}
	})
}

func TestPrincipalIsNamespacedByTenantAndTheBoundaryIsNeverCrossed(t *testing.T) {
	t.Run("a principal belongs to its own tenant", func(t *testing.T) {
		if !principal().InTenant("acme") {
			t.Fatal("a principal did not belong to its own tenant")
		}
	})

	t.Run("a principal never belongs to another tenant", func(t *testing.T) {
		// The tenant is the system's only hard boundary (tenant-identity.md
		// §2), so this is the one refusal the whole boundary rests on.
		if principal().InTenant("globex") {
			t.Fatal("a principal crossed the tenant boundary")
		}
	})

	t.Run("a principal with no tenant belongs to no tenant", func(t *testing.T) {
		orphan := tenant.Principal{Kind: tenant.KindUser, ID: "user-1"}
		if orphan.InTenant("acme") {
			t.Fatal("a tenant-less principal was admitted to a tenant")
		}
	})

	t.Run("the unset tenant matches nothing, not even another unset one", func(t *testing.T) {
		// Two blanks comparing equal is how a cross-tenant read succeeds by
		// accident rather than by decision, which is the failure this boundary
		// exists to make impossible.
		if principal().InTenant("") {
			t.Fatal("a real principal matched the unset tenant")
		}
		if (tenant.Principal{}).InTenant("") {
			t.Fatal("two unset tenants compared equal")
		}
	})

	t.Run("the tenant is part of the identity, so two tenants' actors never collide", func(t *testing.T) {
		// The same actor id in two tenants is two principals, not one — the
		// property per-tenant namespacing exists to give.
		here := principal()
		there := principal()
		there.Tenant = "globex"
		if reflect.DeepEqual(here, there) {
			t.Fatal("the same id in two tenants produced one principal")
		}
		if there.InTenant("acme") || here.InTenant("globex") {
			t.Fatal("a principal was admitted to the other tenant")
		}
	})
}
