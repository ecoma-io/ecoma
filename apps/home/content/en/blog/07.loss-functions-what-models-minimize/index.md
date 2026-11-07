---
title: 'Loss functions: what does a model actually learn to minimize?'
description: 'Squared error, cross-entropy and likelihood are different objectives, not interchangeable spellings of the same thing.'
date: '2026-09-20'
author: 'John Martin'
tags:
  - machine-learning
  - ai
featured: false
cover: ../../../assets/cover-07-loss-functions-what-models-minimize.svg
coverAlt: 'Abstract crossing curves motif on a light background beside the lesson title'
articleId: loss-functions-what-models-minimize
seriesId: classical-machine-learning
seriesOrder: 2
contentType: theory
level: intermediate
prerequisites:
  - information-theory-and-cross-entropy
  - supervised-learning-and-generalization
relatedArticleIds:
  - gradient-descent-and-backpropagation
  - preference-optimization-rlhf-and-dpo
---

# Loss functions: what does a model actually learn to minimize?

Pick a loss function and you have made a claim about what a wrong prediction
costs. Mean squared error says being wrong by 10 is a hundred times worse than
being wrong by 1. Cross-entropy says being confidently wrong about something
that happens constantly is much cheaper than being confidently wrong about
something rare — the opposite preference. Neither is a neutral default, and
choosing between them changes what the model converges to, not merely how fast.

The two are not spellings of one idea. Each comes from a different probability
model of the data, and each carries a different implication about the residual
structure you are assuming. After this lesson you should be able to derive
squared error from Gaussian likelihood and cross-entropy from categorical
likelihood, state the gradient of each output layer, and explain why a choice of
loss can make a problem unsolvable in principle.

## Loss, objective, and what gets optimized

Three words get conflated. The **loss** $\ell(\hat{y}, y)$ is a measure of
disagreement for a single example. The **objective** is what you actually
minimize over $\theta$, usually an aggregate of the loss over the training set,
often plus a penalty:

$$
J(\theta) = \frac{1}{n} \sum_{i=1}^{n} \ell(h_\theta(\mathbf{x}_i), y_i) + \lambda \|\theta\|_2^2
$$

The **metric** is a third thing entirely — accuracy, F1, recall@10 — reported but
not optimized. These three can disagree, and when they do the model improves on
the objective and not on the metric. That gap is the practical reason
[preference optimization](/en/blog/preference-optimization-rlhf-and-dpo) exists:
the reward that best predicts human choice is not a likelihood at all.

## Squared error is a likelihood in disguise

Assume the observations are Gaussian around a linear predictor, $y_i = f(\theta, \mathbf{x}_i) + \epsilon_i$ with $\epsilon_i$ independent and $\epsilon_i \sim \mathcal{N}(0, \sigma^2)$, where $\sigma$ is known. The density is
$\mathcal{N}(y; f, \sigma^2) = \frac{1}{\sqrt{2\pi\sigma^2}} \exp\left(-\frac{(y-f)^2}{2\sigma^2}\right)$, so
the negative log-likelihood of the $i$th sample is

$$
-\log p(y_i) = \frac{1}{2}\log 2\pi\sigma^2 + \frac{(y_i - f(\theta, \mathbf{x}_i))^2}{2\sigma^2}
$$

The first term is constant in $\theta$ and drops out of the gradient. **Minimizing
the negative log-likelihood is therefore exactly minimizing squared error.** Not
approximately — identically, up to a positive scale factor $1/(2\sigma^2)$.

That factor is the whole content of "$\sigma$ is the noise level". Its presence in
the objective is what makes squared error a maximum-likelihood estimator, and its
presence _not_ in the loss is what makes the loss scale-sensitive: multiplying it
by a constant rescales every gradient by that constant.

The consequence of the Gaussian assumption is that errors are independent and
equally plausible at every magnitude. One wrong value by 53 units is 2800 times
as bad as one wrong by 1:

