// Package calibration holds the assessment space: the CalKey and the Cell it
// addresses.
//
// It is the only home of labour assessment — no other ledger may record how
// often a given filler is wrong — and it stores nothing of its own: every cell
// is a projection of the Event Log and can be rebuilt from it. A Filler's
// profile and a verifier's reliability are two slices of the same space rather
// than two mechanisms.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/calibration.md.
package calibration
