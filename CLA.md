# Ecoma Contributor License Agreement

**Version 1.0, effective 2026-08-03.**

Before your first contribution is merged, we ask you to agree to these terms.
This page says plainly why each part exists.

## Who and what this is about

**"Ecoma"** means Mai Ngọc Hóa, an individual also known as John Martin, of
Vietnam, together with any legal entity they later form to hold this project's
assets, and their respective successors and assigns. The two names are the same
person: Mai Ngọc Hóa is the name on the identity documents, John Martin is the
name used in this project's commit history, `package.json` and GitHub account.
The grant runs to the legal person, because a name that is not one cannot hold
a licence, transfer it to a company later, or prove standing to enforce it.

**"You"** means the person agreeing to these terms.

**"The project"** means the Ecoma repository published at
`https://github.com/ecoma-io/ecoma`, in any version, and any work Ecoma
distributes or makes available that incorporates a contribution. It does not
include software Ecoma has never published or made available.

A **contribution** is anything you deliberately send us for inclusion in the
project — code, tests, documentation, prose, designs, translations,
configuration — however you send it: a pull request, a patch, an issue, or a
message to a maintainer. It does not include feedback, bug reports or
suggestions that you do not intend us to include, and it does not include
anything you clearly mark "not a contribution".

Commits made by automated tooling we run — dependency-update bots and the like
— are made on our own behalf and are not contributions under this agreement.
**A tool _you_ run is a different thing.** Where you direct an AI or a coding
agent, the work it produces for you is your contribution and this agreement
applies to it in full, whichever account opens the pull request. An account that
is not a person cannot agree to anything, so it never carries a grant for the
person behind it; clause 5 is how that work is disclosed.

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

[`LICENSE`](./LICENSE) is the source of truth for which path gets which track.
One of the five licence sets is still in progress: the proprietary terms for
the operator control plane have not been published. Clause 1 is what would let
us place your contribution under them, and we say so plainly rather than
implying `LICENSE` already states them. Ask before you contribute if that
matters.

A project that offers its code under more than one set of terms needs the
right to do so for every line in the tree — including yours. Without that
right, a single contribution can make a file impossible to license, and the
only remedies left are removing it or tracking down its author years later.

We ask for a licence, **not** for ownership. You keep the copyright in your
contribution and may use it however you like, including in other projects.

## The agreement

Once you have agreed as described under "How you agree" below, the following
apply to every contribution you make, before or after that agreement:

1. **You grant us a broad copyright licence.** You grant Ecoma a perpetual,
   worldwide, royalty-free, irrevocable, **transferable** licence,
   **sublicensable through multiple tiers**, to reproduce, modify, prepare
   derivative works of, publicly display, publicly perform, sublicense and
   distribute your contribution and such derivative works, under any licence
   terms, including the five named above and any commercial terms.

   This licence is **exclusive** as to one thing only: the right to bring and
   conduct proceedings against a person infringing your contribution as part of
   the project, so that we can act without you. It is non-exclusive as to
   everything else — you keep the copyright and may use your contribution
   however you like. This is a licence, not a joint authorship agreement:
   nothing in this clause makes Ecoma or any recipient a joint author of your
   contribution under any law.

2. **You grant us a patent licence.** You grant Ecoma and every recipient of
   the project a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable, transferable patent licence to make, have made, use, offer to
   sell, sell, import and otherwise transfer your contribution, covering only
   those patent claims you own, control, or otherwise have the right to license
   that are necessarily infringed by your contribution alone or by its
   combination with the project.

   This patent licence terminates automatically, for a person or entity and all
   its affiliates, on the date that person or entity institutes patent
   litigation — including a cross-claim or counterclaim — **or sends a written
   notice asserting**, in either case against Ecoma or any recipient, that the
   project or your contribution infringes a patent. Termination reaches only
   the licences this clause granted to that person or entity and its
   affiliates; everyone else's are unaffected, and the copyright licence in
   clause 1 stays in force. This trigger is deliberately the same as the one in
   `LICENSE`: if the two differed, an aggressor who lost their patent licence
   under `LICENSE` would still hold an identical one from every contributor,
   and the project's patent defence would be worth nothing.

3. **Moral rights, and how we handle them.** The law of some countries,
   including Vietnam, gives an author personal rights (`quyền nhân thân`) that
   cannot be transferred or given up — in particular the right to be named when
   the work is used, and the right to object to modifications that harm the
   author's honour or reputation. This agreement does not take those rights
   from you, and could not. What you do agree is this:

   1. You consent in advance to our modifying, rewriting, translating,
      refactoring, combining and building on your contribution, repeatedly and
      over time, and you agree that modification of that ordinary kind does not
      of itself harm your honour or reputation.
   2. You agree that naming you in [`CONTRIBUTORS.md`](./CONTRIBUTORS.md), and
      preserving your authorship in the project's commit history, is a
      sufficient way of naming you as an author for every use we make of your
      contribution — including in a compiled or hosted product where naming
      each contributor in the product itself is not practical.
   3. So far as the applicable law allows you to agree not to exercise a
      personal right, you agree not to assert one against us, or against anyone
      we license, on any ground this clause covers.
   4. Nothing in this clause applies where we present your contribution as the
      work of someone else, or where a modification is made specifically to
      damage your reputation.

