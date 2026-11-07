---
title: 'Calculus for learning: derivatives, gradients, and the chain rule'
description: 'How a loss becomes a gradient, what backpropagation actually computes, and why the chain rule makes deep networks trainable.'
date: '2026-09-16'
author: 'John Martin'
tags:
  - mathematics
  - ai
featured: false
cover: ../../../assets/cover-03-calculus-for-learning.svg
coverAlt: 'Abstract tangent curve motif on a light background beside the lesson title'
articleId: calculus-for-learning
seriesId: mathematical-foundations
seriesOrder: 3
contentType: theory
level: foundational
prerequisites:
  - vectors-matrices-and-tensors
relatedArticleIds:
  - gradient-descent-and-backpropagation
  - linear-algebra-projections-and-rank
---

# Calculus for learning: derivatives, gradients, and the chain rule

A loss function is a scalar, and scalars have no opinion about which of the
seven billion parameters made them high. Derivatives are the mechanism that
turns "the loss is too big" into "these specific parameters, by about this much,
in this direction." Backpropagation is nothing more than the chain rule applied
to that question through a graph of operations, which is why it works the same in
a two-layer network as in a two-hundred-layer one.

This lesson derives that from a single derivative. By the end you should be able
to compute a gradient by hand through two chained layers, explain what
"backward pass" means as a computation rather than a slogan, and recognise the
two failure modes — vanishing and exploding gradients — from the numbers rather
than from intuition.

## From derivative to gradient

For a function of one variable, the derivative $f'(x)$ is the limit of the
difference quotient:

$$
f'(x) = \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}.
$$

Geometrically it is the slope of the tangent line. The limit definition is not
decorative: it is a literal recipe for computing a derivative numerically, and
checking an analytic gradient against that recipe is the single most useful test
you can write for a layer.

For a function of several variables, $f: \mathbb{R}^d \to \mathbb{R}$, the
**partial derivative** $\frac{\partial f}{\partial x_j}$ holds all other inputs
fixed and differentiates only with respect to $x_j$. Collecting the partials into
a vector gives the **gradient**:

$$
\nabla_{\mathbf{x}} f = \left[\frac{\partial f}{\partial x_0}, \dots, \frac{\partial f}{\partial x_{d-1}}\right]^{\top}.
$$

The gradient points in the direction of steepest _increase_: the direction
$\mathbf{v}$ with the largest $f(\mathbf{x} + \mathbf{v})$ for unit-length
$\mathbf{v}$ is $\nabla_{\mathbf{x}} f / \|\nabla_{\mathbf{x}} f\|$. So
$-\nabla_{\mathbf{x}} f$ is the direction of steepest decrease, and this is
where the update rule in
[/en/blog/gradient-descent-and-backpropagation](/en/blog/gradient-descent-and-backpropagation)
comes from — not from a separate theorem, just from the definition of the
gradient.

The gradient of a matrix-valued linear layer's output with respect to its
parameters is the input, which is worth stating because it explains why the first
layer of a network learns more slowly than the last: the gradient arriving at
layer 1's weights has been multiplied by every intervening weight matrix.

## The chain rule, and why it composes

The **chain rule** for a single variable: if $z = g(y)$ and $y = f(x)$, then
$\frac{dz}{dx} = \frac{dz}{dy}\frac{dy}{dx}$. In words: the sensitivity of a
composite to its input is the product of the local sensitivities along the path.

In vector form, for $a_1 = \phi(z_1)$ and $z_2 = W_2 a_1 + b_2$, the chain rule
gives

$$
\frac{\partial z_2}{\partial z_1} = \frac{\partial z_2}{\partial a_1}\frac{\partial a_1}{\partial z_1} = W_2 \, \phi'(z_1),
$$

where $\phi'$ is the activation's derivative and the product is a matrix-matrix
product. This is the whole of backpropagation: a **computational graph** of
operations, each of which knows its own local derivative, with the chain rule
multiplying them along every path. Multiplying rather than adding is why the
factors compound across depth.

A network with $L$ layers produces $\nabla_{\theta} L$ by a single reverse sweep,
because the total work is one multiply per edge, not one per path. This is the
practical difference between backpropagation and computing derivatives by
definition, and it is what makes depth affordable.

## A two-layer network, computed by hand

