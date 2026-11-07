---
title: 'From data to models: supervised learning and generalization'
description: 'Splits, leakage, inductive bias, and the question every experiment answers: does this work on data we never saw?'
date: '2026-09-19'
author: 'John Martin'
tags:
  - machine-learning
  - ai
featured: false
cover: ../../../assets/cover-06-supervised-learning-and-generalization.svg
coverAlt: 'Abstract scatter split motif on a light background beside the lesson title'
articleId: supervised-learning-and-generalization
seriesId: classical-machine-learning
seriesOrder: 1
contentType: theory
level: foundational
prerequisites:
  - probability-and-statistics-for-ml
  - linear-algebra-projections-and-rank
relatedArticleIds:
  - overfitting-regularization-bias-variance
  - embeddings-learned-geometry
---

# From data to models: supervised learning and generalization

A model that fits its training data perfectly has demonstrated something
narrow. Every supervised learning problem is really two problems wearing the
same coat: fitting the data you have, and being right about data you have never
seen. The second problem is the one you care about, and the two come apart more
often than beginners expect — sometimes by a little, sometimes by a factor of
hundreds, and in the small-sample corner of the space by enough to make a
perfectly reasonable model look broken.

This lesson sets up the vocabulary for that gap and the arithmetic that measures
it. After reading it you should be able to explain why a split is a claim about
what your model will face, identify leakage in a concrete pipeline, compute a
generalization gap, and read a learning curve well enough to tell overfitting
from underfitting from bad luck.

## The two risks, and why a single model carries both

Write the problem down precisely. Let $n$ samples be drawn i.i.d. from an unknown
data distribution $q$ over pairs $(\mathbf{x}, y)$. A **hypothesis class**
$\mathcal{H}$ is a set of candidate prediction rules $h_\theta$, parameterized by
$\theta$. The **population risk** is the expected loss on fresh data:

$$
R(\theta) = \mathbb{E}_{(\mathbf{x}, y) \sim q}\left[\ell(h_\theta(\mathbf{x}), y)\right]
$$

Two quantities matter. $R(\theta)$ is what you would score on infinite data and is
almost never computable, because $q$ is unknown. $\hat{R}(\theta)$, the
**empirical risk**, is the average of the loss over your $n$ samples and is
exactly computable. Training minimizes the empirical risk, usually to
interpolation. Everything interesting is the difference between how well the
minimizer of $\hat{R}$ approximates the minimizer of $R$:

$$
\underbrace{R(\hat{\theta}) - R(\theta^\star)}_{\text{excess risk}} = \underbrace{\min_{\theta} R(\theta)}_{\text{irreducible}} + \underbrace{\left[\min_{\theta} \hat{R}(\theta) - \min_{\theta} R(\theta)\right]}_{\text{estimation error}}
$$

The first term is noise in the world that no model can remove. The second is
everything you did wrong — a wrong function class, too few samples, too much
optimization. The whole of supervised learning is managing that second term.

Two failure modes sit at opposite ends. **Underfitting** is when the hypothesis
class cannot represent the pattern at all: $R(\hat\theta)$ stays high no matter
how much data you add. **Overfitting** is when the class is rich enough to fit
the noise, so $\hat{R}$ keeps falling while $R$ stops falling or rises. Neither
is visible from training loss alone, which is precisely why a held-out set is
not optional bookkeeping.

## Three splits, three different jobs

The reason a validation set exists at all is that the test set can only be spent
once. Draw the data and split it:

- **Training set** fits the parameters. Everything the optimizer touches comes
  from here, including the choice of hyperparameters, so it is consumed as
  training data no matter how it is labelled.
- **Validation set** selects among candidate models: the learning rate, the
  penalty strength, the number of layers, the prompt template. Its job is to
  estimate generalization for models you have not yet fixed.
- **Test set** estimates generalization once, at the end, for the one model you
  are shipping. It is read exactly once.

The rule that follows is worth stating as a law rather than a heuristic: **any
decision informed by the test set turns the test set into a validation set.** If
you try three prompt templates, run the benchmark, keep the best, and report the
best number, you have measured selection, not generalization. The reported figure
is optimistically biased by the maximum of three noisy draws, and the bias
survives into publication because nobody can see the discarded runs. This is not
a rare abuse; on a large benchmark it is the default outcome of ordinary
iterative work, which is why
[benchmark contamination and evaluation design](/en/blog/evaluating-language-models)
get their own lesson.

Preprocessing leakage is the subtlest and most common. Fitting a standardizer on
the union of train and test leaks test-set statistics into training — usually a
small effect, occasionally catastrophic when the test split differs in
distribution by design. The rule: every fitted quantity, including tokenizers,
vocabularies and imputation statistics, is fit on training data only and then
applied unchanged. For language models the analogous leak is a document that
appears in pretraining and again in your benchmark; the model has been trained on
the answer. That is [contamination](/en/blog/data-curation-quality-and-contamination),
measured by substring overlap against normalized web dumps, and unlike the splits
above it is not fixed by re-partitioning your own data.