```python
import numpy as np


def mse(y_true, y_pred):
    return float(np.mean((y_true - y_pred) ** 2))


def mae(y_true, y_pred):
    return float(np.mean(np.abs(y_true - y_pred)))


def gaussian_nll(residual, sigma):
    """Negative log-likelihood of a Gaussian with fixed known sigma."""
    return float(0.5 * np.log(2 * np.pi * sigma ** 2) + np.mean(residual ** 2) / (2 * sigma ** 2))


y_true = np.array([1.0, 3.0, 5.0, 7.0])
off = np.array([1.2, 2.6, 6.0, 6.4])
spike = np.array([1.0, 3.0, 5.0, 60.0])
print(f"exact fit       MSE {mse(y_true, y_true):.4f}  MAE {mae(y_true, y_true):.4f}")
print(f"all errors 0.4  MSE {mse(y_true, off):.4f}  MAE {mae(y_true, off):.4f}")
print(f"one error 53.0  MSE {mse(y_true, spike):.4f}  MAE {mae(y_true, spike):.4f}")
```

Three predictions of 0.4 error each score 0.3900 under MSE; one prediction off by
53 scores 702.2500 — dominated entirely by the single outlier. Mean absolute
error, which corresponds to a Laplace noise model instead, scores 0.5500 and
13.2500: a 24-fold ratio rather than a 1800-fold one. On data with heavy-tailed
errors, squared error spends the entire gradient budget on the few worst samples,
which is why it produces unstable training on real-world regression targets unless
the outliers are handled first.

Same residual, different noise model, different penalty:

| assumed noise $\sigma$ | negative log-likelihood |
| ---------------------- | ----------------------- |
| 0.5                    | 0.545791                |
| 2.0                    | 1.632086                |

Both are valid models of the same data; they disagree about how much the residual
should be trusted, and that disagreement is entirely in $\sigma$.

## Cross-entropy is a likelihood with a different noise model

Now assume the observation is a class $y \in \{1, \dots, V\}$ drawn
categorically from the model's own softmax probabilities
$\mathbf{p} = \mathrm{softmax}(\boldsymbol{\ell})$. The categorical density is
$p(y) = p_y$, so the negative log-likelihood is

$$
-\log p(y) = -\log p_y = -\sum_{j=1}^{V} y_j \log p_j
$$

with $\mathbf{y}$ the one-hot label. The constant term that made the two losses
look different is gone entirely. There is no scale parameter, no offset, no
choice: the softmax is already normalized, so cross-entropy is _exactly_ negative
log-likelihood, and the gradient is correspondingly simple.

This is the identity
[/en/blog/information-theory-and-cross-entropy](/en/blog/information-theory-and-cross-entropy)
derived from the other direction. Cross-entropy is also the only divergence in
that family that stays finite when the model assigns nonzero probability to every
outcome. The Hellinger distance, for comparison, is a perfectly good metric on
distributions and is not the negative log of any likelihood:

```python
a, b = np.array([0.4, 0.6]), np.array([0.1, 0.9])
print(f"p=[0.4,0.6] vs q=[0.1,0.9]: cross-entropy {float(-(b * np.log(a)).sum()):.4f} nats")
print(f"the same pair under Hellinger distance: {float(np.sqrt(0.5 * ((np.sqrt(a) - np.sqrt(b)) ** 2).sum())):.4f}")
```

0.5514 against 0.2553 — different scales, different orderings, neither derived
from the other. Cross-entropy is not "a" distance between distributions; it is
the cost of coding the data with a distribution you believe in, and that specific
meaning is what gives it its gradient.

## The two gradients at the output layer

The loss choice shows up most sharply in the gradient, because the output layer's
form and its loss are chosen together.

**Squared error with a linear output.** With $L = \frac{1}{n}\sum_i (\hat y_i - y_i)^2$,
the gradient with respect to the pre-activation $z$ is

$$
\frac{\partial L}{\partial z} = \frac{2}{n}(\hat{y} - y) \cdot \frac{\partial \hat{y}}{\partial z}
$$

For a linear output $\partial \hat{y}/\partial z = 1$, giving a gradient
proportional to the residual itself. **A residual of 10 produces a gradient 10
times larger than a residual of 1**, and since it is the gradient that drives
every parameter update, the model spends its optimization effort wherever the
largest absolute error happens to be. On a regression problem where most residuals
are 0.01 and a few are 10, the update is determined by the few.

