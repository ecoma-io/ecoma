---
title: 'Information theory: entropy, cross-entropy, and KL divergence'
description: 'Derive entropy, cross-entropy and KL divergence, and see why language-model training minimizes exactly this quantity.'
date: '2026-09-18'
author: 'John Martin'
tags:
  - mathematics
  - ai
featured: false
cover: ../../../assets/cover-05-information-theory-and-cross-entropy.svg
coverAlt: 'Abstract stacked bars motif on a light background beside the lesson title'
articleId: information-theory-and-cross-entropy
seriesId: mathematical-foundations
seriesOrder: 5
contentType: theory
level: foundational
prerequisites:
  - probability-and-statistics-for-ml
relatedArticleIds:
  - loss-functions-what-models-minimize
  - tokenization-text-to-model-input
---

# Information theory: entropy, cross-entropy, and KL divergence

Every language model is trained by minimizing a single number. That number is a
cross-entropy, it is the negative log-likelihood of the training data under the
model, it is a KL divergence up to a constant, and it is measured in the same
units as information. These are not three different losses with three different
implementations. They are one quantity viewed three ways, and seeing all three is
what makes the loss interpretable rather than arbitrary.

This lesson derives each from the other, then connects them to what a transformer
actually computes. By the end you should be able to compute entropy, cross-entropy
and KL divergence on a worked example, explain in one sentence why minimizing
cross-entropy _is_ maximum likelihood estimation, and derive the gradient of the
softmax output layer.

## Surprisal: why information is a log

Information theory rests on one intuition: a surprising event carries more
information than a likely one, and an event certain to happen carries none. Make
this quantitative and the unit is forced.

Define the **self-information** of an outcome $x$ drawn from a distribution $p$ as

$$
I(x) = -\log_2 p(x).
$$

If $p(x) = 0.5$ the outcome is a coin flip and $I = 1$ bit. If $p(x) = 0.001$ it
carries about $9.97$ bits. If $p(x) = 1$ it carries $0$ bits. Note the base: using
$e$ instead of $2$ gives the same quantity in **nats**, and the choice of base
only rescales everything that follows.

The average self-information over the distribution is the **entropy**:

$$
H(p) = \mathbb{E}_{x \sim p}[I(x)] = -\sum_{x} p(x) \log_2 p(x).
$$

Entropy measures the average uncertainty in a distribution, and it is maximized
by the uniform distribution.

## Entropy behaves the way intuition expects

For a Bernoulli variable with parameter $p$, $H(p) = -p\log_2 p - (1-p)\log_2(1-p)$:

| $p$   | $H(p)$ in bits |
| ----- | -------------- |
| 0.5   | 1.000000       |
| 0.1   | 0.468996       |
| 0.01  | 0.080793       |
| 0.001 | 0.011408       |

The maximum is exactly 1 bit at $p = 0.5$, and entropy falls off fast as the
distribution sharpens. A uniform distribution over $V$ tokens has entropy exactly
$\log_2 V$: 9.97 bits for $V = 1000$, 14.97 for $V = 32000$, and 15.62 for the
50257-token vocabulary of GPT-2 (Radford et al. 2018).

That last number is the scale of the problem a language model faces. A model that
knew nothing would be unable to distinguish more than 15.62 bits per token, and a
model that knew everything would lose nothing. Real text sits between: much of a
token's identity is guessable from context, which is exactly why next-token
prediction is learnable at all.

The tool that makes $\log_2 V$ concrete is perplexity, defined as
$\mathrm{PPL} = 2^{L}$ where $L$ is the average cross-entropy in bits per token. A
loss of 1.88 bits per token is a perplexity of $2^{1.88} = 3.68$. Perplexity is
the standard reported metric because it reads as "effective number of options,"
but it is a strictly monotone transform of the loss and carries no information the
loss does not; it is also comparable across models only under identical
tokenization, which is a caveat
[/en/blog/tokenization-text-to-model-input](/en/blog/tokenization-text-to-model-input)
returns to.

## Cross-entropy: scoring one distribution against another

