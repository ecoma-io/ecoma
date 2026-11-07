---
title: 'Linear algebra for neural networks: projections, rank, and geometry'
description: 'Why a linear layer compresses or discards information, what rank actually measures, and how that constrains a network.'
date: '2026-09-15'
author: 'John Martin'
tags:
  - mathematics
  - ai
featured: false
cover: ../../../assets/cover-02-linear-algebra-projections-and-rank.svg
coverAlt: 'Abstract projection motif on a light background beside the lesson title'
articleId: linear-algebra-projections-and-rank
seriesId: mathematical-foundations
seriesOrder: 2
contentType: theory
level: foundational
prerequisites:
  - vectors-matrices-and-tensors
relatedArticleIds:
  - calculus-for-learning
  - embeddings-learned-geometry
---

# Linear algebra for neural networks: projections, rank, and geometry

A dense layer cannot do everything you might hope. It cannot create information
that was not in the input, it cannot bend a straight line into a curve, and if two
of its output units are wired identically the second one is decoration. None of
these are implementation defects; they are consequences of what a matrix product
is.

This lesson builds the geometric vocabulary that explains those limits. You will
compute an orthogonal projection and check the residual is genuinely orthogonal
to what it was projected onto, see exactly what rank-deficiency destroys, learn
why changing basis preserves rank while rescaling does not, and be able to state
which of these facts a ReLU network must work around.

## The dot product is a projection in disguise

The **dot product** of $\mathbf{u}, \mathbf{v} \in \mathbb{R}^d$ is

$$
\mathbf{u} \cdot \mathbf{v} = \sum_{j=0}^{d-1} u[j] \, v[j].
$$

Two vectors are **orthogonal** when their dot product is zero, which generalizes
the idea of perpendicularity to any dimension. Orthogonality is the property that
makes a basis well-behaved, so it is worth being precise about what it buys.

The **orthogonal projection** of $\mathbf{u}$ onto a nonzero vector $\mathbf{w}$
is the point on the line spanned by $\mathbf{w}$ closest to $\mathbf{u}$. Writing
$\mathbf{x} = \alpha \mathbf{w}$, minimizing $\|\mathbf{u} - \mathbf{x}\|^2$ over
$\alpha$ and differentiating gives $\alpha = (\mathbf{u} \cdot \mathbf{w}) /
(\mathbf{w} \cdot \mathbf{w})$, so

$$
\mathrm{proj}_{\mathbf{w}}(\mathbf{u}) = \frac{\mathbf{u} \cdot \mathbf{w}}{\mathbf{w} \cdot \mathbf{w}} \, \mathbf{w}.
$$

Take $\mathbf{u} = [1, 2, 3]$ and $\mathbf{w} = [2, -1, 4]$. Then
$\mathbf{u} \cdot \mathbf{w} = 12$ and $\mathbf{w} \cdot \mathbf{w} = 21$, so the
projection is $\frac{12}{21}\mathbf{w} \approx [1.1429, -0.5714, 2.2857]$.

The decomposition is the point:

| Piece                                                 | Value                       | Role                                |
| ----------------------------------------------------- | --------------------------- | ----------------------------------- |
| $\mathrm{proj}_{\mathbf{w}}(\mathbf{u})$              | $[1.1429, -0.5714, 2.2857]$ | the part parallel to $\mathbf{w}$   |
| $\mathbf{u} - \mathrm{proj}_{\mathbf{w}}(\mathbf{u})$ | $[-0.1429, 2.5714, 0.7143]$ | the part orthogonal to $\mathbf{w}$ |

Two checks confirm it. The residual's dot product with $\mathbf{w}$ is $0$ to
within floating-point error, which is the defining property. And because the two
pieces are orthogonal, their squared lengths add: $3.7417^2 = 2.6186^2 +
2.6726^2$ reproduces $\|\mathbf{u}\| = 3.7417$ exactly. Note also that the
residual is _larger_ than the projected piece: most of $\mathbf{u}$ lies
perpendicular to $\mathbf{w}$, so projecting onto $\mathbf{w}$ throws most of it
away.

> A linear layer is not a lookup and not a filter. It takes every input direction
> it can and writes down a number for each output direction, and the only choice
> left to it is which mixture to write down. Everything a layer can fail to do —
> lose information, correlate outputs, distort distances — follows from that one
> sentence.

## Orthogonal projections and least squares

A projection is a rank-reducing map: many different inputs collapse to the same
output. That is a feature when you want a summary and a bug when you want a
recovery.

