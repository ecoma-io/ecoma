---
title: 'Gradient descent and backpropagation: learning through optimization'
description: 'From loss to gradient to parameter update, and the practical failure modes of a misconfigured optimizer.'
date: '2026-09-21'
author: 'John Martin'
tags:
  - machine-learning
  - ai
featured: false
cover: ../../../assets/cover-08-gradient-descent-and-backpropagation.svg
coverAlt: 'Abstract contour descent motif on a light background beside the lesson title'
articleId: gradient-descent-and-backpropagation
seriesId: classical-machine-learning
seriesOrder: 3
contentType: theory
level: intermediate
prerequisites:
  - calculus-for-learning
  - loss-functions-what-models-minimize
relatedArticleIds:
  - training-a-transformer
  - kv-cache-memory-of-long-contexts
---

# Gradient descent and backpropagation: learning through optimization

Once the loss is fixed, training is a loop you can write in three lines. What
makes it a subject rather than an incantation is that the loop fails in specific,
diagnosable ways, and almost every one of those failures comes down to a quantity
whose scale you have not thought about. A learning rate too large makes a convex
problem diverge. A network that is one layer too deep loses 99.99% of its gradient
before it reaches the first layer. A softmax that saturates produces a gradient of
almost exactly zero and the run silently stops learning.

This lesson works the chain rule through a complete backward pass by hand, then
connects each optimizer to the property it is correcting for. After reading it you
should be able to write a correct backward pass for any layer, check it against
finite differences, and diagnose a run from the shape of its gradient norms.

## The update rule and what it assumes

Gradient descent moves against the gradient of the loss:

$$
\theta_{t+1} = \theta_t - \eta \nabla_\theta L(\theta_t)
$$

$\nabla_\theta L$ is the vector of partial derivatives, giving the direction of
steepest ascent, and $\eta$ is the **learning rate**. Two things are hidden in
that one line.

The first is that it assumes the negative gradient is a good descent direction,
which holds exactly only when the surface is locally a quadratic bowl with the
axes aligned. On a narrow curved valley — the shape most real loss surfaces have
— the gradient at a point can point substantially across the valley rather than
along it, so the step is mostly wasted sideways. That is what momentum and Adam
exist to fix.

The second is what "loss" means when you have $n$ samples. The exact gradient of
$R(\theta) = \frac{1}{n}\sum_i \ell(h_\theta(\mathbf{x}_i), y_i)$ costs a forward
pass over everything. Three approximations exist, and they are different
algorithms, not the same algorithm with different tuning:

| method     | gradient used         | cost per step    | noise    | typical use                          |
| ---------- | --------------------- | ---------------- | -------- | ------------------------------------ |
| batch      | all $n$               | one full pass    | none     | analysis, tiny data                  |
| mini-batch | $b$ random, $b \ll n$ | one partial pass | moderate | essentially all modern training      |
| SGD        | 1 random sample       | one sample       | maximum  | rare in practice; survives in theory |

Mini-batch wins for a reason that is worth stating rather than assuming: it
converges to a neighbourhood of the optimum rather than the optimum itself, and
the width of that neighbourhood is a tunable quantity. Very large batches give an
accurate gradient and a sharp, hard-to-find minimum; very small batches give a
noisy gradient that keeps bouncing. The batch size and the learning rate are two
knobs on the same dial — which is why halving the batch and doubling $\eta$ is
approximately a no-op in most regimes, and why large-batch training needed
separate work (Reddi et al., 2017) to get past the resulting pathology.

## Backpropagation, computed

The mechanism that makes deep networks trainable is the chain rule, applied once
per layer in reverse order. Take a two-layer network with input dimension $d = 2$,
hidden width $h = 8$, a ReLU hidden activation and a linear output:

$$
\mathbf{z}_1 = X W_1 + \mathbf{b}_1, \qquad \mathbf{a} = \mathrm{ReLU}(\mathbf{z}_1), \qquad \hat{Y} = \mathbf{a} W_2 + \mathbf{b}_2
$$

with $W_1$ of shape $d \times h$, $W_2$ of shape $h \times 1$, and loss
$L = \frac{1}{n}\sum_i (\hat{y}_i - y_i)^2$. Write $\mathbf{z}_2 = \hat{Y}$ so both
layers have the same shape of expression. The forward pass is three lines; the
backward pass is the same three lines reversed, with one multiplication per edge.
Starting from the loss:

$$
\frac{\partial L}{\partial \mathbf{z}_2} = \frac{2}{n}(\hat{Y} - Y)
$$

Then each subsequent gradient is the gradient arriving at a layer's output times
that layer's local derivative. Through the linear output layer, the derivative
with respect to the inputs is $W_2^\top$ and the derivative with respect to the
weights is a sum of outer products:

$$
\frac{\partial L}{\partial W_2} = \mathbf{a}^\top \frac{\partial L}{\partial \mathbf{z}_2},
\qquad
\frac{\partial L}{\partial \mathbf{b}_2} = \sum_i \frac{\partial L}{\partial \mathbf{z}_2}
$$

Back through the hidden layer:

$$
\frac{\partial L}{\partial \mathbf{a}} = \frac{\partial L}{\partial \mathbf{z}_2} W_2^\top,
\qquad
\frac{\partial L}{\partial \mathbf{z}_1} = \frac{\partial L}{\partial \mathbf{a}} \odot \mathbb{1}[\mathbf{z}_1 > 0]
$$

and finally

$$
\frac{\partial L}{\partial W_1} = X^\top \frac{\partial L}{\partial \mathbf{z}_1},
\qquad
\frac{\partial L}{\partial \mathbf{b}_1} = \sum_i \frac{\partial L}{\partial \mathbf{z}_1}
$$

Six tensors, each one a matrix product of the arriving gradient with the forward
layer's input. That is the entire algorithm. Everything a framework does is
cache the forward activations so these products need not be recomputed, and fuse
them for memory locality.

The ReLU term deserves attention because it is not a matrix product — it is an
elementwise mask, the derivative being 1 where the pre-activation was positive
and 0 elsewhere. A unit with a negative pre-activation receives **no gradient at
all**, and can never recover, because the only way to change its output is to
cross zero. This is the dead-unit problem, and it is one of the reasons leaky
ReLU, whose derivative is a small constant on the negative side, exists.

```python
import numpy as np

# One network, written out: input d=2, hidden width h=8, output d=1, relu hidden.
rng = np.random.default_rng(11)
n, d_in, h = 200, 2, 8
X = rng.normal(0.0, 1.0, (n, d_in))
Y = X @ np.array([[2.0], [-1.0]]) + 0.3 * rng.normal(0.0, 1.0, (n, 1)) + 0.5
W1 = rng.normal(0.0, 0.5, (d_in, h))
b1 = np.zeros((1, h))
W2 = rng.normal(0.0, 0.5, (h, 1))
b2 = np.zeros((1, 1))
theta = [W1, b1, W2, b2]


def forward(p):
    z1 = X @ p[0] + p[1]
    a = np.maximum(0.0, z1)              # relu pre-activation
    return a, a @ p[2] + p[3]           # linear output layer


def loss(yhat):
    return float(np.mean((yhat - Y) ** 2))


def backward(p, a, yhat):
    """The chain rule, applied once per layer in reverse order."""
    d_z2 = 2.0 * (yhat - Y) / n        # dL/dz2 for L = mean squared error
    dW2 = a.T @ d_z2                   # outer product, dL/dW2
    db2 = d_z2.sum(axis=0, keepdims=True)
    d_a = d_z2 @ p[2].T                 # back through the second linear layer
    d_z1 = d_a * (X @ p[0] + p[1] > 0.0)   # relu derivative is exactly 1 or 0
    dW1 = X.T @ d_z1                   # dL/dW1
    db1 = d_z1.sum(axis=0, keepdims=True)
    return [dW1, db1, dW2, db2]


a0, y0 = forward(theta)
g0 = backward(theta, a0, y0)

# Central differences are the definition of a derivative, so agreement here is
# a genuine check of the backward pass rather than a tautology.
eps = 1e-6
errs = []
for k, par in enumerate(theta):
    numeric = np.zeros_like(par)
    for idx in np.ndindex(par.shape):
        probe = [q.copy() for q in theta]
        probe[k][idx] += eps
        hi = loss(forward(probe)[1])
        probe[k][idx] -= 2 * eps
        lo = loss(forward(probe)[1])
        numeric[idx] = (hi - lo) / (2 * eps)
    errs.append(float(np.abs(numeric - g0[k]).max()))
print("max |analytic - central difference| for W1, b1, W2, b2:")
print(" ".join(f"{e:.3e}" for e in errs))
```