## Splitting a time-ordered corpus

When the data has an order that carries meaning, the split must respect it. For a
corpus that arrives in sequence, splitting by document while interleaving is
usually wrong: later documents about the same event leak into training. A
contiguous split — first 80% train, next 10% validation, last 10% test — matches
deployment, where the future is genuinely unseen.

```python
import numpy as np

rng = np.random.default_rng(0)
n = 2000
day = np.repeat(np.arange(100), 20)                 # 100 days, 20 documents each
score = np.sin(day / 9.0) + 0.4 * rng.normal(0, 1, n)

random_idx = rng.permutation(n)
contiguous = np.arange(n)

def summarize(order, label):
    cut = int(0.8 * n)
    tr, te = order[:cut], order[cut:]
    print(
        f"{label:>12}  train days {day[tr].min():3d}-{day[tr].max():3d}"
        f"  test days {day[te].min():3d}-{day[te].max():3d}"
        f"  mean |day gap| {np.abs(day[te].mean() - day[tr].mean()):6.1f}"
    )

summarize(random_idx, "random")
summarize(contiguous, "contiguous")
```

gives

```text
      random  train days   0- 99  test days   0- 99  mean |day gap|    1.2
  contiguous  train days   0- 79  test days  80- 99  mean |day gap|   50.0
```

The random split trains on the test period. Whatever seasonal structure the score
carries is available at training time and unavailable at deployment, and the
offline metric measures a world that does not exist.

## Capacity, sample size, and the interpolation threshold

**Capacity** is the number of degrees of freedom a hypothesis has. A degree-$k$
polynomial has $k+1$; a network layer with $d_{in}$ inputs and $d_{out}$ outputs
has $d_{in} d_{out} + d_{out}$. The classical result, and the most useful single
intuition in this lesson, is that the relevant comparison is not absolute size but
the ratio of parameters to samples.

Take the noiseless limit first. With $p$ parameters and $n$ samples, $p > n$ leaves
the empirical risk with an interpolating solution — a $\theta$ that gets every
training point exactly right. The underdetermined system is solvable; least
squares returns the minimum-norm solution, and its predictions off the training
points are arbitrary, governed by whichever direction of the null space happens
to have the smallest singular value. Here is that measured, on 40 samples in 200
dimensions where the true weights are known:

```python
import numpy as np

n, d, reps = 40, 200, 15


def trial(lam, seed, normal_equations=False):
    """Ridge solution with penalty lam; lam = 0 is plain least squares.

    `normal_equations` picks the algebraically identical but numerically
    inferior form, solving (X'X + lam*I) w = X'y instead of using lstsq.
    """
    r = np.random.default_rng(seed)
    X = r.normal(0, 1, (n, d))
    w_true = r.normal(0, 1, (d, 1))
    y = X @ w_true                                  # noiseless target
    X_test = r.normal(0, 1, (1000, d))
    if lam > 0:
        w = np.linalg.solve(X.T @ X + lam * np.eye(d), X.T @ y)
    elif normal_equations:
        w = np.linalg.solve(X.T @ X, X.T @ y)
    else:
        w = np.linalg.lstsq(X, y, rcond=None)[0]
    return (
        float(np.mean((X @ w - y) ** 2)),
        float(np.mean((X_test @ w - X_test @ w_true) ** 2)),
        float(np.linalg.norm(w)),
    )


for normal_equations in (False, True):
    label = "normal equations" if normal_equations else "lstsq (min-norm)"
    print(f"\n{label}")
    print(f"n={n} samples, d={d} features, noiseless target, mean over {reps} draws")
    print(f"{'lambda':>9} {'train':>10} {'test':>10} {'||w||':>10}")
    for lam in (0.0, 1e-8, 1e-4, 0.01, 0.1, 1.0, 10.0, 100.0, 1000.0):
        res = [trial(lam, 100 * i + 1, normal_equations) for i in range(reps)]
        print(
            f"{lam:>9.4g} {np.mean([r[0] for r in res]):>10.4f} "
            f"{np.mean([r[1] for r in res]):>14.3f} {np.mean([r[2] for r in res]):>10.3f}"
        )
```

The two blocks are the same mathematics, and that is the point of printing both.
`lstsq` finds the minimum-norm least-squares solution directly and lands at a test
error of 162.627 with a weight norm of 6.350. Solving the normal equations
instead — multiplying the condition number by itself on the way to the answer —
reaches a test error of 13760200.214 and a weight norm of 1733.534, on the same
fifteen draws.

