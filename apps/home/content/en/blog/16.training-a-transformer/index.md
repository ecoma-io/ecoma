---
title: 'Training a transformer: from tokens to parameter updates'
description: 'The full training loop traced end to end: batches, forward pass, loss, backward pass, optimizer step, checkpointing.'
date: '2026-09-29'
author: 'John Martin'
tags:
  - training
  - ai
featured: false
cover: ../../../assets/cover-16-training-a-transformer.svg
coverAlt: 'Abstract cycle loop motif on a light background beside the lesson title'
articleId: training-a-transformer
seriesId: pretraining
seriesOrder: 1
contentType: theory
level: intermediate
prerequisites:
  - multi-head-attention-and-transformer-blocks
  - gradient-descent-and-backpropagation
relatedArticleIds:
  - distributed-training-parallelism
  - scaling-laws-parameters-and-data
---

# Training a transformer: from tokens to parameter updates

A transformer learns from exactly one number: how surprised it was at the next
token. Everything else in a pretraining run is machinery built around that
number — how the surprise gets averaged, how it becomes a parameter update,
what happens when a machine dies halfway through, and how many tokens you have
to push through before the update schedule finishes.

After this lesson you should be able to trace a run from a raw text file to a
checkpoint file and name every stage in between, size the compute and memory of
each stage, and explain why two runs that consume the same total tokens can
still end up as different models.

## What one optimizer step actually is

Read this loop before the sections that unpack it; each section explains one
line. It is pseudocode, not runnable code — no framework defines these
operations directly.

```text
// pseudocode; not runnable
// one optimizer step, one data-parallel replica shown
tokens = next_sequence(batch_stream)          # int32 ids, shape [mb, S]
logits = model.forward(tokens[:, :-1])        # [mb, S-1, V], model in bf16
loss = cross_entropy(logits, tokens[:, 1:])   # scalar, mean over tokens
(loss / accum_steps).backward()               # accumulate into .grad buffers
if step % accum_steps == 0:
    scheduler.step()                          # sets eta for this update
    optimizer.step()                          # weights move against the grad
    optimizer.zero_grad(set_to_none=True)
    step += 1
```

Six stages, six sections: the token stream, the forward pass, the loss, the
backward pass, the optimizer step, and the checkpoint. The first three are easy
to reason about; the last three are where runs actually fail.

## Stage 1: the token stream

Text becomes a sequence of integer ids before anything else happens. A
tokenizer maps bytes to subword units, the data loader packs those ids into
fixed-length sequences of length $S$, and the loader serves them in shuffled
order. Two details matter more than they look.

**Sequences are packed, not padded.** A document boundary that does not land on
$S$ is either dropped or concatenated with the next document, because padding a
batch to a common length wastes every flop spent on pad tokens. Masking the
loss at document boundaries is a separate, deliberate choice: without it the
model spends capacity learning that one document ended and another began, which
is not a property of language.

**Shuffle order is the data curriculum.** If the loader feeds documents in
source order — say, sorted by URL — the loss curve reflects that ordering rather
than the data. Real loaders shuffle within a window: fully reshuffling a
multi-terabyte shard set every epoch costs more I/O than the training loop can
absorb, so runs typically shuffle within shards and reshuffle the shard order
between epochs. The number of tokens a run consumes, $D$, is counted from this
stream after packing, which is why the data budget in
[scaling laws](/en/blog/scaling-laws-parameters-and-data) is expressed in tokens
and not in documents or bytes.

## Stage 2: the forward pass and its price

A forward pass is $L$ transformer blocks applied to a `[mb, S, d_model]` tensor,
followed by a projection to the vocabulary $V$. Its cost is the number to
memorize, because every budget in this curriculum is quoted in it:

$$
C_{\text{token}} \approx 6N
$$

where $N$ is the parameter count. The factor 6 is forward ($2N$, one
multiply-accumulate per parameter per token, counted as two FLOPs) plus
backward ($4N$), because each weight also needs a gradient from every output it
touched. This is the standard rule of thumb for matrix-multiply-dominated
models; it ignores optimizer state traffic and activation traffic, which is fine
at short context and not fine at long context.

