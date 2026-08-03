// Package role holds the Role: a capability contract for one position of
// labour, independent of who or what currently occupies it.
//
// The Role/Filler separation is the mechanism behind the system's first
// litmus — moving a step from a person to an AI is not a process edit, because
// the process only ever knew the Role. A Role declares its io_contracts, the
// criteria its output is judged against, its capabilities, and how a Filler is
// chosen when there are several.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/role.md.
package role
