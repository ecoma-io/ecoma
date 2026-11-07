---
title: 'Positional information: how transformers represent order'
description: 'Attention is permutation-invariant, so order has to enter somewhere. Compare learned, sinusoidal and rotary encodings.'
date: '2026-09-26'
author: 'John Martin'
tags:
  - language-modeling
  - ai
featured: false
cover: ../../../assets/cover-13-positional-information-in-transformers.svg
coverAlt: 'Abstract sine wave motif on a light background beside the lesson title'
articleId: positional-information-in-transformers
seriesId: language-modeling
seriesOrder: 3
contentType: theory
level: intermediate
prerequisites:
  - linear-algebra-projections-and-rank
relatedArticleIds:
  - attention-from-first-principles
  - multi-head-attention-and-transformer-blocks
---

# Positional information: how transformers represent order

"The dog chased the cat" and "the cat chased the dog" contain the same words in the same quantities. Every language model that scores them identically has learned nothing about which word came first. The reason is structural rather than a bug: attention, taken on its own, cannot tell the difference, and something has to be added deliberately.

This is the one design decision in the transformer that is not forced by the mathematics. Everything else follows from wanting an efficient, parallel, differentiable mechanism for conditional probability. Order has to be _installed_. After this lesson you should be able to demonstrate the failure numerically, explain what each of the three standard families of positional encoding contributes, and predict which family a given model uses from its configuration.

## Why attention alone cannot see order

Let $X$ be the input matrix of shape $S \times d$, where $S$ is sequence length and $d$ the model dimension, and let $\Pi$ be a permutation matrix that reorders its rows. Attention computes, for each row $i$, a weighted sum over rows $j$, with weights $a_{ij}$ that depend only on row $i$ and row $j$ jointly.

The essential property is that the score for the pair $(i, j)$ is the same function of the two rows no matter where they sit in the matrix. Reordering the rows of $X$ reorders the rows and columns of the score matrix together, so each output row becomes the same weighted combination as before, just relocated. Formally, with $A$ the attention operator:

$$
A(\Pi X) = \Pi A(X)
$$

This is **permutation equivariance**: the output is permuted exactly as the input was. The precise term matters, because it is easy to state the stronger and wrong claim. Permuting the input does _not_ leave the output unchanged as a matrix — row $i$ does not stay row $i$. What is unchanged, and what actually matters, is the output as a _multiset_. Reordering a sentence's tokens changes nothing an order-blind model can see.

Here is the demonstration, with real numbers:

```python
import numpy as np

rng = np.random.default_rng(0)
S, d = 4, 8
X = rng.standard_normal((S, d))
Wq, Wk, Wv = (rng.standard_normal((d, d)) for _ in range(3))


def attention(X):
    Q, K, V = X @ Wq, X @ Wk, X @ Wv
    s = Q @ K.T / np.sqrt(d)
    s -= s.max(axis=-1, keepdims=True)
    p = np.exp(s)
    p /= p.sum(axis=-1, keepdims=True)
    return p @ V


def bag(M):
    """An order-free summary of a matrix: its rows, sorted."""
    return np.sort(M, axis=0)


Xswap = X[[1, 0, 2, 3]]          # swap the first two tokens
print(np.allclose(attention(Xswap), bag(attention(X))))   # False: rows move
print(np.array_equal(bag(attention(Xswap)), bag(attention(X))))  # True: the bag is identical
```

Both assertions hold exactly. The first confirms rows are rearranged; the second confirms that after sorting rows to discard position, the two results are bit-identical. The multiset of output vectors does not depend on token order at all, so the model cannot compute anything order-dependent from this layer alone.

## Learned absolute embeddings

The simplest fix is to give every position its own learned vector, and add it to the token embedding before the first layer. This is what the original transformer did:

$$
X_t = E[\text{token}_t] + P[t]
$$

where $E$ is the token embedding table and $P$ is a learned matrix of shape (max sequence length) $\times d$.

This works and it is simple, but it has three structural limits worth naming. The table is _bounded_: positions beyond the trained maximum do not exist, which is why models with learned absolute positions were the first to be hard to extend at inference time. It is _absolute_: the vector at position 5 is a different learned object from the vector at position 6, and nothing forces the model to treat near positions alike. And it is a per-position lookup, so the model must learn every position it will ever see, which spends parameters on positions that occur rarely.

## Sinusoidal encodings

The alternative is to _compute_ the position vector from a formula instead of learning it. The original paper defined, for position $t$ and dimension index $i$:

$$
P[t, 2i] = \sin\left(\frac{t}{\sqrt{d / 2i}}\right), \qquad
P[t, 2i+1] = \cos\left(\frac{t}{\sqrt{d / 2i}}\right)
$$

Each pair of dimensions is a sinusoid in position with a wavelength that grows geometrically across dimensions. Short wavelengths encode fine position, long wavelengths coarse position, so one vector carries many scales at once.

The property that makes this more than a trick is a relative-position identity. For any offset $n$ and any base position $m$, the inner product depends only on the difference $n - m$, not on $m$ or $n$ separately. The frequencies are what makes this true: products of sinusoids at different frequencies expand into sums and differences of frequencies, and the cross terms cancel by orthogonality, leaving only the difference.

