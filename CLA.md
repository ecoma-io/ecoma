# Ecoma Contributor License Agreement

Before your first contribution is merged, we ask you to agree to these terms.
They are short, and this page says plainly why each part exists.

## Why a CLA at all

Ecoma is not licensed under a single licence. The code you contribute may end
up under any of four sets of terms, decided by where the file lives and not by
who wrote it:

- the Sustainable Use License, for the implementations that run the system;
- the Apache License 2.0, for the interfaces and schemas third parties build
  against;
- a commercial Enterprise License, for modules under an `enterprise`
  directory;
- proprietary terms, for the operator control plane.

[`LICENSE`](./LICENSE) is the source of truth for which path gets which terms.
A project that offers its code under more than one set of terms needs the
right to do so for every line in the tree — including yours. Without that
right, a single contribution can make a file impossible to license, and the
only remedies left are removing it or tracking down its author years later.

We ask for a licence, **not** for ownership. You keep the copyright in your
contribution and may use it however you like, including in other projects.

## The agreement

By submitting a contribution to this project, you agree that:

1. **You grant us a broad copyright licence.** You grant Ecoma a perpetual,
   worldwide, non-exclusive, royalty-free, irrevocable licence to reproduce,
   modify, prepare derivative works of, publicly display, sublicense and
   distribute your contribution and such derivative works, under any licence
   terms, including the four named above and any commercial terms.

2. **You grant us a patent licence.** You grant Ecoma and every recipient of
   the software a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable patent licence to make, have made, use, offer to sell, sell,
   import and otherwise transfer your contribution, covering only those patent
   claims you own or control that are necessarily infringed by your
   contribution alone or by its combination with the project.

3. **The work is yours to give.** Each contribution is your original work, or
   you have the right to submit it under these terms. If any part is not your
   original work, you have identified its source and its licence in the
   contribution itself.

4. **Your employer, if relevant, is on board.** If your employer has rights to
   work you create, you have permission to contribute on their behalf, or your
   employer has waived those rights for this project.

5. **No warranty is implied.** Your contribution is provided as is, without
   warranty of any kind, to the extent the law allows. Nothing here obliges us
   to use or merge it.

## How you agree

Add a `Signed-off-by` trailer to every commit, using the same name and email
address as your commit identity:

```bash
git commit -s -m "fix(core-ui): correct slider keyboard step"
```

The trailer means: _I have read `CLA.md` and I agree to it for this
contribution._

For a first-time contributor the trailer alone is not yet enough — a
maintainer will confirm the agreement on the pull request before merging. That
confirmation happens once, not per pull request.

## Questions

Ask on the pull request, or write to <john.itvn@gmail.com>. A question about
these terms never delays review; only an unanswered one does.
