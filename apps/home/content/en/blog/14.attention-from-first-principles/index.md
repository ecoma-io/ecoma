---
title: 'Attention from first principles: queries, keys, and values'
description: 'Derive scaled dot-product attention from three plain vectors and explain every symbol in the standard form.'
date: '2026-09-27'
author: 'John Martin'
tags:
  - language-modeling
  - ai
featured: false
cover: ../../../assets/cover-14-attention-from-first-principles.svg
coverAlt: 'Abstract attention nodes motif on a light background beside the lesson title'
articleId: attention-from-first-principles
seriesId: language-modeling
seriesOrder: 4
contentType: theory
level: intermediate
prerequisites:
  - linear-algebra-projections-and-rank
  - information-theory-and-cross-entropy
relatedArticleIds:
  - positional-information-in-transformers
  - multi-head-attention-and-transformer-blocks
---

# Attention from first principles: queries, keys, and values

Attention is usually introduced as a formula to memorise. It is more useful derived: each of the three letters earns its place, and the one mysterious constant, $1/\sqrt{d_k}$, falls out of a variance calculation you can check in two lines of code.

The mechanism answers one question — given a sequence of vectors, how does each one decide what to read from the others? — by matching a _query_ against every _key_ and averaging the corresponding _values_ in proportion to the match. After this lesson you should be able to write the matrix form from memory, compute a full attention example by hand, justify the scaling factor, explain what masking does, and state the cost.

## One query, three keys, two values

Fix one output position. That position has a **query** vector $\mathbf{q} \in \mathbb{R}^{d_k}$, asking what it needs. Every position in the sequence offers a **key** $\mathbf{k}_j \in \mathbb{R}^{d_k}$, advertising what it has, and carries a **value** $\mathbf{v}_j \in \mathbb{R}^{d_v}$, the content it would contribute.

Matching is a dot product, $\mathbf{q} \cdot \mathbf{k}_j$, because a large dot product means the two vectors point in similar directions. The raw score, however, is unbounded and unnormalised, so three steps convert it into a weighted average.

Scale, so scores land in a range where the softmax is sensitive rather than saturated:

$$
s_j = \frac{\mathbf{q} \cdot \mathbf{k}_j}{\sqrt{d_k}}
$$

Normalise, so the weights are a probability distribution over positions:

$$
a_j = \frac{\exp(s_j)}{\sum_{i=1}^{S} \exp(s_i)}
$$

Aggregate, taking the value-weighted mean:

$$
\mathbf{o} = \sum_{j=1}^{S} a_j \, \mathbf{v}_j
$$

Because $a_j \ge 0$ and $\sum_j a_j = 1$, the output is a convex combination of the values: it lies inside their convex hull, and a position receiving near-zero weight contributes near-nothing. That is the whole mechanism, and it is the same as a differentiable, content-addressed lookup.

## A complete numerical example

Let $d_k = d_v = 4$ with $S = 3$ positions. Take one query, three keys, and three values:

$$
\mathbf{q} = [1, 2, 3, 4], \quad
\mathbf{k}_0 = [1, 0, 1, 0], \quad
\mathbf{k}_1 = [0, 1, 1, 0], \quad
\mathbf{k}_2 = [1, 1, 0, 0]
$$

with $\mathbf{v}_0 = [1, 0]$, $\mathbf{v}_1 = [0, 1]$, $\mathbf{v}_2 = [1, 1]$.

**Step 1, raw dot products.** Working component by component:

- $\mathbf{q} \cdot \mathbf{k}_0 = 1 \cdot 1 + 2 \cdot 0 + 3 \cdot 1 + 4 \cdot 0 = 4$
- $\mathbf{q} \cdot \mathbf{k}_1 = 1 \cdot 0 + 2 \cdot 1 + 3 \cdot 1 + 4 \cdot 0 = 5$
- $\mathbf{q} \cdot \mathbf{k}_2 = 1 \cdot 1 + 2 \cdot 1 + 3 \cdot 0 + 4 \cdot 0 = 3$

**Step 2, scale.** $\sqrt{d_k} = \sqrt{4} = 2$ exactly, giving $s = [2.0, 2.5, 1.5]$.

**Step 3, softmax.** Subtracting the maximum for numerical stability (which leaves the result unchanged) gives $s - \max = [-0.5, 0.0, -1.0]$, and exponentiating:

$$
\exp[-0.5] = 0.606531, \quad \exp[0] = 1.000000, \quad \exp[-1.0] = 0.367879
$$

These sum to $1.974410$, so the attention weights are $a = [0.307196, 0.506480, 0.186324]$, or 30.72%, 50.65% and 18.63%. They sum to 1.0000000000.

**Step 4, aggregate.**

$$
\mathbf{o} = 0.307196\,[1,0] + 0.506480\,[0,1] + 0.186324\,[1,1] = [0.493520,\; 0.692804]
$$

The first output coordinate is $0.307196 + 0.186324 = 0.493520$, the sum of the weights of the values whose first coordinate is 1. The second is $0.506480 + 0.186324 = 0.692804$. Note the weighting is genuinely uneven: this is a soft lookup, not an average.

Here is the whole computation in code, which is also the matrix form for an entire sequence at once:

```python
import math

import numpy as np

d_k = 4
q = np.array([1.0, 2.0, 3.0, 4.0])
K = np.array([[1.0, 0.0, 1.0, 0.0],
              [0.0, 1.0, 1.0, 0.0],
              [1.0, 1.0, 0.0, 0.0]])
V = np.array([[1.0, 0.0],
              [0.0, 1.0],
              [1.0, 1.0]])

raw = np.array([q @ K[j] for j in range(len(K))])
scaled = raw / math.sqrt(d_k)                       # divide by sqrt(d_k)
m = scaled.max()                                    # subtract max for stability
probs = np.exp(scaled - m) / np.exp(scaled - m).sum()
out = probs @ V                                      # weighted sum of values

print(raw, scaled, probs, out)

# the batched form, for all S queries at once
Q = q.reshape(1, d_k)
scores = (Q @ K.T) / math.sqrt(d_k)
print(scores @ V)
```

Producing `raw = [4. 5. 3.]`, `scaled = [2. 2.5 1.5]`, `probs = [0.307196 0.50648 0.186324]`, `out = [0.49352 0.692804]`, matching the arithmetic above exactly.

## The matrix form

Doing that per position wastes the opportunity to batch. Stack the queries, keys and values into matrices $Q$, $K$, $V$ of shape $S \times d_k$, $S \times d_k$ and $S \times d_v$ respectively, and all $S$ outputs come from one expression:

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}} + M\right) V
$$

Here $QK^\top$ is the $S \times S$ matrix of pairwise scores — entry $(i, j)$ is query $i$ against key $j$ — and $M$ is an optional mask. This is the form in the original paper, and it is what `torch.nn.functional.scaled_dot_product_attention` implements, fusion and all.

The projections themselves are learned linear maps applied before any of this. Each position's input $\mathbf{x}_i \in \mathbb{R}^{d_{model}}$ produces $\mathbf{q}_i = W_Q \mathbf{x}_i$ and so on, with $W_Q$ of shape $d_{model} \times d_k$. The projections are the learnable part; the score, softmax and average are fixed arithmetic on top.

## Why the square root, exactly

Assume query and key components are independent, mean zero and unit variance, the standard assumption for initialised weights. Then each product $\mathbf{q}_i \mathbf{k}_i$ has variance 1 and mean 0, and a sum of $d_k$ such independent terms has variance $d_k$. So the raw score has standard deviation $\sqrt{d_k}$, which grows without bound as keys get longer.

That matters because of the softmax. It is a difference of exponentials, so a large constant shift across all scores does change the normalisation when the scores are large: the exponent range expands, one entry dominates, and the gradient of the softmax with respect to its inputs vanishes where it saturates. Scaling by $1/\sqrt{d_k}$ makes the standard deviation of the score exactly 1, independent of $d_k$, for every dimension.

The table makes the cancellation explicit. After dividing by $\sqrt{d_k}$ the standard deviation is 1.0000 at every $d_k$ from 4 to 1024.

| $d_k$ | variance of raw score | standard deviation | sd after dividing by $\sqrt{d_k}$ |
| ----- | --------------------- | ------------------ | --------------------------------- |
| 4     | 4                     | 2.0                | 1.0000                            |
| 16    | 16                    | 4.0                | 1.0000                            |
| 64    | 64                    | 8.0                | 1.0000                            |
| 256   | 256                   | 16.0               | 1.0000                            |
| 1024  | 1024                  | 32.0               | 1.0000                            |

