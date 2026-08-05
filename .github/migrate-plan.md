# Bootstrapping this repository from nothing

A clone carries every gate in this tree and **none of its settings**. Delete the
repository and the settings are gone; recreate it and GitHub's defaults come
back, which are not these. This file is the procedure that closes that gap, and
`repository-settings.json` beside it is the machine-readable target it applies —
values live there, reasoning lives here, and neither restates the other.

Read it in order. Several steps are worthless or actively harmful out of
sequence, and each says so where that is true.

## Before anything: what "done" means

Every step below ends with a **verification command**, and the step is not done
until that command answers. Settings work is the one place where doing the thing
and believing you did it feel identical, because nothing fails — the button just
did not do what you assumed.

All commands use `gh api`; substitute `curl -H "Authorization: Bearer $TOKEN"`
against `https://api.github.com` if you have no `gh`. Reading a ruleset needs no
admin rights; writing one does.

---

## 1. Create the repository, and pick the plan deliberately

Public repository, so that rulesets, the merge queue, code scanning, secret
scanning and the OpenSSF Scorecard publish are all available. On a **private**
repository these need GitHub Pro or higher, and without it the default branch
carries no protection of any kind — see §9, which is not hypothetical.

```
gh api repos/ecoma-io/ecoma --jq '{visibility, default_branch}'
```

## 2. Push the tree before configuring anything

The ruleset in §5 requires a pull request for every change to the default
branch, with no bypass. Apply it to an empty repository and the first push is
refused, so the initial history has nowhere to land.

Push `main` first. Configure second. This ordering is the only reason §5 is not
step one.

## 3. Repository-level merge policy

```
gh api -X PATCH repos/ecoma-io/ecoma \
  -F allow_merge_commit=true -F allow_squash_merge=false \
  -F allow_rebase_merge=false -F delete_branch_on_merge=true \
  -F allow_auto_merge=true
```

Exactly one merge method stays enabled, so the strategy is a mechanism rather
than whichever button someone clicked. `repository-settings.json` holds the
argument for merge commits over the other two.

`delete_branch_on_merge` is safe **under merge commits and only under them**: a
merge commit's second parent puts the branch's commits on the default branch as
the _same objects_, so deleting the ref removes a pointer and no history. Under
rebase they are replayed as new objects reachable only through that ref — which
is how 88 stale branches once accumulated here.

```
gh api repos/ecoma-io/ecoma --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge, delete_branch_on_merge, allow_auto_merge}'
```

## 4. Security features

```
gh api -X PATCH repos/ecoma-io/ecoma \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

Dependabot alerts and code scanning are enabled from **Settings → Code security**.
Code scanning needs no setup wizard here: `codeql.yml` is committed and uploads
its own SARIF.

Do this before opening the repository to contributors. Push protection that
arrives after the first leaked credential has already failed at its only job.

## 5. The ruleset

Apply `repository-settings.json`'s `rulesets[0]` verbatim:

```
gh api -X POST repos/ecoma-io/ecoma/rulesets --input ruleset.json
```

Then read it back and diff it against the file. The API accepts and silently
normalises more than it documents.

```
gh api repos/ecoma-io/ecoma/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/ecoma-io/ecoma/rulesets/<id> --jq '.rules[].type'
```

The rule list must come back containing **all five**: `deletion`,
`non_fast_forward`, `pull_request`, `required_status_checks`, `merge_queue`.

### The two rules that look optional and are not

`deletion` and `non_fast_forward` are one line each and protect against the two
failures nothing else here can see. Without `deletion` the default branch can be
removed outright. Without `non_fast_forward` it can be force-pushed, which
rewrites landed history and invalidates every commit pinned off it — the merge
queue's would-be-trunk runs, and the git reference the private control-plane
workspace consumes this harness at.

They are also OpenSSF Scorecard's **Tier 1**, and Tier 1 is a hard gate: absent,
`Branch-Protection` scores **0** no matter how much of the rest is configured.
A repository with a merge queue, a required check and code-owner review still
publishes 0 while these two are missing. §8 has the full ladder.

## 6. The merge queue has a code dependency

**This is the trap that costs the most time, because it fails silently.**

The `merge_queue` rule makes a pull request queue instead of merging directly.
The queue builds a temporary ref — trunk plus the entries ahead of this one —
and waits for the required checks to report **on that ref**. If no workflow runs
there, nothing reports, and every entry waits out
`check_response_timeout_minutes` before being dropped as failed.

A queue that accepts pull requests and merges none, with no error anywhere
naming the reason.

So `.github/workflows/ci.yml` must list `merge_group` among its triggers. It
does; keep it. Removing that trigger while keeping this rule is the failure
mode — they change together or not at all.

```
gh api repos/ecoma-io/ecoma/actions/workflows/ci.yml/runs \
  --jq '[.workflow_runs[] | select(.event=="merge_group")] | length'
