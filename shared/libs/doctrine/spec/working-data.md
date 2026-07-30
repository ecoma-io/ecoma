---
title: "Working Data — DataTable, Lease & Labor Analytics"
status: design-end-state
---

# Working Data — DataTable, Lease & Labor Analytics

## 1. DataTable — a writable table with complete books

**The ground rule: SQL to ask, events to write.** Forbidding shared mutable state
is a law about the _write path_, not a limit on how rich the _read path_ may be.
Those get conflated constantly, and conflating them is what makes event-sourced
systems unpleasant to query.

| Aspect             | Mechanism                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is         | A table is a **writable projection of the Event Log**: every mutation — insert, update, delete, upsert — is an event with an actor identity, and the current table is a materialised view, **rebuildable from the log**                                                                                                                                                                             |
| Writing            | Only through the engine API. A write is an **internal effect of class `reversible`** by construction, since a compensating event always exists — which makes DataTable _safer_ than writing to an external database                                                                                                                                                                                 |
| Reading            | **Full SQL over a snapshot**: joins, aggregates, windows, views, as of a log position. A query's provenance is `(log position, query text, result hash)`, which is what makes a **time-travel join** possible                                                                                                                                                                                       |
| Concurrency        | **Optimistic by default**, on a row version: a conflict is a Violation, and `on_fail` retries with feedback. Where serialisation is genuinely needed, use a Lease (§3)                                                                                                                                                                                                                              |
| Rights and secrecy | Granted by **Role**; a table carries a **classification**; a join or aggregate inherits the maximum floor of every table it touched (floor propagation), so publishing figures drawn from a secret table passes a **leakage gate**. Static analysis checks that the tables touched are within the Role's grant; an agent generating SQL dynamically is a read-only Query task at the database layer |
| Schema             | **A table definition is an entity** with id, version and lineage. Adding an optional column is minor and resolves live, with **the version recorded into provenance** (the same reasoning as Knowledge §4); changing a type or dropping a column is major, and **migration is a Task of a Role with a Gate** — Contract's rule verbatim                                                             |
| Bulk import        | A **batch event** pointing at an artifact — a blob in content-addressed storage holding the rows. Replayable, fast, one trace. There is no raw `COPY` channel                                                                                                                                                                                                                                       |
| PII                | Rows are events, so **crypto-shredding is inherited unchanged** from Event Log §4                                                                                                                                                                                                                                                                                                                   |
| **The test label** | A write inside a **test run scope** carries `run_kind: test` (Event Log §1) and lands in a **projection split by label**. Production tables **do not see it**, and neither does a time-travel read as of a log position on a production table. The label's canonical home is Event Log §3                                                                                                           |
| Scope              | Operational working data — thousands to millions of rows on the default stack. Heavy OLAP goes out through export (§4)                                                                                                                                                                                                                                                                              |

## 2. Against the back door — not even the administrator is trusted

The deployment rule is that the database is **the engine's private property**;
external clients get a read-only role at most.

The mechanism that does not rely on the rule: a projection carries **a checksum
against its log position**. Editing by hand outside the engine causes **drift
detection → rebuild from the log → a warning event**. A quiet edit is overwritten,
with a record of it having happened.

## 3. Lease — the only locking primitive in the system

**There is no "lock", only a Lease**: (key, holder as a filler or task identity,
**a mandatory TTL**, heartbeat). The engine forces the TTL to exist, so an
infinite lock is _structurally_ impossible rather than merely discouraged. When
the TTL expires the lease releases, emits an event, and escalates by policy.
Provenance always knows _who is holding the key_.

| Rule                                              | Content                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A lease is not a task's lifetime                  | It wraps only the _critical section_ around an effect, and **may not contain an `awaiting` state** — static analysis checks this exactly as it checks the sync path. Someone holding a lock while they go on leave is impossible                                                                                                                                                 |
| Declared, not coded                               | `singleton: true` on a definition — one month-end close instance — is a lease on the definition key taken before spawning; a business mutex is a lease on a correlation key                                                                                                                                                                                                      |
| `serialization_key` (Handoff §8)                  | Mechanised as a **micro-lease the engine manages through a queue** — one primitive, several faces                                                                                                                                                                                                                                                                                |
| Deadlock                                          | Dissolves on TTL; static analysis warns about a chain acquiring several leases                                                                                                                                                                                                                                                                                                   |
| TTL expiring **after the holder wrote an effect** | The lease becomes `orphaned` and **is not granted automatically to the next waiter**; the terminal escalation decides — reassign, compensate or absorb. Consistent with the dead-node rule (RPA North Star §4): **no silent re-run after a commit point**. Losing a lock must never turn into a doubled effect. A TTL expiring _before_ any effect was written releases normally |
| Unbounded pessimistic locking                     | Forbidden — it violates invariant 5                                                                                                                                                                                                                                                                                                                                              |