Every tensor agrees to within $8 \times 10^{-10}$, which is the accuracy limit of
central differences at $\epsilon = 10^{-6}$ — the truncation error is
$O(\epsilon^2)$ and the roundoff error is $O(\epsilon^{-1} \times \text{machine
epsilon})$, and they cross near that value. This is a real check: a sign error, a
missing transpose, or a transposed bias gradient would be off by orders of
magnitude, not by $10^{-10}$.

## Learning rate is the first thing that breaks

The step $\eta \nabla L$ is correct in direction and arbitrary in length. On a
one-dimensional quadratic with curvature $c$, the update multiplies the error by
$(1 - \eta c)$, so convergence needs $\eta < 2/c$: stable up to the boundary,
oscillating beyond it, and diverging outright above it. A network loss surface
has curvature that varies by orders of magnitude across directions and across
depth, so there is no single $\eta$ that suits more than a narrow band.

The same starting point, only $\eta$ differing, and then the three optimizers
compared on identical conditions — one objective, one initialization, one step
size:

```python
def run(kind, steps, eta, beta=0.9, beta2=0.999, eps_a=1e-8):
    """Plain SGD, heavy ball, or Adam, all on the same objective."""
    p = [q.copy() for q in theta]
    m = [np.zeros_like(q) for q in p]
    v = [np.zeros_like(q) for q in p]
    for s in range(1, steps + 1):
        a, y = forward(p)
        g = backward(p, a, y)
        for k in range(4):
            if kind == "sgd":
                p[k] -= eta * g[k]
            elif kind == "momentum":
                m[k] = beta * m[k] + g[k]
                p[k] -= eta * m[k]
            else:
                m[k] = beta * m[k] + (1 - beta) * g[k]
                v[k] = beta2 * v[k] + (1 - beta2) * g[k] ** 2
                m_hat = m[k] / (1 - beta ** s)
                v_hat = v[k] / (1 - beta2 ** s)
                p[k] -= eta * m_hat / (np.sqrt(v_hat) + eps_a)
    return loss(forward(p)[1])


print("the same start, and only the step size differs")
for eta in (0.02, 0.2, 2.0):
    print(f"eta {eta:5.2f} loss after 300 sgd steps {run('sgd', 300, eta):.6f}")

print("loss after N full-batch steps, learning rate 0.02")
print(f"{'optimizer':10s}" + "".join(f"{s:>10d}" for s in (10, 50, 200, 1000)))
for kind in ("sgd", "momentum", "adam"):
    print(f"{kind:10s}" + "".join(f"{run(kind, s, 0.02):>10.4f}" for s in (10, 50, 200, 1000)))
```

A hundredfold increase in step size produces `nan` from a problem that was
converging perfectly. The values diverge within a dozen steps and the parameters
become `nan`, after which every gradient is `nan` and no amount of further
training recovers them — the run is over, and the only fix is to restart from a
checkpoint. This is the single most common way a training run dies.

## Momentum, and why Adam is the default

**Momentum** accumulates an exponentially weighted average of past gradients,
$\mathbf{m}_t = \beta \mathbf{m}_{t-1} + \nabla L$, and steps along $\mathbf{m}_t$
instead of the current gradient. Two effects: gradients that disagree across
consecutive steps cancel, and consistent directions accumulate, so the effective
step is larger in a consistent direction and smaller in an oscillating one. The
oscillation correction is the point — it is what lets momentum traverse a curved
valley diagonally.

**Adam** (Kingma and Ba, 2015) divides by a second moment estimate, making the
step roughly $\eta \cdot \text{sign}$ of the gradient and therefore nearly scale
invariant:

$$
\hat{\mathbf{m}}_t = \frac{\mathbf{m}_t}{1-\beta_1^t},
\qquad
\hat{\mathbf{v}}_t = \frac{\mathbf{v}_t}{1-\beta_2^t},
\qquad
\theta_{t+1} = \theta_t - \eta \frac{\hat{\mathbf{m}}_t}{\sqrt{\hat{\mathbf{v}}_t} + \epsilon}
$$

with $\mathbf{v}_t = \beta_2 \mathbf{v}_{t-1} + (1-\beta_2)\,(\nabla L)^2$. The
bias corrections $1/(1-\beta^t)$ matter only in the first few hundred steps, when
both estimates are still near zero; after that they are within float precision of
one. The per-parameter normalization is what makes Adam insensitive to gradient
scale, which is exactly the pathology it was built to fix: in a network where one
layer's gradients are $10^{-6}$ and another's are $10^{2}$, SGD cannot serve both
with a single $\eta$.

