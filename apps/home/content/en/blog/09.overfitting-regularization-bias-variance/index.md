---
title: 'Overfitting, regularization, and the bias-variance trade-off'
description: 'Why a model that memorizes the training set can still be useless, and which regularizer to reach for.'
date: '2026-09-22'
author: 'John Martin'
tags:
  - machine-learning
  - ai
featured: false
cover: ../../../assets/cover-09-overfitting-regularization-bias-variance.svg
coverAlt: 'Abstract fit curves motif on a light background beside the lesson title'
articleId: overfitting-regularization-bias-variance
seriesId: classical-machine-learning
seriesOrder: 4
contentType: theory
level: intermediate
prerequisites:
  - supervised-learning-and-generalization
  - gradient-descent-and-backpropagation
relatedArticleIds:
  - data-curation-quality-and-contamination
  - evaluating-language-models
---

# Overfitting, regularization, and the bias-variance trade-off

There is a specific kind of failure that punishes the most conscientious practice.
Train until the training loss reaches zero, as you should, and you have a model
that reproduces the training set perfectly and is worse on new data than a cruder
one you abandoned halfway. The training set was not the point. Every property you
measured on it is a property of the training set.

This is not a quirk of neural networks or of small data. It is arithmetic, and the
arithmetic is three lines long. What follows derives the decomposition that makes
it predictable, measures each regularizer's effect on real numbers, and then gives
the honest counter-case: the picture is incomplete, and a phenomenon called double
descent means the trade-off curve is not monotone.

After reading it you should be able to derive the decomposition from the definition
of expected squared error, tell a bias problem from a variance problem from a noise
problem using the learning curve alone, and state what regularization can and
cannot fix.

## The decomposition, derived

Let $y = f(\mathbf{x}) + \epsilon$ with $f$ the true regression function and
$\epsilon$ independent, mean-zero noise with variance $\sigma^2$. Let $\hat{f}$
be a predictor. The expected squared error at $\mathbf{x}$ splits exactly:

$$
\mathbb{E}\left[(y - \hat{f}(\mathbf{x}))^2\right]
= \mathbb{E}\left[(f(\mathbf{x}) + \epsilon - \hat{f}(\mathbf{x}))^2\right]
$$

Expand the square and use $\mathbb{E}[\epsilon] = 0$:

$$
= \mathbb{E}\left[(f(\mathbf{x}) - \hat{f}(\mathbf{x}))^2\right] + \mathbb{E}[\epsilon^2]
= \left(f(\mathbf{x}) - \mathbb{E}[\hat{f}(\mathbf{x})]\right)^2
+ \mathbb{V}[\hat{f}(\mathbf{x})] + \sigma^2
$$

Three terms, no terms dropped:

| term                        | name             | what it is                                                  | what reduces it                                     |
| --------------------------- | ---------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| $(f - \mathbb{E}\hat{f})^2$ | **bias squared** | the average prediction being systematically wrong           | a more expressive model                             |
| $\mathbb{V}[\hat{f}]$       | **variance**     | how much the prediction moves when the training set changes | more data, more regularization                      |
| $\sigma^2$                  | **irreducible**  | the noise in the target                                     | nothing — it is not error, it is the signal's floor |

The crucial move is the third line: $(f - \hat{f})^2$ splits into
$(f - \mathbb{E}\hat{f})^2 + \mathbb{V}[\hat{f}]$ because the bias and the
prediction are uncorrelated, $\mathbb{E}[(f - \hat{f})\epsilon] = 0$ since $\hat{f}$
depends only on the training data and $\epsilon$ is fresh. Drop that condition and
the decomposition gains a cross-term.

The consequence is worth stating carefully. Bias is about the _class_, variance is
about the _particular sample_. Adding capacity lowers bias and raises variance;
adding data lowers variance and leaves bias alone. A regularizer moves along the
curve by constraining the estimator's sensitivity to its training set — it adds no
information, and it cannot.

Averaging over a distribution of inputs gives the population risk as the sum of the
three terms, and each is then estimable from an ensemble of fits: fit the same
model to 200 independent training sets and measure the spread of predictions.