## 4. Labor Analytics — own the specimen, do not build the microscope

**A structurally exclusive dataset**: the Event Log is a fact table of _hybrid
human-and-AI labour_ — cost and quality per Role, who approved what, the
human-to-AI shift, attention bottlenecks, process smells. No other system models
this, so no other system has the data.

**A metric or projection definition is an entity** with id, version and lineage,
which makes it a **block type on the Hub** as a matter of course: a
vertical-specific dashboard pack is sellable through the marketplace.

DataTable joins against labour data at the same log position: _"AI cost per
order"_ is the orders table joined with cost per task — a question neither a
workflow tool nor traditional BI can answer, because neither holds both halves.

**A BYO-export adapter** writes projections into an open table format for a
customer's own warehouse or BI — Power BI, Snowflake — with **egress by
classification applied unchanged to the export**. The position: _do not move your
warehouse to ecoma; give your warehouse data it has never had._

Lightweight in-product dashboards are a tier-3 surface reading a projection, not
engine.

## 5. The default stack

**Postgres with pgvector and TimescaleDB — one boring database carrying the whole
cluster**: the Event Log store, DataTable, Knowledge's vector index, and metric
time series. One database in a Docker compose file.

**Default is not coupling**: the engine speaks only through the subsystem and
adapter interfaces, so Postgres is the first adapter rather than an assumption.

**The SQL-read contract is suite-defined**: standard behaviour is defined by an
**executable conformance test suite**, with Postgres as the reference backend
generating the standard — not by a product name. A replacement backend, including
a Postgres-compatible one, that passes the suite conforms, and that is
machine-checkable rather than a matter of opinion.

**The default follows the deployment shape** (ADR-0002): a single binary or
single container uses SQLite for the write and log path, DuckDB for the query and
OLAP path, and sqlite-vec; a production compose, Helm or cloud deployment uses
Postgres with pgvector and Timescale. Growing from small to large is **replaying
the log into the new port** — with a threshold warning and migration as an
explicit Task, never automatically.

## 6. Litmus

1. Rebuild every table, the vector index and the metrics from the log plus
   content-addressed storage — is the result equivalent?
2. Can a **join** be time-travelled by log position?
3. Is a manual database edit outside the engine detected and rebuilt, with a
   record?
4. Does every write, including a bulk one, carry exactly one actor identity?
5. When a lease TTL expires, is there no scenario that deadlocks?
6. When a holder dies **after** a commit point, is there no path by which the
   lease is automatically regranted and produces a doubled effect?

## 7. Non-goals

- Not a general-purpose warehouse or OLAP engine, and no home-grown vector or ANN
  engine — that is an adapter (Knowledge §5).
- No raw write or DDL channel into the tables outside the engine API.
- No pessimistic lock without a TTL.
- Not a replacement for a customer application's own database. DataTable is the
  working data _of a process_.

## 8. Decisions

| Question                      | Settled                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legitimising mutability       | A table is a writable projection; a write is an event and a reversible effect — "no mutation off the books" holds unchanged                      |
| Joins                         | Full SQL reads over a snapshot; provenance is (log position, query, hash); floor propagation and a leakage gate for aggregates                   |
| Schema evolution              | A table definition is a versioned entity; major means migration-as-task with a Gate                                                              |
| Bulk                          | A batch event pointing at a content-addressed blob                                                                                               |
| The administrator's back door | Checksum drift detection, then a recorded rebuild                                                                                                |
| Locking                       | Lease only, TTL mandatory, no `awaiting` inside a critical section; singleton and mutex are declarations                                         |
| Losing a lock mid-effect      | `orphaned` rather than automatic regrant — a TTL expiring after a commit point never becomes a re-run                                            |
| Warehouse                     | Refuse to build the engine; Labor Analytics projections plus BYO export; a metric is a block type                                                |
| Defaults                      | By deployment shape (ADR-0002): small stack or Postgres; Postgres is the reference; the contract is suite-defined; default is not coupling       |
| **The test label**            | Projections split by `run_kind`; production tables do not see a test run's writes — a position declared here, with the label's home in Event Log |

## Failure modes

| Failure                                      | Detected by                                     | Recovery                                                             |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| A manual database edit outside the engine    | Checksum drift detection by log position        | Rebuild plus a recorded warning event                                |
| A write conflict (optimistic)                | Row version                                     | A Violation, then a retry carrying feedback                          |
| A lease holder dies before writing an effect | The TTL heartbeat lapses                        | Automatic release, an event, and escalation by policy                |
| A lease holder dies **after a commit point** | The TTL lapses and the log shows the effect ran | `orphaned` — no automatic regrant; the terminal escalation decides   |
| A batch blob is lost                         | `exists` fails in content-addressed storage     | The batch event does not apply and escalates — never a partial apply |
