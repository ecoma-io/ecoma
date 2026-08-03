// Package keytree holds the three-tier key hierarchy crypto-shredding rests
// on: root key, per-tenant data key, per-subject key.
//
// Exactly three tiers, and the number is fixed rather than configurable: with
// one tier an individual cannot be shredded, with an arbitrary number the
// mapping cannot be rebuilt. Each tier wraps the one below by envelope
// encryption, so destroying a tier destroys everything under it. A key value
// never leaves the vault — everything else holds a handle.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/vault-key.md.
package keytree