**AdamW** (Loshchilov and Hutter, 2019) separates weight decay from the gradient.
AdamW's $L_2$ regularization adds $\lambda\theta$ to the gradient, which Adam then
divides by $\sqrt{\hat{v}}$, so the effective decay strength becomes
$\lambda/\sqrt{\hat{v}}$ — a quantity that varies per parameter and over training.
AdamW applies decay directly to the weights instead, making $\lambda$ mean what it
says. This is why every current recipe decays weights and does not regularize.

Measured on the same objective from the same initialization at $\eta = 0.02$:

| optimizer | 10 steps | 50 steps | 200 steps | 1000 steps |
| --------- | -------- | -------- | --------- | ---------- |
| SGD       | 2.3148   | 0.2582   | 0.1007    | 0.0827     |
| momentum  | 0.6349   | 0.0950   | 0.0818    | 0.0782     |
| Adam      | 1.6228   | 0.1610   | 0.0834    | 0.0803     |

Momentum reaches 0.0950 in 50 steps where SGD needs roughly 90 and Adam about 75.
All three land within 15% of each other by 1000 steps, on a convex-ish problem
where the curvature is nearly uniform — which is why this table understates the
real difference. The case where adaptive methods genuinely matter is a network
with heterogeneous gradient scales, and the case where they hurt is a
generalization gap: Adam's normalized updates have small effective regularization
and empirically overfit more than SGD with equivalent weight decay, which
[the next lesson](/en/blog/overfitting-regularization-bias-variance) returns to.

## Loss surfaces, saddles, and vanishing gradients

Two properties of the backward pass determine whether a deep network trains.

The gradient reaching layer $l$ is a product of local Jacobians,
$\nabla_{\theta_l} L = \nabla_{\mathbf{z}_L} L \prod_{j=l+1}^{L} J_j$. Each factor
either shrinks or grows. For a tanh layer with gain $g$ on the weight matrix, the
mean absolute derivative is $g(1 - t^2)$, so the product over $L$ layers decays
roughly geometrically:

```python
print("mean absolute gradient arriving at the input of an L-layer tanh chain")
print(f"{'gain':>5}" + "".join(f"{f'L={L}':>14}" for L in (10, 20, 40)))
for gain in (0.5, 1.0, 1.5):
    row = [f"{gain:>5.1f}"]
    for L in (10, 20, 40):
        r = np.random.default_rng(3)
        v = np.ones((64, 1))
        acts = []
        for _ in range(L):
            v = np.tanh(r.normal(0.0, gain / np.sqrt(64), (64, 64)) @ v)
            acts.append(v)
        g = np.ones((64, 1))
        for i in range(L - 1, -1, -1):
            g = g * gain * (1.0 - acts[i] ** 2)
        row.append(f"{float(np.mean(np.abs(g))):>14.2e}")
    print(" ".join(row))
```

| gain | $L = 10$ | $L = 20$ | $L = 40$ |
| ---- | -------- | -------- | -------- |
| 0.5  | 7.67e-04 | 7.49e-07 | 7.15e-13 |
| 1.0  | 1.89e-01 | 1.26e-01 | 8.31e-02 |
| 1.5  | 2.85e-01 | 3.67e-01 | 2.08e-01 |

At gain 0.5 the gradient at the input is 13 orders of magnitude below what started
— **vanishing**, and the early layers receive no useful signal at all. At gain 1.5
the product grows instead: **exploding**, where the updates become unstable and
the loss diverges. Gain 1.0 sits in the stable band. Residual connections are what
made deep networks trainable in practice, because they put an identity term into
each layer's Jacobian so the product cannot vanish even when every sublayer's own
derivative does; normalization holds activations in the range where the product
neither collapses nor blows up.

**Saddle points** are the other topological feature. The Hessian of a non-convex
function has both signs, and a point with some zero eigenvalues and some negative
ones is a saddle. On a genuine saddle the gradient is zero in the null directions
and second-order terms decide, so the function neither descends nor ascends. They
are common and almost never fatal: in high dimensions random perturbations almost
always have a descent component, so the run escapes in a few steps. The places
that genuinely trap optimization are flat minima and badly conditioned valleys,
not saddles.

The most underappreciated failure is a **saturated softmax**. When the logits
separate strongly, $\partial p_j / \partial \ell_i = p_j(\delta_{ij} - p_i) \to 0$,
and the cross-entropy gradient $p - y$ is also near zero on every confidently-wrong
token. The network has an opinion, the opinion is wrong, and the gradient carries
almost no signal to change it — the run stops improving while the loss still looks
finite and the logits still look healthy. This is a reason temperature and logit
clipping exist, and a reason a loss that plateaus at a value well above what the
architecture can fit should be checked for saturation before the model is blamed.