Work it with a real model. Take a 7B-class decoder with $L = 32$,
$d_{model} = 4096$, $d_{ff} = 11008$, $h = 32$ heads, and a SwiGLU feed-forward
(three matrices rather than two):

| Component                                | Formula                    | Parameters    |
| ---------------------------------------- | -------------------------- | ------------- |
| Attention (Q, K, V, output projections)  | $4Ld_{model}^2$            | 2,147,483,648 |
| Feed-forward, SwiGLU                     | $3Ld_{model}d_{ff}$        | 4,328,521,728 |
| LayerNorms, biases                       | small                      | not counted   |
| Non-embedding total                      | —                          | 6,476,005,376 |
| Embedding table and output head (untied) | $2Vd_{model}$, $V = 32000$ | 262,144,000   |
| Total                                    | —                          | 6,738,149,376 |

Each component row is what its own formula evaluates to, and the two component
rows sum to the non-embedding total, which plus the embedding row gives the
total. The model here is $L = 32$, $d_{model} = 4096$, $d_{ff} = 11008$,
$h = 32$, $V = 32000$, which is a 7B-class decoder.

So

$$
6N = 6 \times 6.476\times10^{9} = 3.886\times10^{10}\ \text{FLOPs per token},
$$

and training on $D = 1.4\times10^{12}$ tokens costs

$$
C = 6ND = 3.886\times10^{10} \times 1.4\times10^{12}
  = 5.44\times10^{22}\ \text{FLOPs} = 54.4\ \text{ZFLOP}.
$$

Recomputation is optional, and buying it with FLOPs is a choice rather than a
requirement of [distributed training](/en/blog/distributed-training-parallelism).
Storing every activation needed for backward pass costs memory proportional to
the number of layers and the sequence length; the alternative is to keep only
some of them and rebuild the rest during backward. Rebuilding one layer's
forward pass costs roughly $2N/L$ extra FLOPs per token, so recomputing every
layer turns $6N$ into $8N$ per token, about 33% more. Runs that fit without it
should skip it; runs that do not fit, or whose optimizer state does not, turn it
on and quote the $8ND$ budget. A quoted $6ND$ is therefore a statement about
which of the two the run chose, not a law of nature.

The attention term is where $6N$ becomes an approximation. The matrix
multiplications above are linear in $S$, but the score matrices are $h$ tensors
of $S \times S$, so attention adds work proportional to $LhS^2$ per sequence.
Relative to the $6N$ term for the model above:

| Context $S$ | Attention FLOPs per token | Share of the $6N$ term |
| ----------- | ------------------------- | ---------------------- |
| 2048        | $1.07\times10^{9}$        | 2.8%                   |
| 4096        | $2.15\times10^{9}$        | 5.5%                   |
| 8192        | $4.29\times10^{9}$        | 11.1%                  |
| 32768       | $1.72\times10^{10}$       | 44.2%                  |
| 131072      | $6.87\times10^{10}$       | 176.9%                 |

Per token, attention costs $4Ld_{model}S$ FLOPs — four, not two, because the
score matrix $QK^T$ and the weighted sum against $V$ each cost $2Ld_{model}S$ per
token over the sequence. There is no $h$ in that expression, and that is worth
pausing on. Each head contracts a slice of width $d_{model}/h$, so one head
spends $S^2 \cdot (d_{model}/h)$ FLOPs on $QK^T$ and the same again on the
weighted sum. Summing over $h$ heads multiplies by $h$ and divides by $h$
again, which cancels exactly: splitting a $d_{model}$-wide attention into more,
narrower heads costs the same total arithmetic and buys the _expressiveness_ of
separate subspaces, not a saving. Worth stating because "attention is quadratic
in $S$" is true while "more heads cost more compute" is false.

The crossover where the $S$-terms equal the constant term is near
$S \approx 74000$, which is why $6N$ is a good estimate for a 7B decoder out to
tens of thousands of tokens and becomes a floor beyond that. Two things move
the crossover left: a larger $d_{model}/L$ ratio, since the constant term is
roughly $6N$ and the $S$-term is $4Ld_{model}S$; and a shorter training
sequence, since short-context pretraining never pays the quadratic term at all.

