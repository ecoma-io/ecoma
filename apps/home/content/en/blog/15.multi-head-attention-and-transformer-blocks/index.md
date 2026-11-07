---
title: 'Multi-head attention and transformer blocks'
description: 'Residual connections, normalization placement, feed-forward layers, and the complete anatomy of one transformer block.'
date: '2026-09-28'
author: 'John Martin'
tags:
  - language-modeling
  - ai
featured: false
cover: ../../../assets/cover-15-multi-head-attention-and-transformer-blocks.svg
coverAlt: 'Abstract layer stack motif on a light background beside the lesson title'
articleId: multi-head-attention-and-transformer-blocks
seriesId: language-modeling
seriesOrder: 5
contentType: theory
level: intermediate
prerequisites:
  - attention-from-first-principles
relatedArticleIds:
  - training-a-transformer
  - kv-cache-memory-of-long-contexts
---

# Multi-head attention and transformer blocks

Attention alone is not a network. A transformer block is attention plus three things that decide whether gradient descent can actually train it through dozens of layers: a residual path, a normalization, and a nonlinear feed-forward layer. The parameter budget, meanwhile, is dominated by a term that has nothing to do with attention at all.

This lesson assembles the full block and, more usefully, computes it. After reading it you should be able to write out one block in full, explain what each component buys, state where normalization can be placed and what that choice costs, and do the parameter arithmetic for a real model.

## Why one head is not enough

A single attention head computes one distribution over positions: for each query, one set of weights. That forces a single compromise. A token that needs to resolve "the cat sat on the" needs to look far back for the subject and nearby for the verb, and one dot product in $d_k$ dimensions has to serve both.

**Multi-head attention** runs $h$ independent heads, each with its own projections $W_Q^{(a)}$, $W_K^{(a)}$, $W_V^{(a)}$ into a smaller subspace of dimension $d_k$, where $h \cdot d_k = d_{model}$. Their outputs are concatenated and mixed back:

$$
\mathrm{MultiHead}(X) = \mathrm{Concat}(\text{head}_1, \ldots, \text{head}_h)\, W_O
$$

Each head can specialise, and empirically some do attend to syntax while others track coreference or recent tokens. With the same keys and two different queries, the two heads distribute weight differently:

```python
import numpy as np

kA = np.array([[1.0, 0.0], [0.0, 1.0], [0.7, 0.7]])


def probs(q, K):
    s = K @ q / np.sqrt(len(q))
    s = s - s.max()
    e = np.exp(s)
    return e / e.sum()


print(probs(np.array([1.0, 0.0]), kA))   # head 1
print(probs(np.array([0.0, 1.0]), kA))   # head 2
```

Head 1 puts 0.434419 on the first key; head 2 puts 0.434419 on the second. A single head would have had to average these into one compromise.

One arithmetic point is worth stating because it is often misreported. Splitting into $h$ heads of dimension $d_k = d_{model}/h$ does **not** save parameters: the four projections total $4 d_{model} d_{model}$ either way. At $d_{model} = 768$ with 12 heads, each projection is $768 \times 64$, and there are 12 of them per projection type, giving $12 \times 49152 = 589824$ per type, or $2359296$ for all four — exactly $4 \times 768^2$. Heads change the _shape_ of the computation, not its parameter count.

## Residuals make depth trainable

A residual connection adds a sublayer's input to its output:

$$
\mathbf{y} = \mathbf{x} + \mathrm{Sublayer}(\mathbf{x})
$$

The motivation is gradient flow. A deep stack of nonlinear layers multiplies Jacobians together, and the gradient of a loss with respect to an early input is a product of many terms, which shrinks or explodes as depth grows. The additive path gives the gradient a route that bypasses every sublayer: the derivative of $\mathbf{x} + \mathrm{Sublayer}(\mathbf{x})$ with respect to $\mathbf{x}$ contains an identity term, so a gradient can propagate through a very deep stack without decaying through each nonlinearity. He and colleagues established this empirically for deep convolutional networks, and the transformer adopted it as a core component.

A worked residual and normalization, on a single vector of dimension 4:

