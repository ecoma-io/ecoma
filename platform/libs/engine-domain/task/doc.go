// Package task holds the Task: one instance of work assigned to a Role.
//
// A Task consumes incoming artifacts through a Handoff, produces outgoing ones
// against a Contract, passes a Gate, and declares its effects with their
// reversibility class. Its lifecycle is durable in every state, and the engine
// forces budget, SLA and priority to exist while their values resolve through
// the default cascade.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/task.md.
package task