The **least-squares solution** to an overdetermined system $A\mathbf{x} \approx
\mathbf{b}$ minimizes $\|A\mathbf{x} - \mathbf{b}\|^2$. When the columns of $A$
are orthogonal this has a closed form, $\mathbf{x} = \frac{A^{\top}\mathbf{b}}
{A^{\top}A}$, which is a projection of $\mathbf{b}$ onto each column followed by
rescaling. NumPy exposes it as
[`numpy.linalg.lstsq`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.lstsq.html).

The **pseudoinverse** $(A^{\top}A)^{-1}A^{\top}$ generalizes this to
non-orthogonal columns. `numpy.linalg.pinv` computes it via the SVD. When $A$ has
full column rank the pseudoinverse recovers $\mathbf{x}$ exactly; when it does not,
the pseudoinverse silently returns the solution of _smallest norm_, which is the
failure mode to watch for.

## Rank measures how much the map actually changes

The **rank** of a matrix is the dimension of the image of its linear map, i.e.
the number of linearly independent rows or columns. Three equivalent
characterizations are worth holding together:

- rank = number of linearly independent columns
- rank = number of nonzero **singular values** in the SVD
- rank = dimension of the row space = dimension of the column space

Rank is bounded above by $\min(m, n)$ for an $m \times n$ matrix, and full rank
is the generic case: a random $3 \times 4$ matrix has rank 3.

Consider a deliberately rank-deficient $2 \times 3$ matrix:

$$
A = \begin{bmatrix} 1 & 2 & 3 \\ 2 & -1 & 3 \end{bmatrix}, \qquad
\mathrm{rank}(A) = 2.
$$

Rank 2 out of a possible 3 means $A$ has a direction in its domain it cannot
respond to at all. Concretely, $\mathbf{n} = [9, 3, -5]$ satisfies $A\mathbf{n} =
[0, 0]$, so take $\mathbf{x} = [1, 2, 5]$ with output
$\mathbf{b} = A\mathbf{x} = [20, 15]$. Then

$$
A\left(\mathbf{x} + 0.01\,\mathbf{n}\right) = [20, 15] = A\mathbf{x}.
$$

Two genuinely different inputs produce bit-identical outputs:

$$
A\left(\mathbf{x} + 0.01\,\mathbf{n}\right) = [20, 15] = A\mathbf{x},
$$

even though $\|0.01\,\mathbf{n}\| = 0.1072$ separates them. The information
about that component is gone; no downstream layer can recover it. Feeding
$A(\mathbf{x}+0.01\mathbf{n})$ to `lstsq` returns a consistent but wrong answer
at distance $0.9325$ from the true $\mathbf{x}$ — the minimum-norm solution is
one of infinitely many, and nothing in the output tells you which.

The geometric picture: $\mathbf{n}$ lies in the **null space** of $A$, the set of
inputs mapped to zero. For a matrix of rank $r$ in $n$ columns the null space has
dimension $n - r$. Removing the null space and the left null space by the SVD
gives the reduced SVD $A = U_r \Sigma_r V_r^{\top}$, which is the numerically
stable way to reason about all of this; see
[`numpy.linalg.svd`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.svd.html).

Rank is exactly the property the SVD's smallest singular value puts in doubt, and
detecting it requires choosing a tolerance. For
$S = \mathrm{diag}(3, 2, 1, 10^{-9})$ the singular values are
$[3, 2, 1, 10^{-9}]$, and `numpy.linalg.matrix_rank(S)` reports 4 — at the
default tolerance of roughly $2.7 \times 10^{-15}$ the $10^{-9}$ direction counts
as nonzero. Passing an explicit tolerance tells you which convention you meant:

```python
import numpy as np

S = np.diag([3.0, 2.0, 1.0, 1e-9])
print(np.linalg.matrix_rank(S))              # 4
print(np.linalg.matrix_rank(S, tol=1e-6))    # 3
print(np.linalg.cond(S))                     # 3e+09
```

The condition number, $\|S\|_2 \cdot \|S^{-1}\|_2 = 3 \times 10^9$, is the
rank-independent version of the same warning: nothing is exactly zero, but one
direction is a billion times harder to invert than another, and any solver's
default tolerance is making a judgment call on your behalf.

## Changing basis versus rescaling

Two matrix operations look similar and behave completely differently.

