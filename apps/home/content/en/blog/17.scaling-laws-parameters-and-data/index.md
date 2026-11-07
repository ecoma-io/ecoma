---
title: 'Scaling laws: parameters, data, and compute'
description: 'What the empirical scaling relationships do and do not justify, and why the compute-optimal training budget keeps moving.'
date: '2026-09-30'
author: 'John Martin'
tags:
  - training
  - ai
featured: false
cover: ../../../assets/cover-17-scaling-laws-parameters-and-data.svg
coverAlt: 'Abstract power law motif on a light background beside the lesson title'
articleId: scaling-laws-parameters-and-data
seriesId: pretraining
seriesOrder: 2
contentType: research-review
level: advanced
prerequisites:
  - training-a-transformer
relatedArticleIds:
  - data-curation-quality-and-contamination
  - distributed-training-parallelism
---

# Scaling laws: parameters, data, and compute

Some empirical relationships in machine learning are strong enough to plan
against. The claim that language-model loss falls as a power law in training
compute is one of them: across many orders of magnitude in compute, a simple
power law fits real runs well enough to forecast them. That is unusual, and it
is also why these relationships get over-read. A power law that predicts loss
does not predict capabilities, does not tell you the right split of a fixed
budget between parameters and data, and does not survive being pointed at a
corpus someone else built.

After this lesson you should be able to state the empirical form, compute the
compute-optimal allocation at a given budget, and — more importantly — say
which parts are robust fits and which parts are contested.

## The empirical form, and how much to trust the exponent

The relationship, established in this form by Kaplan et al. 2020, is that for a
fixed architecture family and a fixed data distribution, the final cross-entropy
loss behaves approximately as

$$
L(N, D) \approx \left(\frac{N_c}{N}\right)^{\alpha_N}
              \left(\frac{D_c}{D}\right)^{\alpha_D} + L_{\text{irreducible}},
$$

where $N$ is parameter count, $D$ is training tokens, and
$L_{\text{irreducible}}$ is the entropy of the data distribution — the loss a
model with infinite capacity trained on infinite data would still pay, which for
English text is not zero. The complementary relationship, usually quoted
directly, is

$$
L(C) \approx L_{\text{irreducible}} + A\,C^{-\alpha}
$$

with training compute $C = 6ND$ from [the previous lesson](/en/blog/training-a-transformer).

**The exponent $\alpha$ is not a constant of nature.** It is a slope fitted over
a compute range spanning a few orders of magnitude, on a data distribution no
longer in existence, with an architecture family that has since changed
substantially. Published fits differ: Kaplan et al. reported values in the
neighbourhood of $\alpha \approx 0.076$ for their parameter-scarce regime,
while Hoffmann et al. 2022 fitted a noticeably flatter curve, on the order of
$\alpha \approx 0.05$, over a different compute range. Both are fits, not
measurements of a universal slope, and the gap between them is large enough to
change engineering decisions. Later work has argued that fitted exponents are
sensitive to the width of the compute range used, to the architecture and
optimizer, and to whether the irreducible term is handled consistently.

The honest way to use $\alpha$ is as a sensitivity knob:

| $\alpha$ | 100x more compute              | 10,000x more compute |
| -------- | ------------------------------ | -------------------- |
| 0.03     | $L \times 0.871$ (12.9% lower) | $L \times 0.759$     |
| 0.05     | $L \times 0.794$ (20.6% lower) | $L \times 0.631$     |
| 0.076    | $L \times 0.705$ (29.5% lower) | $L \times 0.497$     |

The rows span the range of published opinion and differ by nearly a factor of
two in "loss improvement per 100x compute." If a decision hinges on which one
is right, the decision is not supported by the data.

## What the power law does justify

It supports one firm conclusion, and this is the part that has held up across
every re-analysis: **within a fixed architecture family and a fixed data
distribution, spending more compute reliably reduces loss, with diminishing
returns close to a clean power law.** There is no observed cliff. A 100x compute
increase has bought real, reproducible loss reductions across every scale ever
measured. This is why the default answer to "our model is too weak" is "train it
bigger for longer," and that answer has been right often enough to state
without hedging.

