// Package tenant holds the tenant boundary and the Principal identity schema
// every Event Log entry carries.
//
// Principal identity is what ◆G0 freezes here: one open taxonomy of actor
// kinds (user, agent, rule, node, external) under one schema, with the actor
// id in the log stable across a change of identity vendor. The tenant is the
// system's only hard boundary — every concept is namespaced by it, and
// self-hosting differs from Cloud by tenant count, never by a code branch.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/tenant-identity.md.
package tenant
