---
title: "RPA: Action"
status: design-end-state
---

# RPA: Action

An Action is **one unit of interaction with an environment, carrying an
identity, an intent and its evidence**. Those three are what let a recorded run
be audited by someone who was not watching it, and they are why an Action is an
entity rather than a line in a script.

## 1. Two faces

|          | Action Definition                                        | Action Instance                         |
| -------- | -------------------------------------------------------- | --------------------------------------- |
| What     | A kind of action in the vocabulary (click, type, …)      | One concrete execution inside a session |
| Identity | Id and version — a first-class entity, held in a library | Id and position in the action log       |

## 2. The core vocabulary, open by construction

| Group      | Actions                                                           | Default class            |
| ---------- | ----------------------------------------------------------------- | ------------------------ |
| Observe    | `observe`, `extract`, `wait_for`, `assert`                        | `read` — always safe     |
| Navigate   | `navigate`, `scroll`, `switch_context` (tab/window/frame)         | `read`\*                 |
| Manipulate | `click`, `type`, `select`, `press_keys`, `drag`, `hover`          | `reversible`\*           |
| Data       | `upload`, `download`, `clipboard`                                 | declared                 |
| Composite  | **Macro** — a named sequence with its own id, version and lineage | the maximum of its parts |

\* The vocabulary's default only; an **App Profile overrides it per context**.
Clicking a "Send" button is irreversible however reversible `click` is in
general — see §4.

A new driver may register new actions into the taxonomy, which is versioned and
licensed Apache 2.0 so a third party can extend it without asking. **Macro is
the only composition mechanism**: there is no separate notion of a sub-script,
because a second way to group actions would be a second thing lineage has to
track.

## 3. What an Action Instance carries

| Field           | Content                                                                                                                                   | Required                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `definition`    | Reference to an Action Definition@version                                                                                                 | ✅                         |
| `intent`        | The semantic intent in natural language ("click the contact form's send button") — fuel for self-healing, and for whoever reads the audit | ✅                         |
| `target`        | A **semantic locator** (Driver & Perception §4)                                                                                           | ✅ where there is a target |
| `params`        | Parameters — text typed, keys, drag coordinates. A secret may only ever be a **credential handle**, never a value (Sandbox & Credential)  | ⬜                         |
| `reversibility` | `read` / `reversible` / `compensable` (+ a compensation reference) / `irreversible`. **Undeclared means irreversible** (RPA principle #3) | ✅ resolved by the cascade |
| `preconditions` | Assertions about the scene before the action runs — the ground resume and reconcile stand on                                              | ⬜                         |
| `evidence`      | Hashes of the scene snapshot before and after, structural and visual, already masked — written by the engine                              | ✅ automatic               |
| `actor`         | The identity of the person, agent or script that emitted it — **one schema for all three** (RPA principle #1)                             | ✅ automatic               |

## 4. Where a reversibility class comes from

```
declared at the instance → Macro → App Profile → vocabulary default → irreversible
```

An **App Profile** is a first-class entity with an id and a version, held in a
tenant's library and distributed through the Hub as a block of type
`app-profile`, with a community catalog under Apache/CC0. It carries knowledge
about one application: which element maps to which reversibility class, which
locators are stable, which flows are known. It is the counterpart of a template
on the platform side. Per-tenant learning feeds that tenant's own profile; the
community catalog exists so a common application — Salesforce, SAP GUI — does
not start cold for everyone independently.

Automatic inference may only **propose** into a profile, through a review round.
A vision model guessing that a "Delete" button is irreversible is a good guess
and still a guess, and the cost of it being wrong is paid once, irreversibly, by
whoever it was wrong about. Nothing decides a reversibility class at runtime.

## 5. The action log

The log is **append-only and content-addressed**: each entry is an instance plus
its evidence hash, timestamp and outcome. The log _is_ the provenance. Under
integration it projects directly into the **Session effect stream** (Handoff
§8), with no conversion step — one format, so there is no second place for the
two to disagree.

The **commit point** is the first irreversible entry that completed
successfully. Evidence is sufficient to replay the run as an audit (Session §6):
every step reviewable, like a video with structure. Secrets were masked at the
perception layer, so the log is clean at the source rather than redacted
afterwards (Sandbox & Credential §3) — a redaction pass is a second chance to
miss one.

## 6. Non-goals

- An Action does not know whether a script or an agent emitted it. It knows the
  actor's identity, which is the part an audit needs.
- An Action does not decide its own reversibility by runtime inference. It
  resolves the declaration chain in §4 and nothing else.

## 7. Decisions

| Question                  | Settled                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Unit of composition       | Macro only, with id and lineage; no sub-script                                        |
| Reversibility undeclared  | Read conservatively: treat it as irreversible                                         |
| Contextualising the class | An App Profile overrides the vocabulary; AI inference may only propose into a profile |
| Log ↔ platform            | The action log projects 1:1 into a Session effect — one format, no conversion         |
| Evidence                  | Before and after, mandatory, automatic, already masked                                |

## Litmus

1. An action that declares no reversibility at any link of §4's chain — is it
   treated as `irreversible`, both standalone and integrated?
2. A vision model guesses a button is irreversible. Is there any path by which
   that value reaches runtime without passing an App Profile review round?
3. Point at any entry in the action log: can a reader see _who or what acted,
   with what intent, and what the screen looked like before and after_ — and
   read no secret at all?
