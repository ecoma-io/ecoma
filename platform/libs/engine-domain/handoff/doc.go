// Package handoff holds the transfer of an Artifact from a producing Role to a
// consuming Role under an explicit Contract.
//
// The Contract carries both halves of what the two kinds of labour need — the
// context a person can be told and the structure an AI can be checked against
// — which is what makes the Handoff the point where they meet at the level of
// data. Contracts are version-pinned, so a producer's change cannot silently
// reach a running consumer.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/handoff.md.
package handoff