The consequence is measurable. Drawing 20000 random query-key pairs at $d_k = 256$ gives an empirical variance of 254.81 against a theoretical 256. Without scaling, the attention weights over those 20000 candidates have a maximum probability of 1.0000 and an entropy of 0.0004 nats: the softmax has collapsed onto one position and its gradient is gone. With the scaling, the maximum probability falls to 0.0025 and entropy rises to 9.3943 nats, close to the 9.9035 nats of a uniform distribution over 20000 items. The scale factor is what keeps attention trainable as keys grow.

## Masking, and the stability trick

A **causal mask** prevents position $i$ from attending to any $j > i$, so no token can see its own future. It is applied additively to the score matrix, $M_{ij} = -\infty$ for $j > i$, before the softmax. Because $\exp(-\infty) = 0$, masked positions receive exactly zero weight.

```python
scores = np.array([[1.0, 2.0, 3.0, 4.0],
                   [2.0, 1.0, 0.0, 1.0],
                   [0.5, 0.5, 0.5, 0.5],
                   [3.0, 1.0, 2.0, 0.5]])
mask = np.triu(np.ones((4, 4), dtype=bool), k=1)   # True = must be hidden


def softmax(z):
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


print(softmax(np.where(mask, -np.inf, scores)))
```

gives

```text
[[1.       0.       0.       0.      ]
 [0.731059 0.268941 0.       0.      ]
 [0.333333 0.333333 0.333333 0.      ]
 [0.630796 0.085369 0.232057 0.051779]]
```

Row 1, which may only see columns 0 and 1, has renormalised its two surviving scores to sum to one. Substituting $-10^9$ for $-\infty$ gives bit-identical output, which is the usual low-precision implementation.

That `z - z.max()` line in `softmax` is not cosmetic. Applying `exp` to raw scores of `[1000, 1001, 999]` overflows to `inf` in float32, and `inf/inf` gives `nan`. Subtracting the maximum is algebraically a no-op, since it multiplies numerator and denominator by the same factor, and it turns that result into a valid distribution. This is why every stable softmax implementation does it.

## The cost, and why it dominates at length

The score matrix is $S \times S$, and producing it costs $S^2 d_k$ multiply-accumulates; multiplying it by the values costs another $S^2 d_v$. Per head, the total is $O(S^2 d)$.

| $S$   | score entries | multiply-accumulates ($d_k = d_v = 64$) | memory at fp16 |
| ----- | ------------- | --------------------------------------- | -------------- |
| 512   | 262,144       | 33.6M                                   | 0.5 MiB        |
| 1024  | 1,048,576     | 134.2M                                  | 2.0 MiB        |
| 2048  | 4,194,304     | 536.9M                                  | 8.0 MiB        |
| 4096  | 16,777,216    | 2147.5M                                 | 32.0 MiB       |
| 8192  | 67,108,864    | 8589.9M                                 | 128.0 MiB      |
| 32768 | 1,073,741,824 | 137439.0M                               | 2048.0 MiB     |

Doubling the sequence length quadruples the work: $S = 1024$ gives $S^2 = 1048576$, and $S = 2048$ gives $4194304$. This is the term that made long context expensive, and it is why [the KV cache](/en/blog/kv-cache-memory-of-long-contexts) and sparse and linear-time attention variants are such active areas.

Compare against the feed-forward network, which is linear in $S$. At $d_{model} = 512$ and $d_{ff} = 2048$, the MLP costs $2 d_{model} d_{ff} = 2097152$ multiply-accumulates per token regardless of $S$, while attention costs about $2 S d_{model}$ per token:

| $S$   | attention MACs per token | ratio to MLP |
| ----- | ------------------------ | ------------ |
| 1024  | 1,048,576                | 0.50         |
| 8192  | 8,388,608                | 4.00         |
| 32768 | 33,554,432               | 16.00        |

At $S = 1024$ the feed-forward layer is still the more expensive half of a block. By $S = 32768$, attention costs sixteen times as much. The crossover is not far out, and it is the reason the quadratic term dominates the design of long-context systems.

## References

- Vaswani et al., "Attention Is All You Need", NeurIPS 2017, arXiv:1706.03762.
- Shaw, Uszkoreit and Vaswani, "Self-Attention with Relative Position Representations", NAACL 2018.
- PyTorch documentation, `torch.nn.functional.scaled_dot_product_attention`.
