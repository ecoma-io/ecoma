---
title: 'Vectors, matrices, and tensors: the language of machine learning'
description: 'The linear-algebra objects every layer is built from, and how to read the shapes that flow through a model.'
date: '2026-09-14'
author: 'John Martin'
tags:
  - mathematics
  - ai
featured: true
cover: ../../../assets/cover-01-vectors-matrices-and-tensors.svg
coverAlt: 'Abstract grid matrix motif on a light background beside the lesson title'
articleId: vectors-matrices-and-tensors
seriesId: mathematical-foundations
seriesOrder: 1
contentType: theory
level: foundational
relatedArticleIds:
  - linear-algebra-projections-and-rank
  - probability-and-statistics-for-ml
---

# Vectors, matrices, and tensors: the language of machine learning

Every layer in a neural network is a shape-preserving rearrangement of the same
three objects. Once you can predict what a tensor's shape will be before you
write the code that produces it, most model bugs stop being mysterious: a
broadcasting error, an off-by-one in an axis, a reshape that silently mixes the
batch index with the sequence index.

This lesson builds that vocabulary from scratch. By the end you should be able to
read the shape annotation on a layer, trace shapes forward through a stack of
layers and a batch dimension, compute a matrix product and a matrix-vector
product by hand, and say what the transpose actually does without hand-waving
about "flipping axes".

## Three objects, three jobs

A **scalar** is a single number: a learning rate, a temperature, one loss value.

A **vector** is an ordered list of $d$ numbers. Write it bold and lowercase,
$\mathbf{x} \in \mathbb{R}^d$, and index components as $\mathbf{x}[j]$ for
$j = 0, \dots, d-1$. A token embedding is a vector, and a 768-dimensional one is
768 numbers that together stand for a token.

A **matrix** is a two-dimensional grid, written uppercase: $X \in \mathbb{R}^{m
\times n}$ means $m$ **rows** by $n$ **columns**. Element $X[i,j]$ sits at row
$i$, column $j$. Across this curriculum a matrix size is always stated rows
first, columns second.

A **tensor** is the general case: a grid with any number of axes. The name
matters less than the shape. A tensor of shape $(3, 2, 4)$ is a stack of three
$2 \times 4$ matrices, and the axes read left to right as batch, sequence,
feature.

| Object | Shape       | Where it appears in a model                                  |
| ------ | ----------- | ------------------------------------------------------------ |
| Scalar | `()`        | Learning rate, a single loss value                           |
| Vector | `(d,)`      | One token's embedding                                        |
| Matrix | `(n, d)`    | $n$ vectors stacked, e.g. a batch of embeddings              |
| Tensor | `(n, S, d)` | $n$ sequences of length $S$, one $d$-dim vector per position |

## Dimensions come in pairs

