// Package tenant holds the tenant boundary and the Principal identity schema
// every Event Log entry carries.
//
// Principal identity is what ◆G0 freezes here: one open taxonomy of actor
// kinds (user, agent, rule, node, external) under one schema, with the actor
// id in the log stable across a change of identity vendor. The tenant is the
// system's only hard boundary — every concept is namespaced by it, and
// self-hosting differs from Cloud by tenant count, never by a code branch.
//
// The schema is real here: Principal with its open PrincipalKind taxonomy,
// Validate and InTenant. What is deliberately absent is any identity-provider
// field — see Principal's own documentation for why that absence carries the
// promise rather than breaking it. Source: shared/libs/doctrine/spec/tenant-identity.md.
package tenant
