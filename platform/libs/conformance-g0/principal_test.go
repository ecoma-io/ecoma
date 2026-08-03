// Contract area 5 of 5 — Principal identity (ADR-0008 §4.2;
// shared/libs/doctrine/spec/tenant-identity.md §1).
//
// TODO: the principal schema — one shape for every actor kind, with the
// taxonomy open rather than an enumeration a new kind has to break.
// TODO: the actor id is stable — changing an auth adapter never changes the id
// already written into the log.
// TODO: tenant scoping — a principal is namespaced by tenant, and the boundary
// is never crossed.
package conformanceg0