4. **The work is yours to give.** Except to the extent you disclose otherwise
   under clause 5, and to the best of your knowledge: you wrote each
   contribution yourself, for this project, and **you own the rights you are
   granting us, or you have permission from whoever does**. You have not copied
   it from another project, another employer's codebase, or any source that
   carries its own licence terms. Work you created yourself for another project
   of your own is your own work; work carrying someone else's licence terms is
   not, and belongs in clause 5.

   You represent and warrant that you are not located in, under the control of,
   or a national or resident of any country subject to comprehensive sanctions
   by the United Nations, the United States, the European Union, or Vietnam,
   and that you are not listed on any denied-persons or sanctioned-parties list.
   You represent and warrant that your contribution does not contain encryption
   or other technology subject to export controls that would require a licence
   for its contribution to this project.

   If you later assert, or if a third party successfully asserts, that you did
   not have the right to grant the licences in clauses 1 and 2 for a
   contribution already merged, you agree to reimburse us, **so far as permitted
   by applicable law**, for the reasonable costs of removing, replacing or
   defending that contribution, including legal fees. This does not apply to
   material you properly disclosed under clause 5, nor to a third-party claim
   that you had no reason to know of when you made the contribution.

   Note that in some countries — Vietnam among them — an employer owns the
   economic rights in software an employee writes as part of their job,
   **automatically and without any separate agreement**. If you are employed as
   a developer and your contribution relates to the work you are employed to
   do, assume your employer owns it and read clause 6 before you open the pull
   request.

5. **Code you did not write yourself is disclosed before review.** If, to the
   best of your knowledge, any part of a contribution is not your own work —
   including code copied from another project, and including material an AI
   tool produced (whether or not it reproduces identifiable third-party code) —
   say so **in the pull request description, before review**, naming the source
   and its licence.

   **Disclose AI use in the commit itself**, with a trailer naming the tool:
   `Assisted-by: <tool>` where you wrote the work with its help, or
   `Generated-by: <tool>` where the tool produced substantially the whole of a
   commit. Explain the extent in the pull request description as well, where it
   is worth explaining. The trailer is the disclosure that has to be there,
   because a pull request description can be edited afterwards and is not part
   of what a clone of this project carries, while the law governing this
   agreement expects whoever claims authorship to be able to show that their
   own contribution to the work was substantial and decisive.

   We may reject contributions whose provenance we cannot verify or whose
   copyright status is unclear. Where no person's contribution was substantial
   and decisive, no copyright arises in the material at all, so there is no
   right for you to grant us and nothing for us to license on: code generated
   from a prompt and taken as it came is the clearest case.

   If your contribution includes or depends on third-party code under a
   copyleft licence (including the GNU General Public License, GNU Affero
   General Public License, GNU Lesser General Public License, Mozilla Public
   License or Server Side Public License), you must disclose that fact and the
   applicable licence terms before review. We may reject contributions that
   would change the licensing of the project as a whole.

   A comment in the code is not disclosure — a trailer is where a reader of the
   history will look, and it is what travels with the commit. You do not warrant
   anything about material you have properly disclosed to us.

   You may not use the project's source code to train, fine-tune or otherwise
   improve an artificial intelligence or machine learning model whose output
   competes with the project or reproduces its functionality. Nor may you
   extract, mine or systematically collect data from the project's public
   outputs (issues, pull requests, commits) for the purpose of building a
   competing product. For the meaning of "competes with" and "reproduces its
   functionality", see the definition in [`LICENSE`](./LICENSE).

6. **Your employer, if relevant, is on board.** If your employer has rights to
   work you create, you have permission to contribute on their behalf, or your
   employer has waived those rights for this project. If you are contributing
   as part of your job, or the contribution relates to your employer's
   business, tell us before we merge. We will either take a short written
   confirmation from someone authorised at your employer, or ask you to wait
   for our corporate agreement. Do not assume silence is permission.

7. **You will help us enforce, at our cost.** A non-exclusive licence alone
   would not let us act against an infringer without you, because the copyright
   stays yours; clause 1's exclusive enforcement right addresses that, and this
   clause covers what a right of action cannot — your help with evidence. If we
   act against someone infringing the project, you agree, at our request and at
   our expense, to give reasonable assistance so far as it concerns your
   contribution, including confirming authorship and providing records. If the
   law of the forum requires you to be joined as a party for the action to
   proceed, you agree not to withhold consent unreasonably, and we will pay
   your reasonable legal costs, including any costs order made against you. You
   need not fund or run any action, and we will not settle in a way that admits
   fault on your part without your prior written agreement.

