// Package composition holds process definitions and their instances.
//
// A definition is not a sixth primitive: it is an Artifact conforming to the
// standard process-definition contract, so it inherits content addressing,
// immutability, provenance, version pinning and the ability to pass a Gate. An
// instance pins its definition version at launch, and migrating it is an
// explicit Task with its own Gate. The default cascade
// (tenant, template, process, role, task) is resolved here.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/composition.md.
package composition