```python
import numpy as np

M = 200
NOISE = 0.5
f = lambda u: np.sin(1.5 * u)


def design(x, d):
    """Polynomial basis of degree d: one row per sample, columns 1, x, ... x^d."""
    return np.vander(x, d + 1, increasing=True)


test_x = np.linspace(-3, 3, 400)
f_test = f(test_x)

print("bias-variance terms, averaged over an ensemble of fits")
print(f"{'degree':>7} {'total':>9} {'bias^2':>9} {'variance':>9} {'noise':>8}")
for deg in (1, 3, 5, 9):
    preds = []
    for m in range(M):
        r = np.random.default_rng(1000 + m)
        x = r.uniform(-3, 3, 30)
        y = f(x) + NOISE * r.normal(0, 1, 30)
        coef, *_ = np.linalg.lstsq(design(x, deg), y, rcond=None)
        preds.append(design(test_x, deg) @ coef)
    preds = np.array(preds)
    bias2 = float(np.mean((preds.mean(axis=0) - f_test) ** 2))
    var = float(np.mean(preds.var(axis=0)))
    print(f"{deg:>7} {bias2 + var + NOISE ** 2:>9.4f} {bias2:>9.4f} {var:>9.4f} {NOISE ** 2:>8.4f}")
```

| degree | total   | bias²  | variance | noise  |
| ------ | ------- | ------ | -------- | ------ |
| 1      | 0.7815  | 0.4791 | 0.0525   | 0.2500 |
| 3      | 0.3862  | 0.0698 | 0.0664   | 0.2500 |
| 5      | 0.4349  | 0.0021 | 0.1828   | 0.2500 |
| 9      | 39.5910 | 0.1873 | 39.1536  | 0.2500 |

The columns tell the whole story. Noise is fixed at 0.2500 — no estimator can beat
it. Bias falls monotonically with capacity, from 0.4791 to 0.0021 at degree 5,
where the polynomial can represent $\sin(1.5x)$ essentially exactly, and variance
does the opposite, from 0.0525 to 39.1536. The minimum total is at degree 3, where
neither term dominates. **Degree 5 has the lowest bias and a worse score than
degree 3** — being right on average is worth nothing if individual predictions
swing wildly. Note also that degree 9's bias rises again, from 0.0021 to 0.1873:
past some point the extra freedom is spent fitting noise, which drags the average
prediction off the truth.

## Telling the three problems apart

The decomposition is useful only if you can identify which term dominates from a
learning curve and a training log.

| symptom                                                              | dominant term     | why                                | what actually helps                            |
| -------------------------------------------------------------------- | ----------------- | ---------------------------------- | ---------------------------------------------- |
| train and validation errors both high, converged                     | bias              | class cannot represent the pattern | bigger class, better features, less decay      |
| train error low, validation high and rising                          | variance          | memorizing sample-specific noise   | more data, more regularization, early stopping |
| both errors near $\sigma^2$, gap small                               | neither           | fitted as well as this data allows | stop; measure uncertainty instead              |
| train error approaching 0 with validation worse than a simpler model | variance, extreme | exact interpolation                | you already know the answer                    |
| validation error above the noise floor that no capacity helps        | bias              | wrong hypothesis class             | change the architecture, not $\lambda$         |

Two diagnosis rules that are easy to get wrong. **A low training error is not
evidence of a good model** — it is only evidence that the optimizer found the data.
And **a growing gap is not always overfitting that more data will fix**: if
validation error is flat while training error falls, the extra capacity is being
spent on noise that more data of the same kind will not remove.

One distinction worth keeping separate: **overfitting to the training set** and
**contamination** are different. A model that memorizes its training set is
overfitting. A model that has seen the benchmark is contaminated, and no amount of
training-set discipline helps — see
[data curation](/en/blog/data-curation-quality-and-contamination).

## What each regularizer actually changes

All five mechanisms aim at the variance term, and none of them adds information.

**L2 regularization / weight decay** adds $\frac{\lambda}{2}\|\theta\|_2^2$ to the
objective, so the gradient gains $\lambda\theta$ and weights are pulled toward zero
each step. Its statistical meaning is that among solutions fitting the data equally
well, it selects the smallest-norm one. It shrinks smoothly, affects all
directions, and is the default for transformers. **L1** adds $\lambda\|\theta\|_1$
instead; the subgradient is $\lambda\,\text{sign}(\theta)$, a constant push toward
zero with no preference for small over large, so it drives coordinates to exactly
zero and is used for genuine feature selection.