8. **Tell us if something changes.** If you later learn that anything you said
   in clauses 4 to 6 was or has become inaccurate for a contribution you have
   already made, write to <john.itvn@gmail.com> as soon as you can.

9. **No warranty is implied.** Except for what you tell us in clauses 4 to 6 —
   and disregarding anything you disclosed to us under clause 5, which you do
   not warrant — your contribution is provided as is, without warranty of any
   kind, to the extent the law allows. Nothing here obliges us to use or merge
   it, or to support it, and you are not expected to support it either.

10. **You represent that you are at least 18 years of age.** If you are under
    18, your parent or legal guardian must read and agree to this agreement on
    your behalf before you make a contribution, and you confirm that they have
    done so.

## The small print

**Price.** The licences in clauses 1 and 2 are granted free of charge. Neither
party owes the other any payment for them, and neither expects any. The parties
record this as the price term.

**Liability for breach.** A party in breach of this agreement is liable to the
other for the loss that breach causes, as the applicable law provides.

**Governing law.** This agreement is governed by the laws of the Socialist
Republic of Vietnam. Any dispute arising out of it is subject to the exclusive
jurisdiction of the competent courts of Vietnam. Where the mandatory law of
your own country of residence gives you rights this clause cannot displace, it
does not displace them.

## Your personal data

To run this project we process a small amount of your personal data: the name
and email address in your commits, your GitHub account name, and the details in
your contributor record. We do this to establish who granted us the licences in
this agreement, to satisfy the writing and identification requirements that
copyright law imposes on a licence contract, and to credit you as an author.

This data is **published**: it is part of the public commit history of a public
repository, it is copied by everyone who clones the project, and **it cannot be
removed once published**. The repository is hosted by GitHub, Inc. in the
United States, and email to us is handled by Google LLC — so your data is
transferred outside Vietnam. We keep it for as long as the project exists,
because it is the record of who licensed what to us.

**Right to erasure limitation:** Because your personal data is published in the
commit history of a public Git repository, the right to erasure under Article 17
GDPR (and analogous rights in other jurisdictions) cannot be fully exercised —
the data is replicated in every clone and fork, and Ecoma cannot delete it from
copies it does not control. By agreeing to these terms you acknowledge this
limitation.

By agreeing to these terms you consent to that processing, publication and
transfer. If you would rather not, do not contribute — we would rather you
asked us first than found out afterwards. Questions, or a request about your
data: <john.itvn@gmail.com>.

## How you agree

You agree to these terms **once**, on your first pull request, by committing a
contributor record at `contributors/<your-github-handle>.md` containing:

```
Full legal name:
Address:
Email:
GitHub:
Country of residence:

I agree to the Ecoma Contributor License Agreement, version 1.0, at CLA.md,
for this and every future contribution I make to this project.
```

Sign that commit off (`git commit -s`). A maintainer confirms the record before
merging. "Confirms" means a maintainer explicitly approves the record by
merging it, or by commenting on the pull request stating that the record is
complete and accepted. A silent merge without review is not confirmation. **Nothing in this agreement takes effect, and no licence is granted
under it, until that record exists.** If you send us material without agreeing,
we will ask you to agree before we use it, and will discard it if you decline.

The record carries your name and address because copyright law in Vietnam — the
law that governs this agreement — requires a licence contract to identify both
parties. It is not bureaucracy for its own sake, and it is the difference
between having a grant and being able to prove one.

That agreement covers every contribution you make afterwards. Clauses 4 to 6
are things you re-confirm each time you open a pull request — the pull request
template asks — because employment and the origin of your work can change, and
a one-time record cannot notice.

Separately, sign off each commit. The `Signed-off-by` trailer carries its
ordinary industry meaning — the
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

## The other agreements, and where they stand

- The **corporate agreement** ([`CORPORATE-CLA.md`](./CORPORATE-CLA.md)) is
  **in force** — version 1.0, effective 2026-07-31, offered to companies whose
  employees contribute on their employer's behalf. Clause 6 now routes
  employer-owned contributions to this agreement.
- The **Enterprise License** ([`ENTERPRISE-LICENSE.md`](./ENTERPRISE-LICENSE.md))
  is **in force** — version 1.0, effective 2026-08-03, for the modules under an
  `enterprise/` directory.
- The **proprietary terms** for the operator control plane (`cloud/`) have not
  been published.

## Questions

Ask on the pull request, or write to <john.itvn@gmail.com>. A question about
these terms never delays review; only an unanswered one does.