## A working training loop, with clipping

Gradient clipping is the cheapest insurance in deep learning: it bounds the update
length to a chosen maximum, so one pathological minibatch produces one bounded
step rather than an unbounded one, and the run continues. It does not fix the
underlying problem but it converts a fatal failure into a visible one. The clip
below rescales the whole gradient jointly, which is the standard choice — scaling
per-tensor would let a tensor with a tiny gradient dominate the result.

```python
MAX_NORM = 1.0


def grad_norm(grads):
    """Euclidean norm of the concatenated gradient, the usual clipping quantity."""
    return float(np.sqrt(sum(float((g ** 2).sum()) for g in grads)))


def clip(grads, max_norm):
    """Rescale all gradients by one common factor so the joint norm fits."""
    total = grad_norm(grads)
    scale = min(1.0, max_norm / (total + 1e-12))
    return [g * scale for g in grads]


n_tr = len(X)
best, history = float("inf"), []
eta = 0.05
for step in range(1, 401):
    a, y = forward(theta)                       # forward; cache every activation
    g = backward(theta, a, y)                   # one chain-rule pass, reverse order
    norm = grad_norm(g)                         # measured before clipping
    g = clip(g, MAX_NORM)                       # bound the step length
    theta = [q - eta * gi for q, gi in zip(theta, g)]
    if step % 100 == 0:
        history.append((step, loss(y), norm))

print("step    loss     gradient norm before clipping")
for step, l, norm in history:
    print(f"{step:4d} {l:8.5f} {norm:12.4f}")

clipped = [(l, n) for _, l, n in history]
print(f"loss fell from {history[0][1]:.5f} to {history[-1][1]:.5f}")
```

The gradient norm column is the diagnostic that a loss curve cannot provide. A run
whose loss is flat might be learning too slowly, or might have vanishing gradients,
or might have a saturated softmax; the gradient norm separates those cases
immediately, because a vanishing gradient shows up as a norm orders of magnitude
below its own early value while slow learning keeps it comparable.

## What this lesson does not settle

Several standard choices are conventions rather than derivations. There is no
theorem that $\beta = 0.9$ is right; $\beta_2 = 0.999$ in particular is a
compromise between reacting to new gradient scales quickly and being stable at
that resolution, and it was set by a regime much smaller than current models. The
claim that mini-batch beats full-batch above a certain size is empirical. And
"Adam generalizes worse than SGD with equivalent decay" is a measurement in a
specific setting, not an established law.

Backpropagation is also not the only option. Forward-mode automatic
differentiation computes a Jacobian-vector product per pass, cheaper when you need
directional derivatives, and several frameworks implement it alongside reverse
mode. Reverse mode is universal not because it is optimal but because a
vector-Jacobian product costs one matrix product, so passing a vector back through
a network of any depth costs one pass.

Finally, none of this is about finding the global minimum, which modern practice
does not attempt. Gradient descent finds a region where the gradient is small
relative to the local scale. Whether that region is a good place to stop is a
question about early stopping and generalization, which is the next lesson.

## References

- David E. Rumelhart, Geoffrey E. Hinton and Ronald J. Williams, "Learning
  Representations by Back-propagating Errors", Nature, 1986 — the paper that made
  the backward pass the standard training mechanism.
- Diederik P. Kingma and Jimmy Ba, "Adam: A Method for Stochastic Optimization",
  2015, arXiv:1412.6980 — the two-moment update rule implemented above.
- Ilya Loshchilov and Frank Hutter, "Decoupled Weight Decay Regularization",
  ICLR 2019, arXiv:1711.05101 — why decay belongs outside the adaptive update.
- Prajit Ramachandran, Barret Zoph and Quoc V. Le, "Searching for Activation
  Functions", arXiv:1710.05941, 2017 — the practical value of warmup in the
  early steps; also You et al., "Large Batch Optimization for Deep Learning:
  Training BERT in 76 minutes", ICLR 2020, arXiv:1904.00962 — the large-batch
  pathology plain SGD gets wrong.
- PyTorch documentation,
  [`torch.nn.utils.clip_grad_norm_`](https://pytorch.org/docs/stable/generated/torch.nn.utils.clip_grad_norm_.html).
