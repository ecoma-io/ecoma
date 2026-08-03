// Package artifact holds the content address: sha256:<digest>.
//
// An Event Log entry's payload carries this address when the bytes live in
// the Artifact Store — the log holds the truth, the store holds the bytes
// (Event Log §1, Artifact Store §1). The address is domain vocabulary the
// entry schema cannot be written without, which is why the package sits here
// rather than beside the store's adapter (ADR-0008 §7).
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/artifact-store.md.
package artifact
