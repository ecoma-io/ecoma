---
title: 'Probability and statistics for machine learning'
description: 'Random variables, distributions, expectation, conditional probability and Bayes rule — the language of uncertainty in a trained model.'
date: '2026-09-17'
author: 'John Martin'
tags:
  - mathematics
  - ai
featured: false
cover: ../../../assets/cover-04-probability-and-statistics-for-ml.svg
coverAlt: 'Abstract bell curve motif on a light background beside the lesson title'
articleId: probability-and-statistics-for-ml
seriesId: mathematical-foundations
seriesOrder: 4
contentType: theory
level: foundational
prerequisites:
  - vectors-matrices-and-tensors
relatedArticleIds:
  - information-theory-and-cross-entropy
  - supervised-learning-and-generalization
---

# Probability and statistics for machine learning

A neural network's output is a set of numbers, and nothing in those numbers
distinguishes "confident and correct" from "confident and wrong." Probability is
what turns a score into a claim about uncertainty, and the reason a training loss
is interpretable at all.

This lesson builds that language: random variables, discrete and continuous
distributions, expectation and variance, covariance, conditional probability, and
Bayes' rule. Then it does what practitioners actually need — show that the
sample mean is unbiased while the naive sample variance is not, and why maximum
likelihood estimation is the statistical backbone of everything in the next
lesson.

## Random variables and distributions

A **random variable** $X$ maps outcomes to numbers. It is **discrete** when its
possible values form a countable set (the token that comes next, whether a
document is spam), and **continuous** when they fill an interval (a measurement,
a latency, a weight before rounding).

A **probability mass function** (pmf) gives a discrete variable's probabilities,
$p(x) = P(X = x)$, and must be nonnegative and sum to 1 over the support. A
**probability density function** (pdf) $f(x)$ spreads that mass continuously, with
$P(a \le X \le b) = \int_a^b f(x)\, dx$. The distinction is not cosmetic: a pdf
can exceed 1, because it is a rate, not a probability.

Two distributions carry most of the weight in practice. The **Bernoulli**
distribution puts mass $p$ on 1 and $1-p$ on 0 — a single coin flip, or a single
yes/no. The **normal** (Gaussian) distribution has density
$f(x) = \frac{1}{\sigma\sqrt{2\pi}} \exp\left(-\frac{(x-\mu)^2}{2\sigma^2}\right)$
with mean $\mu$ and standard deviation $\sigma$. Its density at the mean, for
$\sigma = 2$, is $0.1995$, which exceeds the familiar "68–95–99.7" summary because
that summary is about intervals, not densities:

| Interval                                | Probability |
| --------------------------------------- | ----------- |
| $\mu \pm 1\sigma$                       | 0.6827      |
| $\mu \pm 2\sigma$                       | 0.9545      |
| $\mu \pm 1.96\sigma$ (each tail 0.0250) | 0.9500      |