Build a deliberately tiny network: layer 1 takes $x \in \mathbb{R}^2$ to a single
unit through $\tanh$, layer 2 maps that scalar to a scalar output. With
$\mathbf{x} = [1, 2]$, $W_1 = [0.5, -1.0]$, $b_1 = 0.3$, $W_2 = [2.0]$,
$b_2 = -0.5$ and target $y = 0.7$, the forward pass is:

$$
z_1 = 0.5(1) + (-1.0)(2) + 0.3 = -1.2
$$

$$
a_1 = \tanh(-1.2) = -0.833655
$$

$$
z_2 = 2.0(-0.833655) - 0.5 = -2.167309
$$

With the squared loss $L = (z_2 - y)^2$, the loss is
$(-2.167309 - 0.7)^2 = 8.221462$.

Now differentiate backwards. Each step multiplies by one local derivative:

| Step                   | Quantity                                                                                               | Value        | Local derivative used                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------ |
| loss                   | $L = (z_2-y)^2$                                                                                        | $8.221462$   | $\frac{dL}{dz_2} = 2(z_2 - y) = -5.734618$ |
| layer 2 weights        | $\frac{\partial L}{\partial w_2} = \frac{dL}{dz_2}a_1$                                                 | $4.780691$   | $a_1$                                      |
| layer 2 bias           | $\frac{\partial L}{\partial b_2} = -5.734618$                                                          |              | $1$                                        |
| layer 1 output         | $\frac{\partial L}{\partial a_1} = \frac{dL}{dz_2}w_2$                                                 | $-11.469237$ | $w_2 = 2.0$                                |
| layer 1 pre-activation | $\frac{\partial L}{\partial z_1} = \frac{\partial L}{\partial a_1}(1 - a_1^2)$                         | $-3.498347$  | $\tanh'(z) = 1 - \tanh^2(z)$               |
| layer 1 weights        | $\frac{\partial L}{\partial w_1} = \frac{\partial L}{\partial z_1}\mathbf{x} = [-3.498347, -6.996693]$ |              | $\mathbf{x} = [1,2]$                       |

The chain rule appears exactly where it should: the gradient reaching layer 1 is
$-5.734618 \times 2.0 \times (1 - 0.833655^2) = -3.498347$, the product of three
local factors. Note that the layer-1 gradient is smaller in magnitude than the
layer-2 gradient, and that the second weight gets twice the gradient of the first
purely because $x_2 = 2$.

Here is the whole thing as code, including the check that matters:

```python
import math

x1, x2 = 1.0, 2.0
w1a, w1b = 0.5, -1.0
b1 = 0.3
w2 = 2.0
b2 = -0.5
y = 0.7

def forward(w1a, w1b, b1, w2, b2):
    z1 = w1a * x1 + w1b * x2 + b1
    a1 = math.tanh(z1)
    z2 = w2 * a1 + b2
    return z1, a1, z2

def loss(w1a, w1b, b1, w2, b2):
    _, _, z2 = forward(w1a, w1b, b1, w2, b2)
    return (z2 - y) ** 2

def numgrad(fn, base, h=1e-6):
    g = []
    for i in range(len(base)):
        vp = list(base); vp[i] += h
        vm = list(base); vm[i] -= h
        g.append((fn(*vp) - fn(*vm)) / (2 * h))
    return g

z1, a1, z2 = forward(w1a, w1b, b1, w2, b2)
L = (z2 - y) ** 2
print("z1 = %.6f  a1 = %.6f  z2 = %.6f  L = %.6f" % (z1, a1, z2, L))

dz2 = 2 * (z2 - y)
dw2 = dz2 * a1
da1 = dz2 * w2
dz1 = da1 * (1 - a1 * a1)
dw1a = dz1 * x1
dw1b = dz1 * x2
print("dw2 %.6f  dw1a %.6f  dw1b %.6f" % (dw2, dw1a, dw1b))
print("analytic:", ["%.6f" % g for g in (dw1a, dw1b, dz1, dw2, dz2)])
print("numeric: ", ["%.6f" % g for g in numgrad(loss, [w1a, w1b, b1, w2, b2])])
```

```
z1 = -1.200000  a1 = -0.833655  z2 = -2.167309  L = 8.221462
dw2 4.780691  dw1a -3.498347  dw1b -6.996693
analytic: ['-3.498347', '-6.996693', '-3.498347', '4.780691', '-5.734618']
numeric:  ['-3.498347', '-6.996693', '-3.498347', '4.780691', '-5.734618']
```

