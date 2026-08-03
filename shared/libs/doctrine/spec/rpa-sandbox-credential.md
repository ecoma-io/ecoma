---
title: "RPA: Sandbox & Credential"
status: design-end-state
---

# RPA: Sandbox & Credential

## 1. Sandbox — one enclosure per session

| Environment | Isolation mechanism                                                                    |
| ----------- | -------------------------------------------------------------------------------------- |
| Browser     | A dedicated profile or container per session: cookies, storage and extensions isolated |
| Desktop     | A VM or dedicated user session; an open taxonomy, per driver                           |

The isolation level is a cascade parameter: the engine forces it to exist, a
template supplies the value — strict for production, loose for development.

A sandbox dies with its session unless `persistent_profile` is declared, for a
login that has to survive across sessions. A persistent profile is then a
resource with an id and a credential scope of its own, because a shared login
that belongs to nothing is a credential nobody can revoke.

**Network egress policy belongs to the sandbox**: a domain allowlist, so a
session cannot wander outside its scope.

## 2. The credential vault

A secret lives only in the vault — an internal one when standalone, an adapter
to an external vault under integration or enterprise, over an open taxonomy. An
action references only a **credential handle** (Action §3).

**Injection happens at the driver layer.** The runtime types or fills the value
into the target field at the lowest level available, so the executor — script
_and_ agent alike — only ever says "put credential X into field Y" and **never
touches the value**. An executor that could hold the value would also be able to
log it, and no rule about logging can be as strong as not having it.

Every use of a handle writes an audit entry: handle, action, session, actor.
Never the value.

Handles are issued per session scope (Session §6): a session that was not
granted one cannot ask for it.

## 3. Masking at the source — a single chokepoint

The perception layer marks sensitive regions **before a Scene leaves perception**
(Driver & Perception §2), from three sources over an open taxonomy: the field
type in the structural tree (password, card, …), regions tagged by an App
Profile, and a pattern detector for card numbers and tokens.

The consequence is the whole point: agent context, action log, evidence, replay,
and any screenshot a person sees have **only ever seen a clean scene**. There is
no "redact afterwards" step, because afterwards means it already leaked.

**Input masking is the symmetric half.** It is not only the scene: any input that
is _captured_ — human takeover, record mode — typed into a field tagged
sensitive is redacted to `[masked:field-type]` **at the capture layer**, before
it can become an Action parameter in the log. A person typing their own password
during takeover has the action recorded and the value never recorded, from the
same three tag sources.

**The live-view channel during takeover also sees only a clean Scene.** The
per-session view-and-control stream (RPA North Star §4) is a **projection of the
masked Scene** and is **never** a raw framebuffer or screencast. Otherwise a
remote helper becomes a fourth consumer standing outside the single chokepoint.
Where a driver cannot provide a masked live view, takeover is valid only in its
**attended** form — the person sitting at that machine, who already sees their
own screen — and **no remote viewing channel opens at all**. Missing a
capability makes the rule stricter, never looser.

The trade-off is stated rather than hidden: a missed mask is a real risk, so the
pattern detector carries a version and calibration measured by sampled review,
and an App Profile is where a missed region gets patched permanently.

## 4. Permission scope — a right is something declared

The session scope, with the engine forcing it to exist and the cascade supplying
values:

| Axis                 | Example                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| App / domain         | `*.salesforce.com` only                                                                |
| Maximum action class | `read` (a read-only session — the standard rail for a `spawn_policy`), `reversible`, … |
| Credential handles   | An explicit list                                                                       |
| Session ceilings     | Wall-clock limit, action count limit, model cost limit                                 |

Exceeding the scope means the action is blocked at the engine **before it
reaches the driver**, and an escalation is emitted. It is a hard boundary rather
than an executor's error, which is what makes it hold for an executor nobody
wrote carefully.

Under integration the scope is a declared part of the Session effect, so the
platform can see it and static analysis can judge it — "this task grants
irreversible rights while the Gate before it has no floor" is Composition §4
extending naturally down into the RPA layer.

**The scope is also the line between two capabilities that look alike and are
not.** Solving an access challenge — a CAPTCHA presented to a session inside a
domain the tenant holds a declared credential for — is an action within scope:
the actor is still the machine, the action is still an entry in the log, and
where the tenant is an authorised user the destination's own record stays
truthful. **Engineering undetectability** — spoofing a fingerprint, rotating
residential proxies, mimicking human timing to defeat a detector — is not the
same act and is not authored here, because its only function is to make the
destination misattribute the machine as a human, which is the one thing the
action log exists to prevent (RPA North Star non-goals). If a tenant needs it, it
arrives as a `code`-class driver, opt-in, at the tenant's own terms-of-service
and legal exposure. A destination that blocks silently, presenting no challenge
to solve, therefore falls on the far side of the line: the authorised case is
declined at the engine rather than served by crossing into evasion — the
conservative reading, consistent with reversibility-not-declared-is-irreversible.

## 5. Non-goals

- No secret is stored outside the vault, and there is no "bare, no sandbox"
  mode: the loosest level is still an isolated profile.
- An executor never receives a secret value, even when a user tries to pass one
  directly. The engine refuses and offers to create a handle instead.

## 6. Decisions

| Question                     | Settled                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Isolation                    | One sandbox per session; a persistent profile is a resource with its own id and scope                                                                                                                                                                                          |
| Secrets                      | Handle-only; injection at the driver; the executor is absolutely blind to the value                                                                                                                                                                                            |
| Masking                      | At the perception layer, a single chokepoint; the detector carries calibration; App Profile patches misses                                                                                                                                                                     |
| Rights                       | A four-axis declared scope, blocked at the engine, judgeable by static analysis under integration                                                                                                                                                                              |
| Live view                    | A projection of the masked Scene; where a driver cannot, takeover is attended-only with no remote channel                                                                                                                                                                      |
| Access challenges vs evasion | Solving a presented challenge on an authorised, declared-credential domain is an in-scope Action; undetectability engineering is not authored — an opt-in `code`-class driver at the tenant's own exposure, and a silently-blocking destination is declined rather than evaded |

## Litmus

1. Does the executor — script _and_ agent — have any path that receives a secret
   **value** rather than a handle?
2. A person types a password during takeover: does the action reach the log
   while the value never reaches log, evidence or context?
3. Does a remote viewer during takeover have any path to what was masked — a raw
   framebuffer, an image from before masking?
4. A session solves a CAPTCHA on a domain it holds a declared credential for — is
   the action an ordinary logged Action with its actor? And is there any
   first-party capability whose function is to make a destination misattribute the
   machine as a human?