It also justifies an allocation _direction_. Fixing $C$ means $D = C/(6N)$, so
substituting into the first equation gives an interior optimum — the loss is
lowest neither at $N \to 0$ (no capacity) nor at $D \to 0$ (no data). This is a
real, derivable consequence, not an empirical curiosity, and it holds for any
strictly decreasing $L(N, D)$ under fixed compute. It says: **there is such a
thing as a compute-optimal model size**, and both "make the model as large as
possible" and "make the model as small as possible" are wrong.

## Compute-optimal allocation, computed

Take the fitted surface Hoffmann et al. report,

$$
L(N, D) = E + \frac{A}{N^{a}} + \frac{B}{D^{b}}
$$

with $E \approx 1.69$, $A \approx 406.4$, $a \approx 0.34$, $B \approx 410.7$,
$b \approx 0.28$. These are their reported constants, quoted here to make the
arithmetic checkable; they are not universal. Imposing $C = 6ND$ and
differentiating, the optimum satisfies

$$
\frac{aA}{N^{a+1}} = \frac{bB}{6^{b}N^{b+1}}
\quad\Longrightarrow\quad
N_{\text{opt}} \propto C^{\,b/(a+b)} \approx C^{0.45},
\qquad D_{\text{opt}} \propto C^{a/(a+b)} \approx C^{0.55}.
$$

Sanity-checking that derivation numerically: a golden-section search over
$\log N$ reproduces the closed form to a relative difference below $10^{-7}$ at
$10^{23}$–$10^{25}$ FLOP. Evaluating the fitted surface at three budgets:

```python
## Runnable; reproduces the table below.
## Fitted surface from Hoffmann et al. 2022, as quoted in the lesson.
E, A, a = 1.69, 406.4, 0.34
B, b = 410.7, 0.28


def loss(N, D):
    """Fitted cross-entropy for N parameters and D training tokens."""
    return E + A * N ** (-a) + B * D ** (-b)


def optimal_params(C):
    """N minimising loss(N, C/(6N)), by the derivation above."""
    return ((a * A * C**b) / (b * B * 6**b)) ** (1 / (a + b))


for C in (5.88e22, 5.88e23, 5.88e24):
    N = optimal_params(C)
    D = C / (6 * N)
    print(f"C={C:.2e} -> N={N / 1e9:6.1f}B D={D / 1e12:5.2f}T D/N={D / N:5.0f} L={loss(N, D):.3f}")
```

| Budget $C$          | $N_{\text{opt}}$ | $D_{\text{opt}}$ | $D/N$ | Fitted $L$ |
| ------------------- | ---------------- | ---------------- | ----- | ---------- |
| $5.88\times10^{22}$ | 11.5B            | 0.85T            | 74    | 2.032      |
| $5.88\times10^{23}$ | 32.5B            | 3.02T            | 93    | 1.930      |
| $5.88\times10^{24}$ | 91.9B            | 10.7T            | 116   | 1.859      |

Note the fourth column. The fitted form puts the optimum at $D/N$ of roughly 74
to 116 across this range, not at 20. That matters because the practical rule
everyone quotes from this paper is Chinchilla's actual configuration,
$D \approx 20N$ — what one trained model happened to be, not what the fitted
surface says is optimal at that budget. The two agree only at a budget near
$7.6\times10^{16}$ FLOP, far below any run discussed here. The much-quoted "20
tokens per parameter" is a **design choice validated by one training run**,
sitting next to a surface fit that does not imply it.

### How flat is the optimum?

The practical question is not where the minimum is, but how much loss you pay
for missing it. Sweeping the allocation ratio at a fixed
$C = 5.88\times10^{23}$:

| $D/N$           | $N$    | $D$   | Fitted $L$ | Penalty vs. surface minimum |
| --------------- | ------ | ----- | ---------- | --------------------------- |
| 2               | 221.4B | 0.44T | 1.9717     | +0.042 nats                 |
| 5               | 140.0B | 0.70T | 1.9541     | +0.024 nats                 |
| 20 (Chinchilla) | 70.0B  | 1.40T | 1.9366     | +0.007 nats                 |
| 100             | 31.3B  | 3.13T | 1.9300     | +0.000 nats                 |

This flatness is the most important practical content of the scaling laws.
**Being wrong about the optimal allocation by a factor of 5 in $D/N$ costs
about 0.024 nats.** Large engineering decisions turn out to be worth much less
loss than they are argued to be. If your corpus is bigger than you need, spend
the surplus on parameters; if it is smaller, spend it on more epochs — but
neither error is catastrophic.

