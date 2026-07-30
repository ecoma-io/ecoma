# Ecoma Contributor License Agreement

**Version 1.0.** Before your first contribution is merged, we ask you to agree
to these terms. They are short, and this page says plainly why each part
exists.

In this document, **"Ecoma"** means John Martin, an individual, trading as
Ecoma, together with any legal entity he later forms to hold this project's
assets, and their respective successors and assigns. **"You"** means the person
agreeing to these terms.

A **contribution** is anything you deliberately send us for inclusion in the
project — code, tests, documentation, prose, designs, translations,
configuration — however you send it: a pull request, a patch, an issue, or a
message to a maintainer. It does not include feedback, bug reports or
suggestions that you do not intend us to include, and it does not include
anything you clearly mark "not a contribution".

## Why a CLA at all

Ecoma is not licensed under a single licence. The code you contribute may end
up under any of five sets of terms, decided by where the file lives and not by
who wrote it:

- the Sustainable Use License, for the implementations that run the system;
- the Apache License 2.0, for the interfaces and schemas third parties build
  against;
- a commercial Enterprise License, for modules under an `enterprise`
  directory;
- proprietary terms, for the operator control plane;
- Creative Commons Attribution-ShareAlike 4.0, for the documents under
  `shared/libs/doctrine/` — a copyleft licence, so a derivative of what you
  write there stays open, and attribution travels with it.

[`LICENSE`](./LICENSE) is the source of truth for which path gets which terms.
A project that offers its code under more than one set of terms needs the
right to do so for every line in the tree — including yours. Without that
right, a single contribution can make a file impossible to license, and the
only remedies left are removing it or tracking down its author years later.

We ask for a licence, **not** for ownership. You keep the copyright in your
contribution and may use it however you like, including in other projects. The
one thing a licence alone does not give us is standing to sue an infringer on
our own, which is what clause 6 is for.

## The agreement

By submitting a contribution to this project, you agree that:

1. **You grant us a broad copyright licence.** You grant Ecoma a perpetual,
   worldwide, non-exclusive, royalty-free, irrevocable, **transferable**
   licence, **sublicensable through multiple tiers**, to reproduce, modify,
   prepare derivative works of, publicly display, publicly perform, sublicense
   and distribute your contribution and such derivative works, under any
   licence terms, including the five named above and any commercial terms.

2. **You grant us a patent licence.** You grant Ecoma and every recipient of
   the software a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable patent licence to make, have made, use, offer to sell, sell,
   import and otherwise transfer your contribution, covering only those patent
   claims you own, control, or otherwise have the right to license that are
   necessarily infringed by your contribution alone or by its combination with
   the project.

   This patent licence terminates automatically, for any person or entity and
   all its affiliates, on the date that person or entity institutes patent
   litigation — including a cross-claim or counterclaim — against Ecoma or any
   recipient, alleging that the project or your contribution infringes a
   patent. Termination reaches only the licences this clause granted to that
   party; everyone else's are unaffected, and the copyright licence in clause 1
   stays in force. Without this paragraph, an aggressor who loses their patent
   licence under `LICENSE` would still hold an identical one from every
   contributor, and the project's patent defence would be worth nothing.

3. **The work is yours to give.** Each contribution is your own work, created
   by you for this project. You have not copied it from another project,
   another employer's codebase, or any source that carries its own licence
   terms.

4. **Code you did not write yourself is disclosed before review.** If any part
   of a contribution is not your own work — including code copied from another
   project, and including material an AI tool produced that reproduces
   identifiable third-party code — say so **in the pull request description,
   before review**, naming the source and its licence. We decide whether we can
   accept it. A comment in the code is not disclosure. Ordinary use of AI
   assistance to write original code needs no disclosure, but you remain
   responsible for clauses 1 to 5 in respect of the result.

5. **Your employer, if relevant, is on board.** If your employer has rights to
   work you create, you have permission to contribute on their behalf, or your
   employer has waived those rights for this project. If you are contributing
   as part of your job, or the contribution relates to your employer's
   business, ask us for a corporate agreement before we merge it.

6. **You will help us enforce, at our cost.** If we act against someone
   infringing the project, you agree — at our request and at our expense — to
   be joined as a party or to give reasonable assistance, so far as it concerns
   your contribution. You need not fund or run any action, and we will not
   settle in a way that admits fault on your part without asking you first.

7. **Tell us if something changes.** If you later learn that anything you said
   in clauses 3 to 5 was or has become inaccurate for a contribution you have
   already made, write to <john.itvn@gmail.com> as soon as you can.

8. **No warranty is implied.** Except for what you tell us in clauses 3 to 5,
   your contribution is provided as is, without warranty of any kind, to the
   extent the law allows. Nothing here obliges us to use or merge it, or to
   support it, and you are not expected to support it either.

## How you agree

Agreement is recorded once, per person, on your first pull request: a
maintainer confirms it there before merging, and that confirmation covers every
contribution you make afterwards. Clauses 3 to 5 are things you re-confirm each
time you open a pull request — the pull request template asks — because
employment and the origin of your work can change and the one-time record
cannot notice.

Separately, sign off each commit:

```bash
git commit -s
```

The `Signed-off-by` trailer carries its ordinary industry meaning — the
[Developer Certificate of Origin](https://developercertificate.org/) — and is
**not** how you agree to this document. We keep the two apart deliberately:
that trailer is what contributors type reflexively in every other repository,
so loading a commercial sublicensing grant onto it would mean nobody could tell
what anyone had actually agreed to.

## If these terms change

We may publish a new version. A new version applies only to contributions you
make after we ask you to agree to it and you do. Contributions you have already
made stay covered by the version you agreed to, and the licences you granted
under it stay in force — nothing here lets us take back or narrow a grant you
have already made, and nothing lets us widen one without asking you.

Commits made by automated tooling we run — dependency-update bots and the like
— are made on our own behalf and are not contributions under this agreement.

## Not yet settled

Two things a lawyer still has to decide, and we would rather say so than let
the silence read as a choice: this agreement names **no governing law**, and
there is **no separate corporate agreement** for employer-owned contributions
yet. If either matters to you, ask before you contribute.

## Questions

Ask on the pull request, or write to <john.itvn@gmail.com>. A question about
these terms never delays review; only an unanswered one does.