**Cross-entropy with a softmax output.** Let $\boldsymbol{\ell}$ be the logits and
$\mathbf{p} = \mathrm{softmax}(\boldsymbol{\ell})$. Because the loss collapses to a
single term, $-\log p_y$, the derivative has one clean form:

$$
\frac{\partial \mathrm{CE}}{\partial \ell_j} = p_j - y_j
$$

The gradient is the model's own probability output minus the truth. Every property
worth naming follows from that:

- It sums to zero across $j$, so the update never wastes capacity translating the
  whole distribution, which the softmax's shift-invariance makes irrelevant.
- Its magnitude is bounded by 1 regardless of how confident the model is, so
  there is no unbounded gradient to explode.
- A confidently wrong prediction gets a gradient of magnitude near 1 — bounded,
  but not downweighted. This is the reason for the log in the loss: it caps the
  damage a single confidently-wrong token can do while still pulling hard.
- A confidently correct prediction gets a gradient of magnitude near 0, so the
  optimizer stops pushing on examples already solved.

```python
import numpy as np


def log_softmax(z):
    """Row-wise log-softmax, computed without materializing probabilities."""
    z = z - z.max(axis=-1, keepdims=True)
    return z - np.log(np.exp(z).sum(axis=-1, keepdims=True))


def cross_entropy(logits, labels):
    """Mean negative log-likelihood of the observed label indices."""
    lp = log_softmax(logits)
    return float(-lp[np.arange(len(labels)), labels].mean())


logits = np.array([[1.0, 3.0, 0.5]])
labels = np.array([1])
probs = np.exp(log_softmax(logits))
grad = probs.copy()
grad[np.arange(len(labels)), labels] -= 1.0
print(f"single-token cross-entropy {cross_entropy(logits, labels):.6f}")
print(f"softmax probabilities {np.round(probs[0], 6)}")
print(f"gradient w.r.t. logits   {np.round(grad[0], 6)}")

huge = np.array([[800.0, 801.0]])
with np.errstate(over="ignore"):
    print(f"exp of raw logits 800,801 sums to {float(np.exp(huge).sum()):.3e}")
print(f"stable softmax over the same logits {np.round(np.exp(log_softmax(huge))[0], 6)}")
```

The last two lines are the reason every implementation computes cross-entropy
from logits via log-sum-exp rather than from probabilities. A model with large
logits — which happens routinely in a half-trained network — produces `inf` when
you exponentiate directly, and `inf/inf` gives `nan`. Subtracting the row maximum
is algebraically a no-op because it cancels between numerator and denominator,
and it turns a garbage result into 0.268941 and 0.731059.

## Loss and output layer are one decision

The pairing is not arbitrary. A linear output with cross-entropy is
mathematically broken; so is a softmax output with squared error.

**Linear output, cross-entropy.** Softmax is undefined on logits that reach
$\pm\infty$, so a linear layer can emit arbitrarily large logits and drive the
loss to `nan`. There is no bound on how wrong the model can get. In practice this
combination simply never trains.

**Softmax output, squared error.** Now the model must drive $\mathbf{p}$ toward
the one-hot label. Because $\mathbf{p}$ sums to 1 and is bounded in $[0,1]$, it
cannot reach a one-hot target; the closest achievable is uniform-plus-epsilon, so
the residual $\hat{y} - y$ never vanishes. A one-hot target assigned probability
zero is a distance of 1 that cannot be improved, which wastes the model on a
target it structurally cannot hit.

The corresponding remedies are exactly the ones in use. Squared error pairs with a
**linear** output because unbounded predictions are needed to represent unbounded
targets. Cross-entropy pairs with **logits fed through softmax** so the outputs
live on the probability simplex, and the whole vocabulary of the model is then
constrained to be a valid distribution. Bounding labels instead — scaling targets
into $[0,1]$ and rescaling on output — is a variant of the same idea, used where
continuous targets must still be predicted with a bounded output.

For regression under heavy-tailed noise the third option is a **linear output with
Huber loss**, which behaves like squared error near zero and like absolute error
far away. It is again a likelihood: the Huber density is Gaussian in the core and
exponential in the tails.

## What the loss silently decides

Two consequences are worth stating because they are routinely surprising.

