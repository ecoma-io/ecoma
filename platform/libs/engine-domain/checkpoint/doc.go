// Package checkpoint holds the four entities of the judgement model: Gate,
// Judgment, Criterion and Conflict.
//
// A Gate is the decision point where a Task's output either flows on or does
// not; a Judgment is an append-only record of assessment attached to that
// output permanently; a Criterion is versioned and reused across processes; a
// Conflict is the signal that a rubric needs fixing. The engine is symmetric
// here — a person, an agent and a rule are judged by the same mechanism.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/checkpoint.md.
package checkpoint