Entropy needs to know the true distribution. In practice you do not have it —
you have a _model_ distribution $p$ and a data distribution $q$, and the whole
question is how well $p$ describes data drawn from $q$.

The **cross-entropy** is

$$
\mathrm{CE}(q, p) = \mathbb{E}_{x \sim q}[-\log_2 p(x)] = -\sum_{x} q(x)\log_2 p(x).
$$

Read it as "expected surprisal under the model $p$, measured on data from $q$."
Two identities make it immediately useful:

$$
\mathrm{CE}(q, p) = H(q) + D_{KL}(q \| p)
$$

where the **Kullback–Leibler divergence** is

$$
D_{KL}(q \| p) = \sum_{x} q(x) \log_2 \frac{q(x)}{p(x)}.
$$

The decomposition is the important part, because it splits the loss into a term
you cannot improve and one you can. Derive it directly:

$$
\mathrm{CE}(q,p) = -\sum_x q(x)\log_2 p(x)
= -\sum_x q(x)\log_2 q(x) + \sum_x q(x)\log_2 \frac{q(x)}{p(x)}
= H(q) + D_{KL}(q \| p).
$$

So the cross-entropy decomposes into **the irreducible entropy of the data** plus
**the excess cost of using $p$ instead of $q$**. For the true distribution
$q = p$ the divergence is zero and the cross-entropy equals the entropy, which is
the lowest achievable value for that data. This is why cross-entropy can never
go below $H(q)$: no model, however good, beats the information content of the
text itself.

Three properties of $D_{KL}$ matter in practice. It is nonnegative, with equality
iff $q = p$. It is not symmetric: $D_{KL}(q\|p) \neq D_{KL}(p\|q)$ in general. And
it is infinite whenever $p(x) = 0$ where $q(x) > 0$ — assigning zero probability
to something that occurs is a catastrophic, unrecoverable penalty. That last
property is why softmax outputs are never exactly zero and why implementations
clamp or use log-sum-exp.

## A worked example

Take a four-token vocabulary in a single prediction step, with the model's
distribution $p$ and the empirical next-token distribution $q$:

| Token | model $p$ | data $q$ |
| ----- | --------- | -------- |
| 0     | 0.50      | 0.40     |
| 1     | 0.25      | 0.30     |
| 2     | 0.15      | 0.20     |
| 3     | 0.10      | 0.10     |

Here $H(p) = 1.742738$ bits and $H(q) = 1.846439$ bits. The cross-entropy of the
model against the data is

$$
\mathrm{CE}(q,p) = -\left(0.40\log_2 0.50 + 0.30\log_2 0.25
+ 0.20\log_2 0.15 + 0.10\log_2 0.10\right) = 1.879586 \text{ bits},
$$

and the divergence is

$$
D_{KL}(q\|p) = \mathrm{CE}(q,p) - H(q) = 1.879586 - 1.846439 = 0.033147 \text{ bits}.
$$

The token-by-token breakdown is where $D_{KL}$ stops behaving like a distance.
Writing each token's contribution as $q_i \log_2 (q_i / p_i)$, the model
over-assigns token 0 ($p = 0.50 > q = 0.40$), which contributes
$0.400000 - 0.528771 = -0.128771$ bits. That contribution is **negative**, and
the sign is the point: spending more probability on a frequent token leaves less
surprisal to pay for there, so that token alone costs less than the entropy
floor, and the penalty is pushed onto the tokens that were starved. Token 1,
under-assigned, contributes $0.600000 - 0.521090 = +0.078910$ bits, and token 2
contributes $0.547393 - 0.464386 = +0.083007$. Token 3, where $p = q$,
contributes exactly zero.

Only the total is guaranteed non-negative, and here the negatives offset the
positives only partially:
$-0.128771 + 0.078910 + 0.083007 = +0.033147$. That is why a small total can
hide meaningful per-token errors, and why per-token KL is worth inspecting
rather than only the mean.

Compare three models on the same data:

| Model             | Cross-entropy (bits) | Perplexity | $D_{KL}(q\|\cdot)$ |
| ----------------- | -------------------- | ---------- | ------------------ |
| $p = q$ (perfect) | 1.846439             | 3.60       | 0.000000           |
| one token shifted | 1.856780             | 3.62       | 0.010340           |
| uniform over 4    | 2.000000             | 4.00       | 0.153561           |

The uniform model is not much worse than the perfect one on a four-token problem,
which is a useful reminder that perplexity depends on the vocabulary over which it
is measured and cannot be compared across tokenizers.

Every figure in this section is reproduced by the block below, including the three
table rows — the "one token shifted" model is `p = [0.35, 0.35, 0.20, 0.10]`, the
single change from `q` of moving `0.05` of token 0's mass onto token 1.

```python
import numpy as np

q = np.array([0.40, 0.30, 0.20, 0.10])
p = np.array([0.50, 0.25, 0.15, 0.10])


def entropy(a):
    a = np.asarray(a, dtype=float)
    a = a[a > 0]
    return float(-(a * np.log2(a)).sum())


def cross_entropy(model):
    return float(-(q * np.log2(np.asarray(model, dtype=float))).sum())


h_q = entropy(q)
print(f"H(p) = {entropy(p):.6f} bits, H(q) = {h_q:.6f} bits")

for t in range(4):
    self_term = -q[t] * np.log2(q[t])
    model_term = -q[t] * np.log2(p[t])
    # Đóng góp vào KL là CE - H, KHÔNG phải H - CE: đảo lại thì mọi dấu đổi
    # và tổng vẫn ra đúng số nên ví dụ vẫn "chạy được" nhưng nói sai.
    print(f"token {t}: CE {model_term:.6f} - H {self_term:.6f} = "
          f"{model_term - self_term:+.6f} bits")

for name, model in (("p = q (perfect)", q),
                    ("one token shifted", np.array([0.35, 0.35, 0.20, 0.10])),
                    ("uniform over 4", np.full(4, 0.25))):
    ce = cross_entropy(model)
    shown = ", ".join(f"{v:.2f}" for v in model)
    print(f"{name:>18}: p = [{shown}], CE {ce:.6f} bits, "
          f"perplexity {2 ** ce:.2f}, KL {ce - h_q:.6f}")
```

## Why minimizing cross-entropy is maximum likelihood

For $n$ independent observations $x_1, \dots, x_n$ from the true distribution $q$,
the likelihood of the data under a model with parameters $\theta$ is

$$
L(\theta) = \prod_{i=1}^{n} p_{\theta}(x_i),
$$

and the log-likelihood is $\log L(\theta) = \sum_{i=1}^{n} \log p_{\theta}(x_i)$.
Take expectations and divide by $n$:

$$
\frac{1}{n}\sum_{i=1}^{n} \left(-\log p_{\theta}(x_i)\right)
= \mathbb{E}_{q}\left[-\log p_{\theta}(x)\right] = \mathrm{CE}(q, p_{\theta}).
$$

The expected cross-entropy _is_ the expected negative log-likelihood. So
maximizing likelihood and minimizing cross-entropy are the same optimization
problem. This is not a coincidence or a convention — it follows from the
definition of expectation, and it holds for any distribution family.

The finite-sample version has a wrinkle worth naming. The empirical distribution
$\hat{q}$ puts mass $1/n$ on each observed $x_i$ and zero everywhere else, so the
training loss is exactly $\mathrm{CE}(\hat{q}, p_{\theta})$. If any $x_i$ receives
$\hat{p}_{\theta}(x_i) = 0$, the loss is infinite — which is the practical meaning
of the KL divergence being infinite at $p(x)=0$. Numerically stable
implementations compute this as a log-sum-exp over logits rather than
materializing probabilities, for exactly this reason. The stable form is

$$
-\log \sum_j e^{\ell_j - m} + m, \qquad m = \max_j \ell_j
$$

for logits $\ell$ and observed index $j$; subtracting the max leaves the result
unchanged and prevents overflow. Evaluating `np.exp` directly on large logits
produces `nan`, which is a numerical artifact with no statistical meaning.