Look closely at where that failure sits, because it is the more useful lesson. It
appears in a single row: $\lambda = 0$ for the normal-equations path. Every other
cell agrees to three decimals, because $\lambda = 10^{-8}$ already regularizes the
Gram matrix past the point where the amplification bites. The two solves are not
one stable and one broken — they are the same answer whenever the arithmetic is
representable, and they diverge exactly when it is not. This is why "add a
token ridge penalty" fixes real training failures while doing nothing at all to
the mathematics, and why a penalty that is genuinely there (rather than one small
enough to vanish into rounding) is worth choosing deliberately.

The shape of that curve is the bias-variance trade-off in its purest form, and
[the next lesson](/en/blog/overfitting-regularization-bias-variance) derives the
decomposition behind it. Note what the penalty is doing: not restricting the
hypothesis class at all — ridge can still express any $\theta$ — but choosing a
_different point_ inside the set of interpolating solutions, the one with least
norm. **Regularization selects among solutions that fit the data equally well.**

## Capacity and sample size against each other

Back to the noiseless-plus-noise case, sweeping the model degree and the number
of samples independently. The target is $f(x) = \sin(3x)$ with Gaussian noise of
standard deviation $\sigma = 0.2$, so the achievable error floor is
$\sigma^2 = 0.0400$: no estimator, however good, can beat the noise in the data.

```python
import numpy as np

SIGMA = 0.2
TRIALS = 100


def sample(n, seed):
    """n points on the true curve sin(3x), each perturbed by noise of sd 0.2."""
    r = np.random.default_rng(seed)
    x = r.uniform(-1.0, 1.0, n)
    return x, np.sin(3.0 * x) + SIGMA * r.normal(0.0, 1.0, n)


def design(x, degree):
    """Vandermonde matrix: one row per sample, columns 1, x, x^2, ... x^degree."""
    return np.vander(x, degree + 1, increasing=True)


def fit(x, y, degree):
    """Empirical risk minimizer: least squares over the polynomial basis."""
    coef, *_ = np.linalg.lstsq(design(x, degree), y, rcond=None)
    return coef


def mse(x, y, coef):
    return float(np.mean((design(x, coef.size - 1) @ coef - y) ** 2))


x_test, y_test = sample(4000, 99)
print(f"noise variance sigma squared: {SIGMA ** 2:.6f}")

print("median test error over 100 independent training draws")
for degree in (1, 3, 5, 7):
    row = [f"degree {degree}"]
    for n in (10, 30, 100):
        errs = [mse(x_test, y_test, fit(*sample(n, s + 1000), degree)) for s in range(TRIALS)]
        row.append(f"n={n:3d}: {np.median(errs):9.4f}")
    print("  ".join(row))

print("average generalization gap (test minus train) for the same fits")
for degree in (1, 3, 5):
    gaps = []
    for s in range(TRIALS):
        x_tr, y_tr = sample(30, s + 1000)
        c = fit(x_tr, y_tr, degree)
        gaps.append(mse(x_test, y_test, c) - mse(x_tr, y_tr, c))
    print(f"degree {degree}: gap {np.mean(gaps):+.4f}")
```

| degree | $n = 10$ | $n = 30$ | $n = 100$ |
| ------ | -------- | -------- | --------- |
| 1      | 0.2357   | 0.2063   | 0.1990    |
| 3      | 0.0643   | 0.0467   | 0.0420    |
| 5      | 0.1668   | 0.0482   | 0.0403    |
| 7      | 21.2505  | 0.0569   | 0.0413    |

Three things are visible. The floor is real: degree 3 at $n = 100$ reaches
0.0420, just above 0.0400, and cannot go lower. The diagonal is the contour of
good choices — degree 1 always bad, degree 7 bad unless $n$ is large. And the
transition is sharp. Degree 7 at $n = 10$ has 8 parameters for 10 samples and a
median test error of 21.2505; at $n = 100$ it has the same 8 parameters and a
test error of 0.0413, near the floor. **Nothing about the model changed.** Only
the sample count did.

That is the capacity-versus-sample-size relationship as a measurement, and it
explains rules like "roughly ten examples per parameter." The constant is not ten
and it is not constant — it depends on the hypothesis class, the input dimension,
the noise level and the regularization. The _shape_ is stable: below the ratio,
more data helps enormously; above it, less and less.

The gap line measures the same thing from the other side. The average gap is
+0.0269 at degree 1, +0.0125 at degree 3 and +0.0218 at degree 5, all at $n = 30$ —
positive everywhere, meaning test error exceeds training error even where training
error is already below the noise floor. Fitting the noise better improves both at
once, which is why training error is nearly useless for model selection.

## Reading a learning curve