```python
import numpy as np

x = np.array([1.0, 2.0, 3.0, 4.0])
sublayer_out = np.array([0.5, -1.0, 2.0, 0.25])
resid = x + sublayer_out          # [1.5, 1.0, 5.0, 4.25]

mean = resid.mean()               # 2.9375
var = resid.var()                 # biased: divide by d_model, not d_model - 1
z = (resid - mean) / np.sqrt(var + 1e-5)
print(z)                          # [-0.837054 -1.128204  1.200991  0.764267]
```

The residual sum is $[1.5, 1.0, 5.0, 4.25]$. **LayerNorm** then subtracts the mean, divides by the standard deviation, and applies a learned scale and shift, $\gamma$ and $\beta$, that let the layer undo the normalization when useful:

$$
\mathrm{LayerNorm}(\mathbf{x}) = \gamma \odot \frac{\mathbf{x} - \mu}{\sqrt{\sigma^2 + \epsilon}} + \beta
$$

The result has mean $+2.78 \times 10^{-17}$ and variance $0.999997$, both zero and one to floating-point precision. That invariance is the point: normalize a vector scaled by 1000 and you get essentially the same output, $[-0.169031, 1.183216, -1.521278, 0.507093]$ versus $[-0.169029, 1.183205, -1.521264, 0.507088]$ at scale 1. The layer discards the magnitude and keeps the direction, which is why it keeps activations in a usable range as depth grows.

Two details deserve precision. The variance is the biased one, dividing by $d_{model}$ rather than $d_{model} - 1$, which is the usual formulation. And normalized coordinates are bounded: a zero-mean unit-variance vector of length $d_{model}$ satisfies $|z_i| \le \sqrt{d_{model} - 1}$, here $\sqrt{3} = 1.732051$, which the largest coordinate $1.200991$ respects.

## Post-LN and pre-LN, and why it matters

Where the normalization sits relative to the residual is a real architectural choice, not a formatting detail.

**Post-LN**, as in the original paper, normalizes after the residual add: $\mathbf{y} = \mathrm{LayerNorm}(\mathbf{x} + \mathrm{Sublayer}(\mathbf{x}))$.

**Pre-LN** moves it before, wrapping the sublayer instead: $\mathbf{y} = \mathbf{x} + \mathrm{Sublayer}(\mathrm{LayerNorm}(\mathbf{x}))$.

The difference is the gradient path. In pre-LN the residual stream carries an unbroken identity from input to output, so the derivative has a term that is exactly the identity at every layer and does not depend on the sublayers' parameters. In post-LN the normalization sits inside the differentiated path and there is no such clean route.

Empirically this shows up as an optimisation difference: post-LN models need careful warmup and can be unstable at large learning rates, while pre-LN trains stably from the start. The cost of pre-LN is representational rather than numerical — information passes along the stream without being renormalized, so the final normalization at the top of the stack matters more. Most large decoder-only models use pre-LN, and one variant, normalizing the residual stream only at the very end, is also common.

## The feed-forward layer

Attention moves information _between_ positions; it computes the same function at every position. The **feed-forward network** adds the per-position computation that attention cannot, and it is applied identically and independently to each position:

$$
\mathrm{FFN}(\mathbf{x}) = W_2 \,\sigma(W_1 \mathbf{x} + \mathbf{b}_1) + \mathbf{b}_2
$$

with $W_1$ of shape $d_{ff} \times d_{model}$, $W_2$ of shape $d_{model} \times d_{ff}$, and $\sigma$ a pointwise nonlinearity. The original paper used a rectified linear unit; smooth variants are now more common. The expansion to $d_{ff} = 4 d_{model}$ and back is what gives the block its capacity, and it is where most of the parameters live.

## One block, assembled

Putting it together, a pre-LN decoder block is:

$$
\mathbf{u} = \mathrm{LayerNorm}_1(\mathbf{x}), \qquad \mathbf{x}' = \mathbf{x} + \mathrm{MultiHead}(\mathbf{u})
$$

