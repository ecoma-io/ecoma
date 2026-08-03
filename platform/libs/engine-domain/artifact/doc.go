// Package artifact holds the content address that names a blob in the
// Artifact Store.
//
// Artifact Store §1 splits the truth from the bytes: the Event Log holds the
// metadata, the provenance and the hash of every artifact, and the blob store
// holds the bytes keyed by that hash. This package owns the hash half of that
// split — the address as a value — and nothing else. Losing a blob is not
// losing history precisely because the address survives it.
//
// It deliberately cannot compute an address. Hashing needs a byte stream, and
// a domain package that took an io.Reader would have made I/O part of the
// vocabulary every other layer is written in terms of; the address is a value,
// and producing one from bytes belongs to the adapter that already holds them.
package artifact