**Dropout** (Srivastava et al., 2014) trains each unit on a random subset of each
batch and rescales at inference. It is not a penalty on the objective at all — it
is an ensemble approximated by weight sharing, since averaging over the binary
masks is what the expected prediction would be. Its variance term is the noise
added to each training example, which is why it regularizes and does not merely
shrink.

**Early stopping** is regularization along the training trajectory: stop before the
optimizer finds the sharp minimum, and keep the flatter solution. It is the
cheapest regularizer available and costs nothing at inference.

**Data augmentation** adds training points by transforming inputs, raising $n$
without collecting anything, which is why it targets variance directly.

**Batch normalization** and dropout on residual branches are noise sources too, and
modern pre-normalized transformer blocks mostly rely on the architecture plus
weight decay.

Measured on a small tanh network, 20 training samples, noise floor 0.0900, and
everything but the capacity held fixed:

```python
NOISE = 0.3
FLOOR = NOISE ** 2
rng = np.random.default_rng(2)
x_tr = rng.uniform(-1, 1, 20)
y_tr = np.sin(4 * x_tr) + NOISE * rng.normal(0, 1, 20)
x_va = rng.uniform(-1, 1, 20)
y_va = np.sin(4 * x_va) + np.random.default_rng(3).normal(0, 1, 20)
xb, yb = x_tr.reshape(-1, 1), y_tr.reshape(-1, 1)
xv = x_va.reshape(-1, 1)
x_te = np.linspace(-1, 1, 400)
y_te = np.sin(4 * x_te)


def init(width, seed=0):
    r = np.random.default_rng(seed)
    return [r.normal(0, 0.5, (1, width)), r.normal(0, 0.5, (1, width)),
            r.normal(0, 0.5 / np.sqrt(width), (width, 1)), np.zeros((1, 1))]


def step(p, X, Y, lr, decay=0.0):
    """One full-batch step of gradient descent with an optional L2 term."""
    a = np.tanh(X @ p[0] + p[1])
    d2 = 2 * (a @ p[2] + p[3] - Y) / len(X)
    g = (1 - a ** 2) * (d2 @ p[2].T)
    grads = [X.T @ g, g.sum(0, keepdims=True), a.T @ d2, d2.sum(0, keepdims=True)]
    if decay:
        grads[0] += decay * p[0]
        grads[2] += decay * p[2]
    return [q - lr * gi for q, gi in zip(p, grads)]


def mse_on(p, X, y):
    pred = (np.tanh(X @ p[0] + p[1]) @ p[2] + p[3]).ravel()
    return float(np.mean((pred - y) ** 2))


print(f"n_train = 20, noise floor sigma squared = {FLOOR:.4f}")
print("L2 penalty at width 32; the val column is what lambda is chosen on")
print(f"{'lambda':>8} {'train':>9} {'val':>9} {'test':>9} {'gap':>9}")
for lam in (0.0, 0.001, 0.01, 0.1, 1.0):
    p = init(32)
    for _ in range(6000):
        p = step(p, xb, yb, 0.02, decay=lam)
    tr, va, te = mse_on(p, xb, y_tr), mse_on(p, xv, y_va), mse_on(p, x_te.reshape(-1, 1), y_te)
    print(f"{lam:>8.3f} {tr:>9.5f} {va:>9.5f} {te:>9.5f} {tr - te:>+9.5f}")

print("early stopping on the same problem, width 64")
print(f"{'steps':>7} {'train':>9} {'val':>9} {'test':>9}")
best = (0, float("inf"))
for n_steps in (50, 100, 200, 400, 800, 1600, 3200):
    p = init(64)
    for _ in range(n_steps):
        p = step(p, xb, yb, 0.002)
    va = mse_on(p, xv, y_va)
    print(f"{n_steps:>7} {mse_on(p, xb, y_tr):>9.5f} {va:>9.5f} "
          f"{mse_on(p, x_te.reshape(-1, 1), y_te):>9.5f}")
    if va < best[1]:
        best = (n_steps, va)
print(f"validation picks {best[0]} steps")

print("augmentation by sign flip, width 128; sin is odd, so f(-x) = -f(x)")
x_aug = np.concatenate([x_tr, -x_tr])
y_aug = np.concatenate([y_tr, -y_tr])
for label, X, Y in (("no augmentation", x_tr, y_tr), ("sign-flipped pairs", x_aug, y_aug)):
    Xs, Ys = X.reshape(-1, 1), Y.reshape(-1, 1)
    p = init(128)
    for _ in range(6000):
        p = step(p, Xs, Ys, 0.02)
    print(f"{label:>19} train {mse_on(p, Xs, Y):.5f} "
          f"test {mse_on(p, x_te.reshape(-1, 1), y_te):.5f}")
```