## Data quality confounds the entire picture

Every fitted curve above holds the data distribution fixed. That assumption is
load-bearing, and it fails in practice, because corpus quality and quantity move
together and are usually reported together.

Three specific confounds, each of which can move the apparent optimum.

**Corpora differ in more than size.** A 1.4T-token corpus of filtered web text
and a 1.4T-token corpus of deduplicated, aggressively filtered, code-and-prose-
mixed text are different datasets, not the same dataset at two sizes. Loss
curves on them are not comparable, and an "optimal $D/N$" fitted on one is not
a prediction for the other. What filtering does to a corpus is the subject of
[data curation](/en/blog/data-curation-quality-and-contamination).

**Repeated data breaks the model's implicit freshness assumption.** Repeating a
corpus is only free while the model has capacity to spare. Past a few epochs
over the same tokens, models memorize rather than generalize, and the loss stops
improving in the way the fit predicts. This makes the $D$ axis bounded in
practice — you cannot buy compute-optimality with data you do not have.

**A finite corpus caps the useful $D/N$.** The compute-optimal target implies a
data requirement: at $C = 5.88\times10^{23}$ FLOP with the $D \approx 20N$ rule,
$N = 70$B and $D = 1.4$T. A team with 300B tokens of curated corpus cannot reach
that point without heavy repetition; constrained to $D = 3\times10^{11}$, the
same budget instead implies $N = 327$B and a $D/N$ of 0.92 — far more
parameter-heavy than any fitted optimum, because the data simply is not there.

Worth internalizing: **the "optimal" model size is a function of the corpus you
actually have, and the fitted curves were produced by teams with corpora larger
than yours.**

## The limits of extrapolating a curve

Three distinct problems, in increasing order of severity.

**Extrapolation distance.** A curve fitted between $10^{21}$ and $10^{23}$ FLOP
says nothing reliable at $10^{26}$. Power laws are concave on a log-log plot by
construction, so a fit will happily produce a confidence interval at any
exponent — the interval reflects noise in the fitted range, not the possibility
of new behaviour outside it.

**Irreducible loss is not fixed.** The term $E$ in the fitted form is the
entropy of the training distribution. Better data curation changes it. So does a
better tokenizer, which changes what a "token" is worth. The floor is a property
of the pipeline, not of language, and a pipeline improvement moves the whole
curve down rather than sliding along it.

**Loss is not capability.** A lower held-out cross-entropy is a reliable
predictor of _some_ downstream performance and a poor predictor of the specific
capabilities anyone cares about. This gap is the subject of
[evaluating language models](/en/blog/evaluating-language-models), and it is
why a claim like "this scaling relationship implies reasoning emerges at scale"
is not something the scaling laws support. Emergent-looking capability
thresholds are also contested: Schaeffer, Miranda and Koyejo 2023 argue that
discontinuous metric behaviour is often an artifact of a discontinuous _metric_
on top of a continuous underlying improvement, and that the apparent threshold
moves when you rescale the measurement.

## The honest summary

Scaling laws are a good tool for interpolation, a weak tool for extrapolation,
and a poor tool for forecasting capability. What survives every re-analysis:
more compute reduces loss, smoothly; there is a compute-optimal allocation and
it is fairly flat; and the location of that optimum depends on your corpus more
than on the fit. What does not survive: a single number for $\alpha$, the
treatment of $D \approx 20N$ as a law rather than a validated configuration, and
any inference from a loss curve to a capability claim. The Chinchilla recipe —
roughly 20 tokens per parameter — remains a reasonable default for a project
with abundant data and no strong reason to think otherwise. It is a default, not
a derivation.

## References

- Kaplan et al. 2020, _Scaling Laws for Neural Language Models_,
  [arXiv:2001.08361](https://arxiv.org/abs/2001.08361).
- Hoffmann et al. 2022, _Training Compute-Optimal Large Language Models_,
  [arXiv:2203.15556](https://arxiv.org/abs/2203.15556).
- Schaeffer, Miranda and Koyejo 2023, _Are Emergent Abilities of Large Language
  Models a Mirage?_ — the critique of threshold behaviour in metric curves.
  Identifier not verified here, cited in prose.
- Chinchilla's published configuration (70B parameters, 1.4T tokens) as the
  empirical anchor for the $D \approx 20N$ rule.