Other distributions matter and will appear later: the **categorical** distribution
(a softmax's target), the **multinomial** (counts over categories, as in
token frequencies), and the **softmax** distribution over real logits, which is
what a language model actually emits. Choosing among them is a modelling
decision with real consequences; SciPy's
[probability distributions reference](https://docs.scipy.org/doc/scipy/reference/stats.html)
is the catalogue, with each entry stating its support and parameterization.

## Expectation, variance, and covariance

The **expectation** of a random variable is its long-run average, $\mathbb{E}[X] =
\sum_x p(x) x$ for a discrete variable and $\int x f(x)\, dx$ for a continuous
one. Linearity is unconditional: $\mathbb{E}[aX + bY] = a\mathbb{E}[X] +
b\mathbb{E}[Y]$, with no independence assumption. This is why the expectation of
a large neural network is tractable even though the network itself is not.

The **variance** measures spread: $\mathrm{Var}(X) = \mathbb{E}[(X -
\mathbb{E}[X])^2]$, with standard deviation $\sigma = \sqrt{\mathrm{Var}(X)}$. A
worked discrete case, with $X \in \{0,1,2,3\}$ and $p = [0.1, 0.2, 0.3, 0.4]$:
the mean is $2.0$, the variance is $1.0$, and the standard deviation is $1.0$.

**Covariance** measures how two variables move together:

$$
\mathrm{Cov}(X, Y) = \mathbb{E}\left[(X - \mathbb{E}[X])(Y - \mathbb{E}[Y])\right]
= \mathbb{E}[XY] - \mathbb{E}[X]\mathbb{E}[Y].
$$

Take two Bernoulli variables with $P(A=1) = 0.3$ and $P(B=1) = 0.6$. If they are
independent, $\mathbb{E}[AB] = P(A=1)P(B=1) = 0.18$ and the covariance is
$0.18 - 0.3 \cdot 0.6 = 0$ — independence implies zero covariance, though the
converse fails. If instead $B = A$ exactly, then $\mathbb{E}[AB] = 0.3$ and the
covariance is $0.3 - 0.09 = 0.21 = P(A=1)(1 - P(A=1))$, the variance of $A$ itself.
Covariance is a scaled correlation, and like any scale-dependent quantity it is
easy to misread: divide both variables by a large constant and the correlation is
unchanged while the covariance shrinks by the square.

This is the machinery behind why we normalize activations and inputs before
training. An unnormalized input has a large covariance structure, and the gradient
directions inherit it.

## Conditional probability and Bayes' rule

**Conditional probability** restricts attention to a subset of outcomes:
$P(A \mid B) = P(A \cap B) / P(B)$ when $P(B) > 0$. The chain rule
$P(A \cap B) = P(A \mid B)P(B)$ is how conditional probabilities compose, and
repeated application is what lets a language model factor a long joint
distribution into a product of conditionals — the structure of
[/en/blog/language-modeling-next-token-prediction](/en/blog/language-modeling-next-token-prediction).

**Bayes' rule** follows from the chain rule in two orders:

$$
P(A \mid B) = \frac{P(B \mid A) P(A)}{P(B)}, \qquad
P(B) = \sum_{a} P(B \mid A=a) P(A=a).
$$

The classical demonstration is a medical test, because it is the case where
intuition reliably fails. Let $D$ mean "disease is present" and $+$ mean "test is
positive". Take sensitivity $P(+\mid D) = 0.98$, specificity
$P(-\mid \neg D) = 0.95$ so false-positive rate $P(+\mid\neg D) = 0.05$, and
prevalence $P(D) = 0.01$ — one in a hundred.

The positive rate is

$$
P(+) = 0.98 \times 0.01 + 0.05 \times 0.99 = 0.0098 + 0.0495 = 0.0593.
$$

So a positive test occurs 5.93% of the time. Bayes gives the answer people
actually want:

$$
P(D \mid +) = \frac{P(+\mid D) P(D)}{P(+)}
= \frac{0.0098}{0.0593} = 0.165261,
$$

about **16.5%**, not 98%. With the same test but prevalence $P(D) = 0.30$:

$$
P(D \mid +) = \frac{0.98 \times 0.30}{0.98 \times 0.30 + 0.05 \times 0.70} = 0.893617,
$$

about **89.4%**. The test did not change. The **prior** did, and Bayes' rule makes
that dependence explicit rather than hiding it.

Two failure modes to name explicitly. **Base rate neglect** is the error above: the
likelihood $P(+\mid D)$ is mistaken for the posterior $P(D\mid +)$. And **selection
bias** is what happens when $P(+\mid D)$ is measured on patients who were sent
for testing rather than on the whole population, in which case the test's
sensitivity and specificity are conditional on a selection the formula does not
know about. Any benchmark whose test set is filtered after seeing the outcome — for
example, evaluation data chosen because a model got it right — has this problem,
and
[/en/blog/evaluating-language-models](/en/blog/evaluating-language-models)
discusses what it costs.

## Estimation: MLE, and the bias of the sample variance

Machine learning almost never knows the distribution it is drawing from. It has
$n$ samples and needs the parameters. **Maximum likelihood estimation** (MLE)
chooses the parameters making the observed data most probable: maximize
$\prod_{i=1}^{n} p_{\theta}(x_i)$, or equivalently minimize the negative
log-likelihood, because sums are easier to differentiate than products.

Two MLE results worth knowing by heart. For a normal distribution with known
$\sigma$, $\hat{\mu}_{MLE} = \frac{1}{n}\sum_i x_i$, the sample mean. For a
Bernoulli with $k$ successes in $n$ trials, $\hat{p}_{MLE} = k/n$. For the sample
$\{2, 4, 6\}$, the MLE mean is $4.0$ (known $\sigma$), and with $\mu = 2$ fixed, the
MLE variance is $\frac{1}{3}(0 + 4 + 16) = 6.6667$.

Both standard sample statistics are estimators, and their bias differs in a way
that matters:

- The **sample mean** $\bar{x} = \frac{1}{n}\sum_i x_i$ is **unbiased**:
  $\mathbb{E}[\bar{x}] = \mu$.
- The **naive sample variance** $\frac{1}{n}\sum_i (x_i - \bar{x})^2$ is
  **biased downward**: $\mathbb{E}\left[\frac{1}{n}\sum_i (x_i-\bar{x})^2\right] =
  \frac{n-1}{n}\sigma^2$.
- The corrected **Bessel-corrected** estimate $\frac{1}{n-1}\sum_i (x_i - \bar{x})^2$
  is unbiased.

The bias is not subtle. Drawing $n = 4$ samples from $\mathcal{N}(0, 1)$ and
averaging over 400,000 repetitions gives an expected naive variance of $0.7480$
and an expected Bessel-corrected variance of $0.9974$, against a true
$\sigma^2 = 1$ — the naive estimator reads about a quarter too small on average,
precisely because it is $\frac{n-1}{n}$ of the truth at $n = 4$.

```python
import numpy as np

rng = np.random.default_rng(1)
S = rng.standard_normal((400_000, 4))        # n = 4 samples from N(0, 1)
print(S.var(axis=1, ddof=0).mean())           # 0.7480
print(S.var(axis=1, ddof=1).mean())           # 0.9974
```

The direction of the bias matters as much as its size: the naive estimator
_understates_ spread, so a training run using it will mistake a lucky batch for a
converged model. This is why validation and test sets are never reused while
tuning, which is the practical subject of
[/en/blog/supervised-learning-and-generalization](/en/blog/supervised-learning-and-generalization).

Three further limits on estimation deserve stating plainly. MLE is consistent
(the estimate converges to the truth as $n$ grows) and asymptotically normal, but
at small $n$ it can be badly biased — the variance example is exactly this.
MLE is also not robust: a single corrupted input can move it arbitrarily far,
since log-likelihood is unbounded in the tail, whereas a median-based estimator
does not move. And a confidence interval is a statement about the estimator under
a model; it is not a guarantee about the world.

## Where this stops being enough

Probability tells you how to talk about uncertainty given a distribution. It does
not tell you which distribution is right, and in a language model that choice is
forced on you: the model outputs a full distribution over $V$ tokens, and the
quantity that scores it is built from those probabilities. Turning the expectation
over a distribution into a number you minimize is the subject of
[/en/blog/information-theory-and-cross-entropy](/en/blog/information-theory-and-cross-entropy).

Two specific limits. First, the standard treatment assumes independence or
explicit modelling of dependencies, and real text is neither — a sequence of
tokens has dependence structure that a naive per-token model ignores. Second,
expectations are linear but variances of dependent variables are not: stacking
independent-looking terms whose variances happen to align produces far larger
loss spikes than independence would predict, which is why loss curves in
large-scale training are notoriously non-monotone.

## References

- SciPy documentation,
  [Probability distributions](https://docs.scipy.org/doc/scipy/reference/stats.html)
  — the discrete and continuous distributions used for sampling in practice.
- NumPy documentation, [Random sampling](https://numpy.org/doc/stable/reference/random/index.html)
  — including `numpy.random.default_rng`, the generator used above.