**Averaging changes which tokens matter.** The objective is a mean over tokens, so
improving frequent tokens lowers it much more than improving rare ones. This is
not a bug in the design; it follows from the mean. But it means the loss measures
_per-token_ quality and says nothing about per-document quality, and a document
made of rare tokens can be modelled badly while the reported loss barely moves.
Frequency-weighted objectives and per-document normalization both change the
target in ways that must be stated explicitly.

**Label smoothing changes the target, not the prediction.** Replacing the one-hot
$\mathbf{y}$ with $\tilde{y} = (1-\epsilon)\mathbf{y} + \epsilon / V$ keeps the
same logits but asks the model to match a distribution it can never achieve, and
the loss has an irreducible floor of $\epsilon$ that no amount of training
removes:

```python
import numpy as np


def log_softmax(z):
    z = z - z.max(axis=-1, keepdims=True)
    return z - np.log(np.exp(z).sum(axis=-1, keepdims=True))


logits = np.array([[1.0, 3.0, 0.5]])
eps = 0.1
smoothed = np.full(3, eps / 3)
smoothed[1] += 1.0 - eps
lp = log_softmax(logits)[0]
print(f"cross-entropy against a hard target     {float(-lp[1]):.6f}")
print(f"cross-entropy against a smoothed target {float(-(smoothed * lp).sum()):.6f}")
print(f"target mass {np.round(smoothed, 6)}")

peak = np.array([0.70, 0.10, 0.10, 0.10])
flat = np.full(4, 0.25)
print(f"cross-entropy of the peaked predictor {float(-np.log(peak).mean()):.6f}")
print(f"cross-entropy of the uniform predictor {float(-np.log(flat).mean()):.6f}")
print(f"cost of putting 0.70 on the right token {float(-np.log(peak.max())):.6f} nats")
```

The final three lines quantify the asymmetry that makes cross-entropy sensitive to
calibration rather than only to ranking. Over four tokens, the uniform predictor
costs 1.386294 nats and the peaked one 1.816108 — **the more confident predictor
scores worse on average** when it is right only 70% of the time. Confidence that
exceeds accuracy is actively penalized, which is the loss doing its job.

## Where the two families fail

Squared error's failure is the tail. Its Gaussian assumption says large residuals
are exponentially unlikely, so it responds to them linearly when it should respond
quadratically — or, more accurately, it should not let one residual dominate at
all. On targets with heavy tails, heteroscedastic noise, or occasional sensor
glitches, this is a real problem rather than a stylistic one, and the honest fixes
are to model the noise (change $\sigma$ per sample), change the likelihood (Huber,
Student-t), or clean the data.

Cross-entropy's failure is that it optimizes likelihood and nothing else. A model
can reach excellent cross-entropy on data that is highly predictable — templated
text, repeated boilerplate, a narrow domain — while being useless outside it. The
entropy floor $H(q)$ from the previous lesson is the formal statement: below that
number there is no information left to model. Worse, likelihood gives no way to
express that answer A is _better_ than answer B when both are fluent, which is
precisely the gap
[preference optimization](/en/blog/preference-optimization-rlhf-and-dpo) fills and
which no reweighting of token likelihoods closes.

Both families assume independence across examples when the loss is a mean. When
examples are correlated — multiple outputs from one document, several items from
one session — the effective sample size is smaller than $n$, and the loss
understates its own uncertainty by exactly that factor.

One open question deserves naming rather than glossing. The cases above are all
derived, and the squared-error/cross-entropy pairing with its linear/softmax
layer is derived too. What is not derived is the choice among **non-convex
surrogate objectives** — losses shaped for robustness or for calibration rather
than for likelihood. Their behaviour is empirical, and the theory is thinner than
the practice.

## References

- PyTorch documentation,
  [`torch.nn.functional.cross_entropy`](https://pytorch.org/docs/stable/generated/torch.nn.functional.cross_entropy.html) —
  the log-sum-exp implementation of the loss whose stability this lesson traces.
- NumPy documentation,
  [`numpy.logaddexp`](https://numpy.org/doc/stable/reference/generated/numpy.logaddexp.html) —
  numerically stable log-sum-exp, available without SciPy.