Every analytic gradient agrees with the central difference to six decimals. This
check is cheap, requires no framework, and catches sign errors, transposes, and
missing terms — so make it a habit.

Take one gradient-descent step with learning rate $\eta = 0.5$ and every
parameter updates as $\theta \leftarrow \theta - \eta \nabla_{\theta} L$:

```
w1 = [2.249173, 2.498347]   b1 = 2.049173   w2 = -0.390346   b2 = 2.367309
L falls from 8.221462 to 1.630636
```

## When the chain rule multiplies you into trouble

The danger is that chain-rule factors multiply along a path, and in a deep network
there are many paths. If each path multiplies by a factor near 1, the total stays
near 1 — fine. If each path multiplies by a factor slightly above 1, the product
explodes with depth. If slightly below 1, it collapses.

**Vanishing gradients.** Saturated activations have derivatives near zero. For
$\tanh$:

| $z$  | $\tanh(z)$ | $\tanh'(z)$ |
| ---- | ---------- | ----------- |
| 0.5  | 0.46211716 | 7.864e-01   |
| 1.0  | 0.76159416 | 4.200e-01   |
| 2.0  | 0.96402758 | 7.065e-02   |
| 5.0  | 0.99990920 | 1.816e-04   |
| 20.0 | 1.00000000 | 0.000e+00   |

At $z = 5$ the derivative is $1.816 \times 10^{-4}$. Ten such layers multiply to
about $3.9 \times 10^{-38}$, and the earliest layers receive a gradient
indistinguishable from zero: they do not learn, and they do not learn slowly.
This is a large part of why ReLU (derivative exactly 1 on the positive side) and
residual connections became standard; Bengio et al. 2003 identified gradient decay
as a fundamental obstacle to training deep networks, in a JMLR paper with no arXiv
identifier.

**Exploding gradients.** The mirror failure. If weights are initialised too
large, each layer multiplies the gradient by a factor above 1 and the gradient
overflows to `inf` or `nan` within a few layers. The standard mitigations are
smaller initialisation, gradient clipping by norm (see
[/en/blog/vectors-matrices-and-tensors](/en/blog/vectors-matrices-and-tensors) for
which norm to use), and normalization layers.

A third, quieter failure mode deserves mention: **saddle points and plateaus**.
Where the gradient is near zero but not through saturation — a flat region —
gradient descent makes almost no progress. This is why adaptive optimizers exist
at all.

## What this does not tell you

The chain rule is exact and local, and that is exactly its limitation: it tells
you the slope at your current point and nothing about the shape of the
neighbourhood. A gradient of $-0.001$ does not distinguish a gentle descent from
a cliff edge; a gradient of $0$ does not distinguish a plateau from a local
minimum from a saddle. This is why the loss landscape, not the gradient, is the
real object of study, and why the optimizer's behaviour on flat regions matters
more than the correctness of the derivative.

Nor does backpropagation say anything about _credit assignment_ in the causal
sense. It correctly computes the total derivative of the loss with respect to
every parameter, but the credit it assigns is a gradient, and gradient-weighted
credit is not the same thing as causal responsibility. That distinction matters
for attribution methods.

The other limit is arithmetic: backpropagation stores an activation at every
operation, which is why activation memory dominates the cost of training a large
model. Recomputing activations instead of storing them trades compute for memory;
that trade is explored in
[/en/blog/quantization-precision-and-efficiency](/en/blog/quantization-precision-and-efficiency)
and in the parallelism strategies of
[/en/blog/distributed-training-parallelism](/en/blog/distributed-training-parallelism).

The next lesson supplies the other half: a loss function is a number about how
wrong the model is, and saying what that number _means_ requires probability.

## References

- Yoshua Bengio, Pascal Simard, and Yoshua LeCun. "A Learning Algorithm for Deep
  Neural Networks." _Neural Networks: Tricks of the Trade_, LNCS 3224, Springer,
  2003 — identifies gradient decay as an obstacle to deep learning, and motivates
  the initialization and activation choices discussed here.
- "Automatic Differentiation in PyTorch." PyTorch documentation,
  [Autograd](https://docs.pytorch.org/docs/stable/autograd.html) — the same chain
  rule over a recorded graph.
