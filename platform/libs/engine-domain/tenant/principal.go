package tenant

import (
	"encoding/json"
	"errors"
)

// ID is a tenant identifier. It is the system's only hard boundary, so it
// appears in every value that can be attributed to a tenant rather than being
// carried implicitly by a connection or a process.
type ID string

// PrincipalKind names what sort of actor a Principal is.
//
// The taxonomy is OPEN (tenant-identity.md §1): the constants below are the
// standard kinds, not an enumeration a new kind has to break. A value outside
// them is valid, which is why nothing here refuses an unknown kind.
type PrincipalKind string

const (
	// KindUser is a person inside the tenant.
	KindUser PrincipalKind = "user"
	// KindAgent is a model-backed filler: (model, version, config_hash) plus
	// lineage, defined in Role §3.
	KindAgent PrincipalKind = "agent"
	// KindRule is deterministic code: (code, version), defined in Role §3.
	KindRule PrincipalKind = "rule"
	// KindNode is a device: a keypair plus enrollment, defined by the RPA
	// North Star.
	KindNode PrincipalKind = "node"
	// KindExternal is an actor outside the tenant, reached through a Channel
	// and unified into a Party (tenant-identity.md §5).
	KindExternal PrincipalKind = "external"
)

// PrincipalID is the pseudonymous, permanently immutable identifier of an
// actor. tenant-identity.md §1: changing SSO provider means changing an auth
// adapter, and the actor id already written into the log never changes.
type PrincipalID string

// Principal is the one identity schema every actor kind shares, and the value
// every Event Log entry carries as its actor.
//
// Detail is deliberately an opaque JSON document rather than a set of typed
// per-kind fields. The per-kind identities live in documents ◆G0 does not
// freeze — Role §3 for agent and rule, the RPA North Star for node, Trigger §3
// for external — so typing them here would freeze a shape their own documents
// are still free to settle.
//
// There is deliberately no identity-provider field. tenant-identity.md §1 puts
// SSO behind an auth adapter precisely so that swapping vendors leaves the log
// untouched; a provider field on the principal would put the vendor inside the
// identity and make that promise unkeepable. Its absence is the structure the
// promise rests on, not an omission.
type Principal struct {
	Tenant ID
	Kind   PrincipalKind
	ID     PrincipalID
	Detail json.RawMessage
}

// Refusals a Principal can carry. They are values rather than strings so a
// caller — and the conformance suite — can name the rule that fired instead of
// matching on a message.
var (
	ErrTenantRequired        = errors.New("tenant: principal has no tenant")
	ErrPrincipalKindRequired = errors.New("tenant: principal has no kind")
	ErrPrincipalIDRequired   = errors.New("tenant: principal has no id")
)

// Validate reports why a Principal is not a usable actor identity, or nil.
//
// It never refuses an unknown Kind: the taxonomy is open, and a validator that
// rejected a kind it did not know would turn every new actor kind into a
// breaking change to this package.
func (p Principal) Validate() error {
	if p.Tenant == "" {
		return ErrTenantRequired
	}
	if p.Kind == "" {
		return ErrPrincipalKindRequired
	}
	if p.ID == "" {
		return ErrPrincipalIDRequired
	}
	return nil
}

// InTenant reports whether this principal belongs to tenant t.
//
// A principal with no tenant is in no tenant, and the zero ID names no tenant
// either — so an unset value on either side answers false rather than matching
// another unset value. That asymmetry is the point: the failure this guards
// against is a cross-tenant read that succeeds because two blanks compared
// equal.
func (p Principal) InTenant(t ID) bool {
	return t != "" && p.Tenant == t
}
