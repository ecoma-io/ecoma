---
title: "Trigger & Channel"
status: design-end-state
---

# Trigger & Channel

## 1. Definitions

| Entity      | What it is                                                                                                                                                      | Identity                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Trigger** | A mechanism declared in a Process definition: when event X arrives, either spawn a new instance or feed input into an instance already waiting                  | Id and version, belonging to the definition |
| **Channel** | A boundary adapter for two-way conversation with the outside — chat widget, Messenger/Zalo, Slack, email, SMS — an open taxonomy following RPA's driver pattern | (type, id, version) plus lineage            |

## 2. Trigger

| Field              | Content                                                                                                                                                                                                                                | Required                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `type`             | An open taxonomy: `webhook` / `event` / `schedule` / `message_in(channel)` / `manual` / `form`                                                                                                                                         | ✅                          |
| `auth`             | **The engine forces it to exist**: HMAC signature, token, mTLS, or `tenant_session` for internal manual and scheduled triggers. Invalid auth is rejected at the boundary and no instance is created                                    | ✅                          |
| `payload_contract` | The payload enters **through a Handoff with a Contract**, with the external source as producer. A schema breach is a Violation, rejected or coerced like any handoff. There is no path by which raw JSON flows straight into a process | ✅                          |
| `dedup`            | Event id plus a dedup window — the engine forces it, a template values it. At-least-once delivery from the outside world does not create duplicate instances                                                                           | ✅                          |
| `correlation`      | A key expression, such as a conversation id, deciding whether to spawn or route into a waiting instance                                                                                                                                | ✅ for conversational types |
| `guard`            | Rate and budget at the boundary, so an external storm does not flood the engine — the same reasoning as Escalation's storm control                                                                                                     | ✅                          |

**Response mode — synchronous request/response.**

A `webhook` trigger declares `response_mode: async` (default) `| sync`. A sync
trigger additionally declares `response_from` — the output artifact of a named
task, through a version-pinned Contract — a `time_budget`, and `on_timeout: fail
| degrade_to_async`, the latter returning a ticket id while the instance
continues asynchronously and durably.

**Responding is an `irreversible` effect**, inheriting the whole effect law: it
is logged, it egresses by classification, and a leakage gate can be applied to
the response — so an API endpoint cannot leak internal knowledge about the
system's own structure.

**There is no timeout-to-pass path**: `on_timeout` may only fail or degrade,
consistent with the invariant that nothing ever auto-passes because it is stuck.

The constraint on a sync path is **the time budget, not the kind of filler**. Any
filler that fits the budget is valid; a person is excluded by physics, never by
an engine rule. That is what keeps the symmetry intact here. Static analysis
enforces the rest: the path to `response_from` contains no `awaiting` state,
every step declares a budget, and spawning on that path is capped.

Idempotence is natural: a retry with the same event id inside the dedup window
returns the **cached response**, since the artifact is content-addressed.

## 3. An external participant is a Role

Symmetry taken to its conclusion: **an outside end user is a Filler of kind
`external`** filling a Role in the process — a "Customer" Role, say — with the
channel identity as their identity.

A conversation is **a chain of alternating Tasks**: a Task of the Agent Role, AI
or human, answering; a Handoff; a Task of the Customer Role awaiting a reply; the
customer's reply as that task's output; a Handoff back to the Agent. An instance
waiting on a customer is a durable `awaiting` Task, so a customer returning three
days later finds the state intact. That is the existing Task mechanism with
nothing added. Correlation simultaneously creates the **subject binding** for the
instance, which is the entry point for the Memory module (Memory §1).

A customer's reply **can pass through a Gate**, which makes input validation and
moderation the Checkpoint primitive rather than a separate filtering system.

Calibration over an external filler exists mechanically, out of symmetry, and is
**off by default** — enabling it is a tenant's policy and privacy decision.
Detailed end-user identification is **Party** (Tenant & Identity §5).

A chatbot's handoff to a human is the existing `reroute` or
`assistance_request`. It is not a feature of its own.

## 4. Channel

A Channel only **translates**; it holds no logic. Inbound becomes a `message_in`
trigger; outbound becomes an **effect** — sending a message is `irreversible` by
default — and carries every guard an effect carries: the confidence floor of the
Gate before it, and **egress by classification** (Knowledge §3).

A Channel declares its `capabilities` — rich text, attachments, typing indicator
— and a process using more than the channel declares is a static analysis error
rather than a runtime surprise.

The Channel adapter interface is Apache 2.0, so third parties write adapters
freely. Same reasoning as the RPA driver.

## 5. Duality

|                  | Deterministic                                                   | Conversational                                                            |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Trigger          | webhook / schedule / event                                      | `message_in` plus correlation                                             |
| Shape            | A pipeline declared up front                                    | Alternating Agent ⇄ Customer tasks; the graph grows with the conversation |
| Shared mechanism | Handoff contract at the boundary, dedup, guard, outbound effect | Identical                                                                 |

## 6. Non-goals

- No messaging platform is being built, and this is not a general API gateway. A
  Channel is a door into a process.
- A Trigger holds no business routing logic — that belongs to Role and Task. It
  handles auth, validation and correlation.

## 7. Decisions

| Question                     | Settled                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payload entering the system  | Always a Handoff with a Contract — there is no raw path                                                                                                                                                      |
| Auth                         | The engine forces it to exist; no auth means rejection at the boundary                                                                                                                                       |
| Multi-turn conversation      | Correlation plus a durable `awaiting` Task; the end user is an `external` Filler of a Role                                                                                                                   |
| Input moderation             | A Gate on the Customer Role's output — the Checkpoint primitive reused                                                                                                                                       |
| Sending a message out        | An irreversible effect by default, egressing by classification                                                                                                                                               |
| Synchronous request/response | `response_mode: sync` is opt-in; responding is an effect; a timeout may only fail or degrade, never pass; the constraint is the time budget rather than the kind of filler; responses are cached by event id |
| Calibrating a customer       | The mechanism exists and is off by default, for privacy                                                                                                                                                      |

## Litmus

1. Is a trigger without valid auth rejected at the boundary — no instance
   created, and an event recorded?
2. Does the second message of a conversation reach the same instance through
   correlation?
3. On a sync response, can a timeout only fail or degrade — with no path at all
   by which it becomes a pass?

## Failure modes

| Failure                               | Detected by                  | Recovery                                                                  |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| A forged webhook                      | Auth verification fails      | Rejected at the boundary with an event; no instance created               |
| A duplicate event from outside        | The dedup window by event id | Ignored; a sync trigger returns the cached response                       |
| A channel adapter is down             | The outbound effect fails    | `on_fail` or escalation; inbound, the source retries and dedup absorbs it |
| Verification overruns the sync budget | `time_budget`                | `on_timeout`: fail, or degrade to a ticket — never a pass                 |