Two further consequences. First, $\hat{q}$ is a MLE of $q$ (the empirical
distribution assigns probability $1/n$ to each observation, which maximizes the
likelihood of the sample), so minimizing training cross-entropy is literally
maximizing the likelihood of the empirical distribution. Second, the reduction
does **not** give gradients: the expectation is taken over the true $q$, and
training only has samples. That gap between the objective and what you can
compute is what sampling from the model and importance weighting exist to bridge.

## The gradient that makes training work

A final derivation, because it explains why the loss is numerically pleasant.
Let $\ell$ be the logits, $\mathbf{p} = \mathrm{softmax}(\boldsymbol{\ell})$, and
$\mathbf{y}$ the observed one-hot target. The cross-entropy for a single token
collapses, because only the observed term survives:

$$
\mathrm{CE} = -\sum_j y_j \log_2 p_j = -\log_2 p_{y}.
$$

Differentiating with respect to the logits gives the single cleanest equation in
this curriculum:

$$
\frac{\partial \mathrm{CE}}{\partial \ell_j} = p_j - y_j.
$$

The gradient is the model's own probability output, minus the truth — push
probability up where you were wrong, push down where you were right, and the
magnitude is automatically the probability itself. A token predicted with
probability 0.15 contributes a gradient of $+0.85$ on its logit and $-0.15$ on
each other; these sum to zero, so the softmax's shift-invariance is respected and
the update cannot waste capacity moving the whole distribution. For a model with
$\ell = [0.40, 0.30, 0.15, 0.10, 0.05]$ probabilities and the third token observed,
the gradient is $[0.4, 0.3, -0.85, 0.1, 0.05]$. Batching over a sequence is the
same thing summed over positions; the full derivation is in
[/en/blog/loss-functions-what-models-minimize](/en/blog/loss-functions-what-models-minimize).

## What this does not tell you

Cross-entropy is the right objective for the likelihood, and that is precisely its
limit: it optimizes average performance on data drawn from $q$, with no notion of
what the output is _for_. A model can achieve low cross-entropy and still be
useless, unhelpful, or harmful, because likelihood rewards matching a
distribution, not satisfying an intention. That gap is what
[/en/blog/supervised-fine-tuning-instructions](/en/blog/supervised-fine-tuning-instructions)
and
[/en/blog/preference-optimization-rlhf-and-dpo](/en/blog/preference-optimization-rlhf-and-dpo)
address.

Three more limits worth naming. Cross-entropy is an _average_ over tokens, so a
model can reduce it by improving frequent tokens and ignoring rare ones, which
compounds with data imbalance. KL divergence is not a metric: it is not symmetric,
violates the triangle inequality, and adding a constant to it is meaningless.
And because $D_{KL}$ is infinite outside the support of $p$, it cannot be used as
an objective for distribution _search_ where proposals leave the support — which
is why sampling-based search uses smoothed divergences such as
$J$-divergence instead.

Finally, the entropy $H(q)$ floor is a real constraint on evaluation. A
perplexity of 3.6 on the four-token example is not "better" than a perplexity of
10 on real text; the numbers are only comparable when the tokenizer, the data,
and the task match.

## References

- Claude E. Shannon. "A Mathematical Theory of Communication." _Bell System
  Technical Journal_, 1948 — the original development of entropy and information.
- Alec Radford, Karthik Narasimhan, Tim Salimans, Ilya Sutskever. "Improving
  Language Understanding by Generative Pre-Training." 2018 — the GPT report; the
  50257-token vocabulary quoted above is from the released GPT-2 model.
- "Sequence to Sequence Learning with Neural Networks." Ilya Sutskever, Oriol
  Vinyals, Quoc V. Le. NeurIPS 2014 — connects sequence likelihood training to
  negative log-likelihood objectives in practice.
- SciPy documentation,
  [`scipy.special.logsumexp`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.special.logsumexp.html)
  — the numerically stable reduction described above.