```python
L, d_model, d_ff, h, V = 32, 4096, 11008, 32, 32000

attention = 4 * L * d_model**2
feed_forward = 3 * L * d_model * d_ff
non_embedding = attention + feed_forward
embedding = 2 * V * d_model
total = non_embedding + embedding

print(f"attention      {attention:>15,}")
print(f"feed-forward   {feed_forward:>15,}")
print(f"non-embedding  {non_embedding:>15,}")
print(f"embedding      {embedding:>15,}")
print(f"total          {total:>15,}")

six_n = 6 * non_embedding
compute = six_n * 1.4e12
print(f"6N per token   {six_n:.4e} FLOPs")
print(f"6ND for 1.4e12 {compute:.4e} FLOPs = {compute / 1e21:.3f} ZFLOP")

# Không có `h` ở đây: mỗi head rộng `d_model / h`, nên `h` lần và `1/h` lần
# triệt tiêu nhau. Assert bên dưới xác nhận bằng cách đếm theo từng head.
for S in (2048, 4096, 8192, 32768, 131072):
    flops = 4 * L * S * d_model
    # Cùng con số khi đếm theo đầu: L lớp × h đầu × 4S²·(d_model/h) trên một
    # chuỗi, chia cho S để ra mỗi token. `h` triệt tiêu với `1/h`.
    heads_form = L * h * 4 * S * S * (d_model // h) / S
    assert flops == heads_form, (flops, heads_form)
    print(f"S={S:>7}: attention {flops:.2e} FLOPs/token, "
          f"{100 * flops / six_n:.1f}% of the 6N term")

print(f"crossover S    {six_n / (4 * L * d_model):.0f}")
```

## Stage 3: the loss, and the three choices that change its value

The objective is next-token cross-entropy:

$$
L = -\frac{1}{n}\sum_{t} \log p_\theta(x_{t+1} \mid x_{\le t})
$$

where $n$ is the number of predicted tokens. This is both the quantity that
becomes the gradient and the quantity reported on a held-out set — the same
symbol doing two jobs. Read the two loss curves together: a widening gap is
overfitting, and a flat held-out curve under a falling training curve is a data
problem, not an optimization one.

Three implementation choices change the number you get, not merely its scale.

**Mean, not sum.** A loss summed over tokens scales with $S$, so changing the
sequence length silently changes the effective learning rate. Every serious
implementation divides by the token count.

**Mixed precision, done properly.** The forward pass runs in bfloat16 to halve
weight and activation traffic. bf16 has float32's exponent range (maximum
$\approx 1.7\times10^{38}$) but only 7 explicit mantissa bits, so the relative
rounding step near 1.0 is $2^{-7} \approx 7.8\times10^{-3}$. That mantissa is
the part that gets sacrificed, and it is why the optimizer keeps an fp32 master
copy of the weights: the update happens in fp32 and only the forward pass sees
bf16 values. float16 was the earlier choice and fails in the opposite
direction — 10 mantissa bits, but a maximum of 65504 and a smallest normal of
$\approx 6.1\times10^{-5}$, so gradients underflow and every large model needed
loss scaling to survive. bf16 removed that whole class of bug, which is why it
became the default.

**Dropout is usually off.** Pretraining at scale is regularized by data volume,
not stochasticity. Setting $p = 0$ is conventional rather than universal, and
enabling dropout mid-run is a hyperparameter change like any other.

## Stage 4: backward, and why gradient accumulation is exact

Backpropagation computes $\nabla_\theta L$ by the chain rule; the mechanics are
in [gradient descent and backpropagation](/en/blog/gradient-descent-and-backpropagation).
The engineering question is different: a batch large enough to give a
low-variance gradient rarely fits in one device's memory.

Gradient accumulation answers it. Instead of one batch of $b_{\text{eff}}$
sequences, run $k$ micro-batches of $m$ sequences each and sum their gradients.
Because the gradient of a mean is linear, averaging micro-batch gradients is
_exactly_ the gradient of the full batch:

$$
\frac{1}{G}\sum_{g=1}^{G}\frac{1}{k}\sum_{i=1}^{k}\nabla L_{gi}
= \frac{1}{Gk}\sum_{g,i}\nabla L_{gi}.
$$

