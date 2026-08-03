// Package lease holds the Lease: the system's only serialisation primitive.
//
// Working Data is optimistic by default; where serialisation is genuinely
// needed, a Lease is how it is taken. Its contract is what ◆G0 freezes —
// acquire, renew, expiry, a mandatory TTL, and the rule that no lock exists
// outside it, which is what keeps a crashed holder from stopping the system
// indefinitely.
//
// The values and their rules are real here — Request.Validate refuses a lease
// with no TTL, and Lease.ExpiredAt takes the instant as an argument. The store
// behind them (acquire, renew, release) is a port, and lives in engine-ports.
// Source: shared/libs/doctrine/spec/working-data.md §3.
package lease