**Orthogonal change of basis.** If $Q^{\top}Q = I$, the map $Q\mathbf{x}$ is a
rotation or reflection. For such $Q$, $\|\mathbf{x}\| = \|Q\mathbf{x}\|$
exactly: distances, angles, and rank are all preserved. A model that only ever
composes orthogonal maps with the identity is doing geometry, not learning. Verify
it:

```python
rng = np.random.default_rng(1)
Q, _ = np.linalg.qr(rng.standard_normal((4, 4)))
x = np.array([1.0, 2.0, 3.0, 4.0])

print(np.allclose(Q.T @ Q, np.eye(4)))        # True
print(np.linalg.norm(x), np.linalg.norm(Q @ x))  # 5.4772 5.4772
```

**Rescaling.** Multiply one direction by 1000 and another by 0.001 and you have
not rotated anything; you have changed the geometry. The dot product no longer
measures similarity, the norm ratio between two data points can change
arbitrarily, and optimization along the small direction behaves like gradient
descent on a near-flat valley. Rank survives — scaling is invertible, and a
rescaled matrix has the same rank as the original — but the _conditioning_ does
not. This is why input standardization and normalization layers are load-bearing
rather than cosmetic.

A linear map can therefore do exactly three things: **rotate** (change
coordinates), **scale** (change magnitudes along directions), and **project**
(discard directions). It cannot do anything else, at any depth, without a
nonlinearity.

## Why this constrains network representations

Put the three operations together with what a linear layer must satisfy. A layer
that is purely linear maps $d_{model}$ dimensions to $d_{out}$ dimensions. If
$d_{out} < d_{model}$ and the weights have rank $d_{out}$, the layer is a
projection and the null space has dimension $d_{model} - d_{out}$. Everything in
that null space is discarded permanently. This is the mechanism behind three
concrete design decisions:

- **Bottleneck architectures** in autoencoders are intentional projections. You
  compress $d_{in}$ to a smaller code and accept the loss, because the code is
  supposed to be sufficient for reconstruction.
- **Low-rank factorization** of weight matrices is a deliberate approximation.
  Replacing $W \in \mathbb{R}^{d_{out} \times d_{in}}$ by $UV$ with
  $U \in \mathbb{R}^{d_{out} \times r}$ and $V \in \mathbb{R}^{r \times d_{in}}$
  where $r \ll \min(d_{out}, d_{in})$ forces rank at most $r$. This is the same
  idea as an adapter: see
  [/en/blog/supervised-fine-tuning-instructions](/en/blog/supervised-fine-tuning-instructions)
  for where low-rank updates show up in practice.
- **Residual connections** are a rank-preserving escape hatch. Adding the input
  back, $\mathbf{y} = \mathbf{x} + F(\mathbf{x})$, means the layer's contribution
  $F(\mathbf{x})$ can be _any_ function of the input, while the identity path
  keeps a full-rank direct route for information the sublayer did not find
  useful. Without it, stacking projections compounds the loss: $k$ rank-reducing
  layers in series have rank at most the product of the individual ranks, so the
  network can collapse to a very low-dimensional space and become unable to
  distinguish inputs.

The nonlinearity is what buys back the ability to represent non-linear
structure, and it is also what breaks rank in a data-dependent way: a ReLU can
make different coordinates active for different inputs, so the effective rank of
the composed function need not be bounded by any single layer's rank. Formally
pointwise multiplication by a mask $M \in \{0,1\}^{m \times n}$ has rank up to
$\min(m, n)$ and, unlike a fixed matrix, varies with the input — which is why
deep ReLU networks are not bounded by the rank of any layer.

Where this stops being enough: the whole argument is about _linear_ maps and their
individual conditioning. Composition of many well-conditioned maps can still be
ill-conditioned, which is the subject of
[/en/blog/gradient-descent-and-backpropagation](/en/blog/gradient-descent-and-backpropagation),
and the specific ways modern architectures exploit the geometry are in
[/en/blog/embeddings-learned-geometry](/en/blog/embeddings-learned-geometry).
Derivatives are what make rank and conditioning matter to optimization; the next
lesson derives them.

## References

- NumPy documentation. [`numpy.linalg.lstsq`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.lstsq.html),
  [`numpy.linalg.svd`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.svd.html),
  [`numpy.linalg.pinv`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.pinv.html),
  and [Linear algebra routines](https://numpy.org/doc/stable/reference/routines.linalg.html).
- Gilbert Strang, _Introduction to Linear Algebra_, 5th ed., Wellesley-Cambridge
  Press, 2016 — the standard reference for the null space, rank-nullity theorem,
  and the four fundamental subspaces.