The $\lambda$ table is the trade-off in miniature, and it shows the honest limit
too. Raising $\lambda$ from 0 to 1 raises validation error from 0.0179 to 0.0542:
the penalty is too hard and the model now underfits. The best value here is at or
near 0, because a width-32 tanh network on 20 samples of a smooth function is not
badly overfitting. **The right answer is frequently little or no
regularization**, and the way to find out is the validation column, not a prior.

The augmentation result is small — 0.00012 down to 0.00000 — because doubling the
data for an exactly odd target is nearly free here. That is the general shape
though: augmentation helps in proportion to how strong a symmetry the problem has,
and cannot help where there is no valid transform. Augmenting by a transform that
does not preserve the target does not regularize, it corrupts — on the same setup,
flipping the input sign while keeping the label untouched drove the test error from
0.00502 to 0.46609.

## Double descent, and why the picture above is incomplete

The bias-variance story says total error falls with capacity, reaches a minimum,
then rises. That story is wrong, and the correction is not a detail.

For a least-squares model with $d$ features and $n$ samples, ordinary least squares
is well defined whenever $d \le n$ and interpolates at $d = n$. Past $d = n$ the
system is underdetermined and the minimum-norm solution is still computed, with
error decaying roughly as $d^{-1/2}$ rather than rising. The error curve therefore
has a **peak at $d = n$ and a second descent past it**. Belkin et al. (2019)
established this for ridge regression with the ratio $\lambda/d$ held fixed;
Nakkiran et al. (2020) then measured it in trained networks, where the peak appears
where the model first reaches zero training error.

```python
n, G = 100, 10


def trial(d, seed):
    """No regularization; decaying feature spectrum; noiseless test target."""
    r = np.random.default_rng(seed)
    s = np.sqrt(np.arange(1, d + 1) / d)           # decaying covariance spectrum
    X = r.normal(0, 1, (n, d)) * s.reshape(1, -1)
    w_true = r.normal(0, 1, (d, 1)) / np.sqrt(d)
    y = X @ w_true + 0.3 * r.normal(0, 1, n)[:, None]
    X_test = r.normal(0, 1, (300, d)) * s.reshape(1, -1)
    w = np.linalg.lstsq(X, y, rcond=None)[0]
    return float(np.mean((X_test @ w - X_test @ w_true) ** 2))


print("the interpolation threshold: test error peaks at d = n, then falls back")
print(f"{'d':>5} {'median':>10} {'mean':>12} {'worst of 10':>13}")
for d in (10, 50, 90, 99, 100, 101, 110, 150, 200, 400, 1000):
    errs = [trial(d, 100 * i + 1) for i in range(G)]
    print(f"{d:>5} {np.median(errs):>10.4f} {np.mean(errs):>12.4f} {max(errs):>13.2f}")
```

| $d$  | median  | mean     | worst of 10 |
| ---- | ------- | -------- | ----------- |
| 10   | 0.0068  | 0.0087   | 0.02        |
| 50   | 0.0771  | 0.0916   | 0.15        |
| 90   | 0.9275  | 0.8872   | 1.22        |
| 99   | 4.7139  | 5.8941   | 15.95       |
| 100  | 19.7156 | 776.3282 | 6635.33     |
| 101  | 8.4390  | 20.0006  | 75.62       |
| 110  | 1.3237  | 1.6438   | 3.62        |
| 150  | 0.3755  | 0.3785   | 0.59        |
| 200  | 0.3023  | 0.3072   | 0.41        |
| 400  | 0.3899  | 0.3893   | 0.45        |
| 1000 | 0.4401  | 0.4366   | 0.51        |

The peak is at exactly $d = n = 100$, where the fit first interpolates. Error then
falls to 0.3072 at $d = 200$ and stays near there. The value at the peak itself is
worth a second look: the mean over ten draws is 776.3282 while the median is
19.7156, and one draw reaches 6635.33. **At the exact threshold the error
distribution is heavy-tailed**, so a mean over a handful of runs says nothing
there — an evaluation at that operating point needs dozens of seeds.