Two dimension names recur constantly in sequence models and it pays to keep them
apart. $d_{model}$ is the hidden width: the size of every residual-stream vector.
$d_{ff}$ is the inner width of the feed-forward sublayer, which in the original
Transformer is four times $d_{model}$ (Vaswani et al. 2017,
[arXiv:1706.03762](https://arxiv.org/abs/1706.03762)). Inside attention, $d_k$ is
the dimension each query and key is projected into, $d_v$ the dimension each value
is projected into, and the head count $h$ multiplies out so that $h \cdot d_k =
d_{model}$.

Uppercase $V$ is reserved for vocabulary size and is never a value vector.

## Matrix multiplication is the only arithmetic a layer does

A **dense layer** (also called a linear layer) computes, for each input row
$\mathbf{x} \in \mathbb{R}^{d_{in}}$, an output row
$\mathbf{y} = \mathbf{x}W^{\top} + \mathbf{b}$, where
$W \in \mathbb{R}^{d_{out} \times d_{in}}$ and $\mathbf{b} \in
\mathbb{R}^{d_{out}}$. Stacking $n$ inputs into $X \in \mathbb{R}^{n \times
d_{in}}$ gives the batched form:

$$
Y = XW^{\top} + \mathbf{b}, \qquad Y \in \mathbb{R}^{n \times d_{out}}.
$$

Storing $W$ as $d_{out} \times d_{in}$ rather than $d_{in} \times d_{out}$ is a
storage convention, not a mathematical necessity. It makes each row of $W$ one
output unit's weight vector, and it turns the batched form above into a single
matrix product with no transpose inside a loop. PyTorch's
[`nn.Linear`](https://docs.pytorch.org/docs/stable/generated/torch.nn.Linear.html)
takes the input dimension first and applies the transpose internally.

Here is the worked example, runnable as written:

```python
import numpy as np

# X: n = 2 tokens, d_in = 4
X = np.array([[1.0,  2.0, -1.0, 0.5],
              [0.0, -1.0,  2.0, 1.0]])

# W: d_out = 3 units, d_in = 4 features
W = np.array([[ 1.0,  0.0, 1.0,  0.0],
              [ 0.0, -1.0, 2.0,  1.0],
              [ 0.5,  0.5, 0.0, -1.0]])
b = np.array([0.1, -0.2, 0.3])

Y = X @ W.T + b
print(Y)
```

```
[[ 0.1 -3.7  1.3]
 [ 2.1  5.8 -1.2]]
```

Check the first output row by hand: unit 0 computes
$1(1) + 2(0) + (-1)(1) + 0.5(0) + 0.1 = 0.1$, and unit 1 computes
$1(0) + 2(-1) + (-1)(2) + 0.5(1) - 0.2 = -3.7$. Both match.

Two things this makes concrete. First, the shapes: `X` is `2 × 4`, `W` is `3 × 4`,
`W.T` is `4 × 3`, and the product is `2 × 3`. The rule is that the inner
dimensions must agree and the result takes the outer dimensions: a matmul between
`(a, b)` and `(b, c)` gives `(a, c)`. Second, the output row norm is not tied to
the input row norm in any fixed way. Row 0 of $X$ has Euclidean norm
$\sqrt{1+4+1+0.25} = 2.5$ and produces an output row of norm $3.923$; row 1 has
norm $\sqrt{0+1+4+1} = 2.449$ and produces one of norm $6.284$. Which output unit
dominates is decided by $W$.

This also shows a matmul is not elementwise multiplication. `X[0] * W[0]` gives
`[1, 0, -1, 0]`, ignoring $X[0]$'s other entries entirely. A dense layer forms a
weighted sum of _all_ input features for _each_ output unit.

Because the map is linear, scaling an input row by $\alpha$ scales the
corresponding output deviation by $\alpha$: $Y(\alpha X) - \mathbf{b} = \alpha (Y

- \mathbf{b})$. No amount of linear algebra makes a linear layer learn a curve.
  That is what the activation function is for.

## Transposing and reshaping

The **transpose** of $X \in \mathbb{R}^{m \times n}$ is $X^{\top} \in
\mathbb{R}^{n \times m}$, defined by $X^{\top}[i,j] = X[j,i]$: it exchanges rows
and columns, which is exactly a reflection across the main diagonal. Numerically
this swaps the roles of the two axes, so a column of $X$ becomes a row of
$X^{\top}$.

What transpose is _not_ is a vector reversal. `x[::-1]` reverses the order of
elements along one axis; `X.T` exchanges two axes. NumPy's
[`np.transpose`](https://numpy.org/doc/stable/reference/generated/numpy.transpose.html)
generalizes this to any permutation of axes.

A **reshape** changes shape without moving data: it reads the tensor in row-major
order and reinterprets the flat sequence. Flattening a tensor of shape
$(n, S, d)$ to $(nS, d)$ keeps each position's $d$ numbers adjacent, which is
exactly what you need to apply one shared weight matrix to every position at
once.

## A batched tensor and the flattening trick

Adding a batch axis is the trick that turns per-example loops into one operation.
Take $n = 3$ sequences of length $S = 2$ with $d = 4$ features:

```python
B = np.arange(24, dtype=float).reshape(3, 2, 4)   # (n, S, d)
print(B.shape)                                     # (3, 2, 4)

flat = B.reshape(-1, 4)                            # (n*S, d) = (6, 4)
Out = flat @ W.T + b                               # (6, 3)
out = Out.reshape(3, 2, 3)                         # (n, S, d_out)
print(out.shape)                                   # (3, 2, 3)
print(out[0])
```

```
(3, 2, 4)
(3, 2, 3)
[[  2.1   5.8  -2.2]
 [ 10.1  13.8  -2.2]]
```

Batch 0 consists of the rows $[0,4,8,12]$ and $[1,5,9,13]$, and both go through
the same $W$ and $\mathbf{b}$. That is the whole of sequence processing without
attention: merge the batch and sequence axes, apply a shared linear map, split
them back. Every position sees the same $W$, so the layer has
$d_{in} \cdot d_{out} + d_{out}$ parameters no matter how long the sequence is.
For $d_{in} = d_{out} = 4$ that is $4 \cdot 4 + 4 = 20$ parameters.

NumPy dispatches this automatically when the leading axes agree, so
`np.einsum('nsd,od->nso', B, W)` returns the same answer as the reshape version.
NumPy's [basics of broadcasting](https://numpy.org/doc/stable/user/basics.html)
describe the same mechanism in general terms.

Two shapes that look different but encode the same fact: a per-sample weight of
shape `(n, d_out, d_in)` contracts with `(n, S, d_in)` to give `(n, S, d_out)`,
which is what block-diagonal or grouped linear layers implement.

## Norms measure size without caring about direction

The **Frobenius norm** is the square root of the sum of squared entries, written
$\|X\|_F$. For a vector it reduces to the ordinary Euclidean norm:

```python
print(np.linalg.norm(X, ord='fro'))   # 3.5000  for the 2 x 4 X above
print(np.linalg.norm(W, ord='fro'))   # 3.0822
print(np.linalg.norm(Y, ord='fro'))   # 7.4081
```

Gradient clipping compares $\nabla_\theta L$ against a threshold on its norm, and
an $L_2$ penalty $\lambda \|\theta\|_2^2$ is the Frobenius norm squared summed
over all parameters, which is what weight decay shrinks.

The **$L_1$ norm** sums absolute values, $|\mathbf{x}|_1 = \sum_j |x[j]|$, and
measures total mass rather than concentration: it is $n$ for the vector of all
ones. That makes it the basis of total variation distance, which bounds how much
one probability distribution can differ from another in
[/en/blog/kv-cache-memory-of-long-contexts](/en/blog/kv-cache-memory-of-long-contexts).
The **maximum norm** $\max_j |x[j]|$ bounds the damage any single coordinate can
do.

## Why the shapes are worth caring about

A linear map can only mix coordinates, never add or remove them without saying
so. This is why a Transformer stacks fixed-shape residual blocks, and why a
sequence model's activation cost is essentially $O(S \cdot d_{model})$ per layer
regardless of how much text came before. Activations for $n = 8$, $S = 512$,
$d_{model} = 4096$ in 32-bit float are about 67 MB per tensor per layer, and
every one is kept because a backward pass needs it.

You will see the indexing notation constantly: $X[b,t,a]$ means batch $b$,
position $t$, head $a$. Fixing one convention across a codebase is worth more
than any amount of individual cleverness. See
[/en/blog/attention-from-first-principles](/en/blog/attention-from-first-principles)
for how these shapes behave once there are three of them.

## Where this stops being enough

The vocabulary of shapes and products is exact but it says nothing about
_conditioning_. A matrix product can be badly behaved, and the norms above are
oblivious to direction: scale one direction by 1000 and another by 0.001 and the
arithmetic still works while the optimization does not. That is the subject of
[/en/blog/linear-algebra-projections-and-rank](/en/blog/linear-algebra-projections-and-rank).

Two further limits. A dense layer's parameter count grows as $d_{in} \cdot
d_{out}$, so widening a model from 2048 to 8192 dimensions multiplies parameter
memory fourfold, which is the arithmetic behind practical model sizes in
[/en/blog/scaling-laws-parameters-and-data](/en/blog/scaling-laws-parameters-and-data).
And shape reasoning is a debugging aid, not a correctness proof: two tensors can
have identical shapes and still be indexed on different axes, so a transposed or
wrongly broadcast result usually has the right shape and the wrong values.
NumPy's [linalg routines](https://numpy.org/doc/stable/reference/routines.linalg.html)
and PyTorch's
[tensor attributes](https://docs.pytorch.org/docs/stable/tensor_attributes.html)
list the operations these shapes support.

## References

- Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan
  N. Gomez, Łukasz Kaiser, Illia Polosukhin. "Attention Is All You Need."
  NeurIPS 2017. [arXiv:1706.03762](https://arxiv.org/abs/1706.03762) — introduces
  $d_{model}$, $h$, $d_k$, $d_v$ and the $d_{ff} = 4 d_{model}$ convention used
  across this curriculum.
- NumPy documentation. [Basics of broadcasting](https://numpy.org/doc/stable/user/basics.html)
  and [Linear algebra routines](https://numpy.org/doc/stable/reference/routines.linalg.html).
- PyTorch documentation. [`torch.nn.Linear`](https://docs.pytorch.org/docs/stable/generated/torch.nn.Linear.html)
  and [Tensor attributes](https://docs.pytorch.org/docs/stable/tensor_attributes.html).
