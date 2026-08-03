// Package engineadapters is the root of the implementations behind the
// engine's ports.
//
// Every port contract here runs against both deployment shapes rather than
// against one backend wearing two names: the small stack ships SQLite and the
// filesystem blob store, the reference stack ships Postgres and the
// S3-compatible blob store (ADR-0002 defaults by shape; ADR-0008 §4 assigns
// the blob backends).
//
// This project is also the home of three arbiters that are not gate arbiters —
// the SQL-read, metrics-projection and key-store port contracts, each against
// both stacks. They arbitrate the milestone exit litmus rather than a gate, so
// they are ordinary integration tests (*_integration_test.go) under the `test`
// target and deliberately carry no `conformance` target: a suite arbitrates a
// named gate or nothing (ADR-0008 §4.3).
//
// TODO: no adapters yet. Each lands with the port it implements.
package engineadapters