No approximation and no accumulated error, and the two ways to get it wrong
have different signatures, which matters when you are staring at a loss curve
trying to work out which one you have.

Dropping a division by the replica count scales the whole gradient by $G$ and
changes nothing else. With $G = 3$ that is an update three times too large, a
factor that is trivially visible: the loss diverges rather than plateauing. The
subtler bug is applying the running-mean decay $\hat{g} \leftarrow (1 - 1/k)\hat{g}

- (1/k)g$ while $\hat{g}$ already holds the _sum_ of accumulated gradients.
  That decays a sum with a formula meant for a mean, so each parameter ends up
  weighted differently and the gradient is distorted in direction, not merely in
  scale. Both bugs are reproduced below on unit-variance inputs.

```python
import numpy as np

rng = np.random.default_rng(0)
G, k, n = 3, 4, 256                      # replicas, micro-batches, parameters
micro = rng.standard_normal((G, k, n))    # unit-variance micro-batch gradients

correct = micro.mean(axis=(0, 1))
assert np.allclose(correct, micro.reshape(-1, n).mean(axis=0), atol=1e-12)

# Bug 1: divide by the micro-batch count but forget the replica count.
# Σ_{g,i} / k thay vì Σ_{g,i} / (Gk): đúng một `k` bị thiếu `G`.
drop_replica = micro.sum(axis=(0, 1)) / k
print(f"dropped 1/G   scale {np.median(drop_replica / correct):.3f} (want 1.000)")

# Bug 2: running-mean decay applied while the accumulator holds a sum.
acc = np.zeros(n)
running = []
for t in range(k):
    acc = acc + micro[0, t]
    running.append((1 - 1 / k) * acc + micro[0, t] / k)

wrong = np.array(running)[-1]
truth = micro[0].mean(axis=0)
rms = np.sqrt(((wrong - truth) ** 2).mean())
print(f"decayed a sum rms |diff| {rms:.4f} on unit-variance inputs")
print(f"  scale {np.median(wrong / truth):.3f}, so it is a distortion, not a rescale")
```

**Effective batch size** is how many tokens one optimizer step consumes. With
$m$ sequences per device per micro-batch, accumulation depth $k$, and $G$
data-parallel replicas:

$$
b_{\text{eff}} = m \times S \times k \times G.
$$

For $m = 4$, $S = 2048$, $k = 8$, $G = 1024$:

| Quantity                                                 | Value      |
| -------------------------------------------------------- | ---------- |
| Tokens per micro-batch per device                        | 8,192      |
| Tokens per device per optimizer step                     | 65,536     |
| Global tokens per optimizer step                         | 67,108,864 |
| Optimizer steps to consume $D = 1.4\times10^{12}$ tokens | 20,862     |

The step count is what a learning-rate schedule counts, so a run's headline
hyperparameters are really four numbers: $b_{\text{eff}}$, the peak $\eta$,
warmup length, and decay shape. Two runs with the same $D$ and different
$b_{\text{eff}}$ have seen the same tokens but taken a different number of
steps, which is one reason they diverge.

## Stage 5: the optimizer step, and the memory it implies

AdamW keeps a first moment $m_t$ and a second moment $v_t$ per parameter, and
applies weight decay separately from the gradient:

$$
\theta_{t+1} = \theta_t - \eta_t\left(
  \frac{\hat{m}_t}{\sqrt{\hat{v}_t} + \varepsilon} + \lambda\theta_t
\right).
$$

The optimizer _state_ is the point. With bf16 weights and gradients, an fp32
master copy, and fp32 moments, each parameter costs 16 bytes. For the 6.738
billion parameters above that is 108 GB of persistent state before a single
activation is allocated — more than most individual accelerators have. Every
distributed memory-saving technique in
[the next lesson](/en/blog/distributed-training-parallelism) exists to move
that number off a single device.

The schedule is warmup then decay. Warmup exists because Adam's moments are
uninitialized at step 0 and early updates are correspondingly large; a linear
ramp from zero to peak over roughly 1–3% of the run is conventional. After the
peak, cosine decay toward a floor, commonly 10% of peak. Sampled every 1000
steps of a 2-million-step run peaking at $\eta = 3\times10^{-4}$:

| Step    | $\eta$              | Phase               |
| ------- | ------------------- | ------------------- |
| 0       | $1.50\times10^{-7}$ | warmup, linear      |
| 500     | $7.52\times10^{-5}$ | warmup, linear      |
| 1999    | $3.00\times10^{-4}$ | peak                |
| 250000  | $2.90\times10^{-4}$ | early decay         |
| 1000000 | $1.65\times10^{-4}$ | mid decay           |
| 1999999 | $3.00\times10^{-5}$ | floor (10% of peak) |

The mean $\eta$ over the run is 0.55 of the peak — the number to use when
comparing two runs whose schedules differ. A loss spike early in a run, one that
never fully recovers, usually means the peak is too high or warmup too short;
the two are hard to distinguish from the curve alone, which is why warming up
while watching a short run is standard practice rather than caution.

## Stage 6: checkpoints, and why resume is a correctness requirement

A checkpoint is enough state to resume _exactly_: parameters, optimizer moments,
the step counter, the learning-rate scheduler position, the RNG state, and the
data-loader position. Drop any one and the resumed run is not the run you meant.

The failure this prevents is not hypothetical. Multi-day runs lose machines,
network partitions, and spot capacity gets reclaimed; a single lost device
otherwise costs the entire run. The interval is a trade-off — checkpoints
written too often stall the step, since writing hundreds of gigabytes is not
free, and too rarely means repeating work. Runs typically checkpoint every few
hundred to a few thousand steps.

Two details cause _silent_ divergence, which is worse than a crash because the
run looks healthy:

- **RNG state.** Dropout masks, shuffling, and any injected noise draw from a
  generator. Resuming with a fresh seed produces a different run, and the
  symptom looks exactly like a learning-rate problem.
- **Data-loader position.** Resuming from the top of the stream repeats data.
  Over a large shuffled window this is negligible; on a small corpus it
  double-trains a slice of the data — the same failure that deduplication
  exists to prevent, one layer up, in
  [data curation](/en/blog/data-curation-quality-and-contamination).

A cheap check catches both: keep the model in train mode across the boundary
and verify the loss on the first post-resume batch matches the pre-crash value
to within normal step-to-step variation. A loss that steps up by a visible
amount at resume is missing state, not an optimization problem.

## What the loop does not decide

The loop above is the happy path, and it deliberately says nothing about three
things.

**It does not tell you the compute-optimal size.** $C = 6ND$ prices a run; it
does not choose $N$ and $D$ for you. That allocation is
[the subject of the next lesson](/en/blog/scaling-laws-parameters-and-data),
and it is contested.

**It does not tell you the tokens were worth training on.** A duplicate
paragraph trains a model roughly as badly as a novel one trains it well, and no
amount of compute accounting detects that. Filtering, deduplication, and
contamination checks are separate machinery, covered in
[data curation](/en/blog/data-curation-quality-and-contamination).

**It does not fit on one device.** The 108 GB of optimizer state plus
activations is why every large run is distributed, which is
[lesson 19](/en/blog/distributed-training-parallelism).

## References

- Vaswani et al. 2017, _Attention Is All You Need_,
  [arXiv:1706.03762](https://arxiv.org/abs/1706.03762).
- Hoffmann et al. 2022, _Training Compute-Optimal Large Language Models_,
  [arXiv:2203.15556](https://arxiv.org/abs/2203.15556).
- Kaplan et al. 2020, _Scaling Laws for Neural Language Models_,
  [arXiv:2001.08361](https://arxiv.org/abs/2001.08361).
- Shoeybi et al. 2020, _Megatron-LM: Training Multi-Billion Parameter Language
  Models Using Model Parallelism_ — the canonical account of mixed precision and
  tensor/pipeline parallelism. Identifier not verified here, cited in prose.
- PyTorch documentation for
  [`torch.optim.AdamW`](https://pytorch.org/docs/stable/generated/torch.optim.AdamW.html),
  [`torch.amp`](https://pytorch.org/docs/stable/amp.html), and
  [fully sharded data parallel](https://pytorch.org/docs/stable/fsdp.html).
