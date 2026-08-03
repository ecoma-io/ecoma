// Package escalation holds the path declared in advance for every way things
// can deviate.
//
// Every Role, Gate and Task carries an escalation chain with a mandatory
// terminal handler, so that the state "silently stuck, indefinitely" does not
// exist anywhere in the system. That is a statement about the shape of the
// system rather than about diligence: a chain with no bottom does not announce
// itself, work simply stops being finished and nobody is told.
//
// TODO: no types yet. Fills with shared/libs/doctrine/spec/escalation.md.
package escalation