$$
\mathbf{v} = \mathrm{LayerNorm}_2(\mathbf{x}'), \qquad \mathbf{x}'' = \mathbf{x}' + \mathrm{FFN}(\mathbf{v})
$$

Two sublayers, two normalizations, two residual adds, and a causal mask inside the attention. A full decoder-only model stacks $L$ of these, adds a token embedding and a position encoding at the input, applies a final layer norm, and projects to vocabulary logits. A bidirectional encoder such as BERT replaces the causal mask with a full attention pattern, allowing every position to attend to every other.

## Where the parameters actually go

Now the arithmetic, which is the part most descriptions get wrong. For one block, weights only:

- attention projections: $4 d_{model}^2$
- feed-forward: $2 \cdot d_{model} \cdot d_{ff}$
- two layer norms: $4 d_{model}$

With $d_{ff} = 4 d_{model}$, the feed-forward term is $8 d_{model}^2$ against attention's $4 d_{model}^2$. **The feed-forward network holds twice the parameters of attention.** The MLP is the dominant term, not the mechanism the field usually talks about.

The two tables below include the bias terms those three formulas omit — $4 d_{model}$ for the four attention projections and $d_{ff} + d_{model}$ for the feed-forward — because a real block has them. They are negligible at these widths, which is the point of showing both: every share in the right-hand column is unchanged to one decimal place whether you count them or not.

| block configuration              | attention  | feed-forward | layer norms | block total | MLP share |
| -------------------------------- | ---------- | ------------ | ----------- | ----------- | --------- |
| $d_{model}=512$, $d_{ff}=2048$   | 1,050,624  | 2,099,712    | 2,048       | 3,152,384   | 66.6%     |
| $d_{model}=768$, $d_{ff}=3072$   | 2,362,368  | 4,722,432    | 3,072       | 7,087,872   | 66.6%     |
| $d_{model}=4096$, $d_{ff}=16384$ | 67,125,248 | 134,238,208  | 16,384      | 201,379,840 | 66.7%     |

And the share moves directly with the expansion ratio. At $d_{model} = 4096$:

| $d_{ff}$                      | MLP parameters | share of block |
| ----------------------------- | -------------- | -------------- |
| $1 \times d_{model} = 4096$   | 33,562,624     | 33.3%          |
| $2 \times d_{model} = 8192$   | 67,121,152     | 50.0%          |
| $4 \times d_{model} = 16384$  | 134,238,208    | 66.7%          |
| $8 \times d_{model} = 32768$  | 268,472,320    | 80.0%          |
| $16 \times d_{model} = 65536$ | 536,940,544    | 88.9%          |

The check that this is not a bookkeeping artifact: a 12-layer model with $d_{model} = 768$, $d_{ff} = 3072$, vocabulary 50257 and 1024 learned position embeddings sums to **124,441,344**, or 124.44M, against a published figure of 124M. The same arithmetic at GPT-3's published shape — 96 layers, $d_{model} = 12288$, $d_{ff} = 49152$ — gives 174.59B against a published 175B. The formulas reproduce published parameter counts from published shapes, and the rounding in the published figures is the only thing that differs.

## What the anatomy does not settle

Several things about this structure are empirical rather than derived, and the differences are not large. There is no proof that $d_{ff} = 4 d_{model}$ is optimal; it is a convention, and the sweep above shows the block's composition is a free choice with real consequences. Attention heads learn different roles, but which roles any given head takes is an outcome, not a design. Post-LN versus pre-LN changes optimisation behaviour rather than expressiveness. And nothing in the block forces a model to store facts reliably, which is the limit discussed in [language modeling](/en/blog/language-modeling-next-token-prediction).

What the block does guarantee is that a deep stack of them is trainable: the residual path keeps gradients alive, normalization keeps activations in range, and the feed-forward layer supplies per-position capacity. Everything else in modern architecture is a variation on that skeleton.

## References

- Vaswani et al., "Attention Is All You Need", NeurIPS 2017, arXiv:1706.03762.
- He, Zhang, Ren and Sun, "Deep Residual Learning for Image Recognition", CVPR 2016, arXiv:1512.03385.
- Devlin et al., "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", NAACL 2019, arXiv:1810.04805.