A **learning curve** plots training error against sample size, usually with a
second curve for validation or test error alongside. The shape is more
diagnostic than the final number.

| curve shape                       | diagnosis                      | fix                                     |
| --------------------------------- | ------------------------------ | --------------------------------------- |
| both high, close together         | underfitting                   | more capacity, better features          |
| both low, close together          | fit achieved                   | nothing; look for noise in the estimate |
| training low, validation high     | overfitting                    | more data, more regularization          |
| both falling, gap widening        | overfitting that data will fix | more data is the cheapest fix           |
| training noisy, validation smooth | small $n$, variance-dominated  | increase $n$ or average over folds      |

The last row is the one most often misread. When $n$ is small the validation
estimate is itself noisy: a single held-out set of 200 points has a standard
error on its mean loss that can exceed the difference between two candidate
models. The fix is not a better model but repeated splits — $k$-fold
cross-validation, rotating the held-out fold $k$ times and averaging, paying $k$
times the training cost for a variance reduction of roughly $k$ on the estimate
of the mean, not on the model.

Also worth internalizing: **the curve's asymptote is a property of the model
class, not of your training run.** If validation error flattens well above the
noise floor, the class cannot represent the target, and more data, more epochs or
a better learning rate will not help. That is the diagnostic value of the flat
part.

## Why empirical risk minimization is only a proxy

Training minimizes $\hat{R}$ because $\hat{R}$ is the only thing computable. It
is a proxy, and four things determine its quality, in rough order of importance.

**Sample size relative to capacity**, established above and quantified by
asymptotic results that bound generalization risk in terms of a Rademacher
complexity, which grows with the effective number of parameters and shrinks with
the sample size.

**Inductive bias** — the prior the hypothesis class encodes about what should be
close to what. A linear model on raw pixels assumes translation equivariance; it
is wrong for the data and pays for it. A convolutional network assumes nearby
pixels are related, which is why it is not merely smaller but _better_ on images.
That is the content of "appropriate inductive bias," and it is why architecture
search produces real gains: you are choosing which hypotheses are cheap a priori.

**Optimization, not just representation.** $\hat\theta$ is whatever the optimizer
returned, not the minimizer of $\hat{R}$. If it stops early or settles in a sharp
minimum, $\hat\theta$ has excess risk relative to $\arg\min \hat{R}$. The classic
implicit-bias result is that gradient descent on a linear model converges to the
minimum-norm interpolating solution — which is why weight decay is not decorative:
it selects a member of the interpolating set even when it is not in the objective.

**Distribution stability.** Every estimate above assumes the test distribution
equals the training distribution. When it does not, the decomposition still holds
but $q$ in the test term is a different $q$, and nothing in training was designed
for that. This is the one failure the learning curve cannot show you, and it is
why a held-out set drawn from a shifted population is not a small correction but a
different experiment.

The honest summary of a supervised experiment is therefore a triple — training
error, held-out error, and the size of the held-out set — not a single number.

## What this framework cannot tell you

The decomposition above is exact and the arithmetic is verified, but it is a
statement about a fixed data distribution and a fixed hypothesis class. It says
nothing about whether the class contains a model that is _useful_ rather than
merely accurate: two models with identical held-out MSE can differ enormously in
what they do on the cases that matter, which is the whole subject of
[evaluation](/en/blog/evaluating-language-models).

Nor does generalization imply robustness. A model can interpolate its training
set perfectly and be adversarially fragile, because adversarial examples are
off-distribution by construction and the interpolation argument says nothing
there. "It generalizes, therefore it is correct" is a non-sequitur:
generalization is a statement about the sampling distribution you had, not about
the world.

And this is the small-data regime. Modern pretraining sits far above the
interpolation threshold — a 175B-parameter model sees far more tokens than it has
parameters, and overfits through distribution idiosyncrasies rather than through
memorizing individual examples. What survives at that scale is not the arithmetic
above but the discipline: held-out data, a distribution assumption you can state,
and an honest account of how many decisions the evaluation saw.

## References

- Vladimir Vapnik, "The Nature of Statistical Learning Theory", Springer, 1995 —
  the uniform-convergence account of generalization and the capacity/sample-size
  relationship.
- Gilles Blanchard, Olivier Bousquet and Pascal Massart, "Statistical Performance of
  Support Vector Machines", The Annals of Statistics 36(2), 2008, pp. 489–531
  — a Rademacher-complexity bound whose radius term grows with the effective
  number of parameters and shrinks with the sample size.
- Leo Breiman, "Statistical Modeling: The Two Cultures", Statistical Science, 2001
  — the argument that predictive accuracy and explanatory modeling are distinct
  goals.
- NumPy documentation,
  [`numpy.linalg.lstsq`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.lstsq.html) —
  the minimum-norm least-squares solution used throughout the examples above.