What the peak is made of is visible in the ensemble table above. At $d = 100$ the
solution is arbitrary along a null space of dimension 100 — any direction can be
added without changing the training fit — and how much of it leaks into predictions
depends on the conditioning of $X^\top X$, which varies wildly from draw to draw.
Past the threshold the effective dimension is capped by $n$, so adding features adds
no freedom; it adds directions known a priori to matter or not, and a good
inductive bias exploits that.

Three consequences for practice. Regularization is not always a good investment: an
explicitly over-parameterized model with a small $\lambda$ can beat its own
regularized version. Model selection should never be done at the interpolation
threshold, where the outcome is decided by numerical conditioning rather than by the
data's signal. And if a run crosses the interpolation point mid-training, the
checkpoint you want is usually after it, not before.

## When more data beats more regularization

Both reduce variance, and they are not interchangeable. More data reduces the
estimator's sensitivity to its particular sample; regularization reduces it by
shrinking toward a prior. They differ in four ways.

**Asymptotics.** Regularization introduces bias that persists at infinite $n$: the
penalized estimator converges to the $\lambda$-regularized solution, not the
unpenalized one, so its bias never goes to zero. More data makes no such promise —
the unpenalized estimator converges to the truth.

**Capacity.** Regularization must be strong enough to neutralize capacity that data
would otherwise support. With $d \ll n$ you need a heavy penalty to make a
million-parameter model behave like a linear one, and the bias that costs is real.
More data lets you use the capacity you have.

**Cost.** More data costs storage, ingestion and training time forever.
Regularization costs almost nothing — a decay coefficient and a validation sweep.
When the data pipeline is the bottleneck, regularization wins.

**Coverage.** This one is not really about the objective. An augmentation or a
regularizer can only exploit structure already present in the distribution you have.
Shrinking weights toward zero encodes "the answer is small"; it cannot encode "the
answer is distributed differently in the test region than in training." **Only more
data covers a region the training set never saw**, and under distribution shift it
is the only fix that works.

So the ordering follows: use data you are not using; failing that, regularize,
choosing the strength on a validation set. If validation error is flat well above
the noise floor, none of these help and the hypothesis class is wrong.

## What this lesson does not settle

The decomposition assumed independence and zero-mean noise with finite variance.
Correlated residuals — time series, clustered subjects, repeated measures — break
the uncorrelated-bias assumption, and a model can then have low bias and still be
unusable. The three-term split is also exact for squared error and does not
generalize in this form to cross-entropy, where the analogue involves Fisher
information rather than variance.

Which regularizer to use is largely empirical, and the empirical answer moves.
Weight decay is near-universal for transformers now, but not for convolutional
networks, which used batch normalization and often no decay at all. The claimed
generalization gap between Adam and SGD is a measurement in a specific protocol,
not a law. And double descent has solid theory for well-specified linear models;
whether the deep-network peaks Nakkiran et al. measured are the same phenomenon is
an open question, and the honest position is that they look similar and are not
proven identical.

One more limit. Everything above assumes the test distribution is the training
distribution, and the variance term is computed under that assumption. Under shift,
the bias term stops being a bias about the truth and becomes a bias about the wrong
function entirely, and no amount of variance reduction helps.

## References

- Stuart Geman, Elie Bienenstock and Richard Doursat, "Neural Network
  Approximation of Functions that Contain Infinitely Many Neurons", Neural
  Computation, 1995 — the bias-variance decomposition as an approximation bound.
- Nitish Srivastava et al., "Dropout: A Simple Way to Prevent Neural Networks from
  Overfitting", JMLR 2014.
- Mikhail Belkin et al., "Reconciling modern machine-learning practice and the
  classical bias-variance trade-off", PNAS 2019, arXiv:1812.11118 — the rigorous
  form of double descent for ridge regression.
- Preetum Nakkiran et al., "Deep Double Descent: Where Bigger Models and More
  Data Hurt", ICLR 2021, arXiv:1912.02292 — the phenomenon measured in trained
  networks, with the label-smoothing and noise-label qualifications stated
  explicitly.
- Ilya Loshchilov and Frank Hutter, "Decoupled Weight Decay Regularization", ICLR
  2019, arXiv:1711.05101 — why decay is applied outside the adaptive update.
