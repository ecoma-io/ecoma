// Contract area 4 of 5 — the Lease contract (ADR-0008 §4.2;
// shared/libs/doctrine/spec/working-data.md §3).
//
// TODO: acquire — one holder at a time, and what a second acquirer observes.
// TODO: renew — by the holder, and refused for anyone else.
// TODO: expiry — a holder that stops renewing loses the lease, so a crashed
// holder cannot stop the system indefinitely.
// TODO: the TTL is mandatory — a lease requested without one is refused rather
// than given a default.
// TODO: no lock exists outside the Lease — the negative half of the contract,
// and the one a passing suite most easily leaves unchecked.
package conformanceg0