```python
def sinusoids(positions, d, base=10000.0):
    out = np.zeros((len(positions), d))
    for i, p in enumerate(positions):
        for j in range(d // 2):
            f = 1.0 / (base ** (2 * j / d))
            out[i, 2 * j] = np.sin(p * f)
            out[i, 2 * j + 1] = np.cos(p * f)
    return out


P = sinusoids(np.arange(4), 8)
print(P @ P.T)                              # entry (i,j) depends only on i-j
print([P[m + 2] @ P[m] for m in range(2)])  # fixed offset 2: identical for every m
```

The printed Gram matrix is symmetric with constant diagonals and entries that depend only on $i - j$, which is what "Toeplitz" means. For offset 2 both starting positions give $2.563718$, and for offset 1 all three give $3.535256$. A model reading these values can compute a function of relative distance without ever being told an absolute position.

The honest caveat: sinusoidal encodings have no learned parameters, so they are _not_ free of trade-offs. They extrapolate gracefully to unseen lengths, which was their motivation, but in practice learned absolute embeddings performed comparably at comparable scale, and several production models adopted them.

## Rotary position embedding

Rotary position embedding (RoPE), introduced by Su and colleagues in the RoFormer work, takes the relative-position identity and installs it _where it is used_. The insight: instead of adding a position vector to the input, rotate the query and key vectors by an angle proportional to their absolute position, and the dot product between them then depends only on the relative offset.

In two dimensions, rotating a vector by angle $\theta$ is:

$$
R(\theta) = \begin{bmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{bmatrix}
$$

RoPE applies a block-diagonal rotation across pairs of dimensions, so the dimension is treated as $d_k/2$ independent two-dimensional rotations. With $\theta_i$ the frequency for pair $i$, the rotation angle at position $t$ is $t\theta_i$, and the same base frequencies used in the sinusoidal construction appear here.

The identity that makes it work is that rotations compose and, critically, $R(m)$ followed by $R(n)$ equals $R(m+n)$. So for query at position $m$ and key at position $n$:

$$
(R(m\mathbf{q})^\top \cdot R(n\mathbf{k})) = \mathbf{q}^\top R(n-m) \mathbf{k}
$$

The right-hand side involves only $n - m$. The absolute positions cancel. And because it is a rotation, it preserves the norm of every vector, so nothing about the representation's scale is disturbed.

```python
def rope(v, pos, theta):
    c, s = np.cos(pos * theta), np.sin(pos * theta)
    return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1]])


q, k = np.array([1.0, 0.0]), np.array([1.0, 0.0])
for offset in (1, 2, 3, 4):
    vals = [rope(q, m, 1.0) @ rope(k, m + offset, 1.0) for m in (0, 3, 7, 11)]
    print(offset, vals, np.allclose(vals, np.cos(offset)))
```

Every row prints the same number across four widely separated starting positions, and each equals $\cos(\text{offset})$. The unrotated control gives $q^\top k = 1.0$ for _every_ pair of positions, which is the whole problem restated: without rotation, the score is flat in position and carries no positional information whatsoever.

With nontrivial vectors the same cancellation holds, and the closed form is:

$$
\mathbf{q}^\top R(n-m) \mathbf{k}
= \cos(n-m)\,(\mathbf{q}^\top\mathbf{k}) - \sin(n-m)\,(q_1 k_2 - q_2 k_1)
$$

Computed over starting positions 0, 4 and 11, offset 1 gives $-0.2119276722$ at all three, offset 2 gives $0.0373875492$, and offset 3 gives $0.2523288303$, matching the closed form exactly.

## What each family buys, and what it costs

The three approaches are not simply ranked. They differ in where position enters and therefore in what they can express:

| family           | where position enters     | bounded?           | encodes relative distance directly? |
| ---------------- | ------------------------- | ------------------ | ----------------------------------- |
| learned absolute | added to input embeddings | yes, by table size | no                                  |
| sinusoidal       | added to input embeddings | no                 | yes, via inner products             |
| rotary           | rotates queries and keys  | no                 | yes, in the score itself            |

Learned absolute embeddings are the simplest and were competitive at the scale they were introduced. Sinusoidal encodings remove the parameter cost and the length limit but add no expressiveness. Rotary encoding puts position where the computation happens, so the relative offset is available exactly where it is needed and no distance-bucketing machinery is required.

One claim deserves care because it is often repeated loosely: that rotary encodings extrapolate better than absolute embeddings to positions longer than those seen in training. The relative-offset identity makes extrapolation _possible_, and long-context models do use rotary encodings. But whether a model actually extrapolates also depends on how its attention was trained and on the inference-time machinery around it. The identity guarantees the representation is well-defined at unseen positions; it does not by itself guarantee the model's behaviour there.

## Why this is not the whole story

Positional encoding supplies the ingredient. It does not guarantee that the model uses it, and three real failure modes persist.

Attention scores are computed in a space shared with content, so relative position must compete with token identity for the same dimensions. Some heads learn to specialise on positional patterns and others do not, and the mixture is an empirical outcome rather than a design.

Longer distances are harder because the score matrix is dense and a single attention head averages over many positions. Nothing in the positional encoding guarantees that information from position 3 is still available at position 3000.

And position interacts with the training objective. Because a causal mask already restricts attention to the left context, an autoregressive model only ever needs relative offsets that are positive, which is a weaker requirement than the general case and one that the relative-position encoding satisfies naturally.

## References

- Vaswani et al., "Attention Is All You Need", NeurIPS 2017, arXiv:1706.03762.
- Shaw, Uszkoreit and Vaswani, "Self-Attention with Relative Position Representations", NAACL 2018.
- Su et al., "RoFormer: Enhanced Transformer with Rotary Position Embedding", 2021.