```

Merge one pull request and confirm that count is non-zero.

## 7. The GitHub App, for anything that must write to the default branch

`cla.yml` records a signature by committing it. The `pull_request` rule refuses
that, and **the fix everyone reaches for does not exist**: `github-actions[bot]`
cannot be added to a bypass list at all. It is not selectable in the ruleset UI
and no integration id is accepted over the API. GitHub keeps its own Actions
token non-bypassable on purpose, so that write access to a workflow file never
becomes write access past every rule. A bypass list takes repository roles,
teams, GitHub Apps and deploy keys; the Actions token is none of them.

Four steps, in order:

1. Install the organisation's GitHub App on this repository with `contents:
write`, `pull-requests: write`, `statuses: write` and `actions: write`. The
   workflow's own `permissions:` block is `contents: read` and deliberately
   cannot substitute for any of them.
2. Add the App to the ruleset's `bypass_actors`:
   `{ "actor_id": <app id>, "actor_type": "Integration", "bypass_mode": "always" }`
3. Generate a private key for the App.
4. Store the App's id and that key as the repository secrets `CLA_APP_ID` and
   `CLA_APP_PRIVATE_KEY`.

**Step 2 is the one that gets skipped silently.** The token mints fine without
it and only the commit is refused, so a green token step proves nothing. Verify
the entry exists:

```
gh api repos/ecoma-io/ecoma/rulesets/<id> --jq '.bypass_actors'
```

Until all four are done the CLA workflow fails its own guard with a named error
on every pull request. That is deliberate — the alternative is a signature flow
that appears installed and records nothing.

**This step has a cost, priced in §8**: Scorecard derives "branch protection
applies to administrators" from the bypass list being _empty_, so any bypass
actor caps `Branch-Protection` at **9**. The alternative that keeps 10 is the
CLA action's own `branch:` input pointing at a branch the ruleset does not cover
— its condition is `~DEFAULT_BRANCH` only, so every other branch is already
unprotected. The trade is where the signature record lives.

## 8. OpenSSF Scorecard — what each point actually costs

Scorecard reads **rulesets** with the plain `GITHUB_TOKEN` at v5.5.0. It does
**not** need a personal access token, and adding one buys nothing. Recorded here
because "the check must need admin rights" is the natural first guess and it is
wrong: the client queries rulesets first and deliberately swallows the classic
branch-protection permission error when a ruleset exists, precisely so
non-admins still get a score.

| Score  | What it takes                                                             |
| ------ | ------------------------------------------------------------------------- |
| **0**  | Tier 1 missing — the hard gate                                            |
| **4**  | `deletion` + `non_fast_forward` (§5). Free, no trade-offs                 |
| **8**  | `required_approving_review_count: 1` + `require_last_push_approval: true` |
| **9**  | `required_approving_review_count: 2`                                      |
| **10** | `dismiss_stale_reviews_on_push: true`, and an empty bypass list           |

**4 is the honest ceiling for a single maintainer.** GitHub forbids approving
your own pull request, so any count above 0 means nothing merges until a second
human exists. Adding yourself to `bypass_actors` to work around that scores the
points while enforcing nothing, and costs the Tier 5 admin point on the way —
config whose only effect is to look compliant. Do not.

Raising `require_last_push_approval` or `dismiss_stale_reviews_on_push` **alone**
also buys exactly zero, because their tiers sit behind the approval count.

## 9. If the repository must be private

Rulesets and classic branch protection both need GitHub Pro or higher on a
private repository. Below that, `GET /rulesets` answers _"Upgrade to GitHub Pro
or make this repository public to enable this feature"_ and the default branch
has **no protection at all** — force-pushable, deletable, no required checks.

The private control-plane workspace is in exactly this state. Nothing in a tree
can compensate: local hooks are per-machine, and a workflow cannot refuse a push
that already happened. Either the plan changes or the exposure is accepted
knowingly; there is no third option, and pretending otherwise is worse than the
gap.

## 10. Order of the whole thing

1. Create the repository (§1)
2. Push `main` (§2) — before any rule refuses the push
3. Merge policy (§3)
4. Security features (§4) — before contributors, not after
5. Ruleset (§5) — including the two Tier 1 rules
6. Merge one pull request and confirm a `merge_group` run exists (§6)
7. GitHub App: install, bypass entry, key, secrets (§7)
8. Read every setting back and diff against `repository-settings.json`

Then update `repository-settings.json`'s `notAppliedYet` block so it describes
the new repository rather than the old one. A stale entry there is worse than no
entry, because it reads as a known gap when it is really an unread one.
