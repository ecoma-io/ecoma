---
title: 'Distributed training: data, tensor, and pipeline parallelism'
description: 'Why training runs on many devices, and how data, tensor and pipeline parallelism trade communication against memory.'
date: '2026-10-02'
author: 'John Martin'
tags:
  - training
  - ai
featured: false
cover: ../../../assets/cover-19-distributed-training-parallelism.svg
coverAlt: 'Abstract device grid motif on a light background beside the lesson title'
articleId: distributed-training-parallelism
seriesId: pretraining
seriesOrder: 4
contentType: research-review
level: advanced
prerequisites:
  - training-a-transformer
  - linear-algebra-projections-and-rank
relatedArticleIds:
  - kv-cache-memory-of-long-contexts
  - quantization-precision-and-efficiency
---

# Distributed training: data, tensor, and pipeline parallelism

One device cannot hold a modern model. The optimizer state alone — fp32 master
weights, fp32 Adam moments, bf16 weights, bf16 gradients — is 16 bytes per
parameter, which is 108 GB for a 6.7-billion-parameter model before a single
activation is allocated. Add activations and the requirement is several hundred
gigabytes for one sequence. Meanwhile one device's compute is roughly four
orders of magnitude short of what the budget in
[scaling laws](/en/blog/scaling-laws-parameters-and-data) requires.

So training is distributed, and there are three qualitatively different ways to
split a model across devices. Each solves a different problem, and choosing
between them follows from which resource is scarce and how much communication
the split forces.

After this lesson you should be able to compute the memory each axis relieves,
the communication volume each imposes, and the pipeline bubble for a given
configuration.

## What actually costs the memory

Recall the AdamW update from [the training loop](/en/blog/training-a-transformer):
each parameter carries a gradient, a master weight copy, and two moments. At 16
bytes per parameter across 6.738 billion parameters that is 108 GB of persistent
state. Activations are the second consumer, and they are where context length
bites.

What matters is not the weights but the tensors autograd must _retain_ between
the forward and backward passes. Counting them for one pre-LayerNorm decoder
layer at $S = 8192$, $d_{model} = 4096$, $d_{ff} = 11008$, $h = 32$, with bf16
activations and fp32 dropout masks:

````python
S, d_model, d_ff, h = 8192, 4096, 11008, 32
BF16, FP32 = 2, 4

# (leading dimensions..., bytes per element)
retained = {
    "LayerNorm input": (S, d_model, BF16),
    "LayerNorm output feeding Q, K, V": (S, d_model, BF16),
    "Attention scores": (h, S, S, BF16),
    "Softmax output": (h, S, S, BF16),
    "Attention dropout mask": (h, S, S, FP32),
    "Attention output": (S, d_model, BF16),
    "Feed-forward LayerNorm input": (S, d_model, BF16),
    "Feed-forward LayerNorm output": (S, d_model, BF16),
    "GELU input": (S, d_ff, BF16),
    "Down-projection input": (S, d_ff, BF16),
}

total = 0
for name, spec in retained.items():
    shape, item = spec[:-1], spec[-1]
    size = 1
    for extent in shape:
        size *= extent
    nbytes = size * item
    total += nbytes
    print(f"{name:34s} {size * item / 1e6:9.0f} MB")

print(f"{'per layer':34s} {total / 1e9:9.2f} GB")
print(f"{'32 layers':34s} {total * 32 / 1e9:9.0f} GB")

s2 = sum(
    v[0] * v[1] * v[2] * v[3]
    for v in retained.values()
    if v[0] == h and v[1] == S and v[2] == S
)
print(f"share of the three S-squared tensors: {s2 / total * 100:.1f}%")
```text
LayerNorm input                           67 MB
LayerNorm output feeding Q, K, V          67 MB
Attention scores                        4295 MB
Softmax output                          4295 MB
Attention dropout mask                  8590 MB
Attention output                          67 MB
Feed-forward LayerNorm input              67 MB
Feed-forward LayerNorm output             67 MB
GELU input                               180 MB
Down-projection input                    180 MB
per layer                              17.88 GB
32 layers                                572 GB
share of the three S-squared tensors: 96.1%
````

The three $S^2$ tensors are 96.1% of the total, and that ratio is the point:
memory in a long-context layer grows quadratically in sequence length while the
model's weights do not move at all. Quartering $S$ to 2048 gives 1.25 GB per
layer and 40 GB across the model — a factor of 14 down for a factor of 4 less
text, and still 86% from those three tensors. This is why attention
implementations that never materialize the full score matrix (the FlashAttention
family) change what is trainable at all: they reduce the retained tensor from
$h \times S \times S$ to $O(S)$, taking 572 GB down to roughly 35 GB without
changing the model's mathematics.

**Activation recompute** attacks the same number differently: discard the
intermediates, keep only the layer's input, and recompute during the backward
pass. Keeping just the boundary input — an $S \times d_{model}$ tensor, 0.067
GB — costs 2.15 GB for all 32 layers instead of 572 GB, a 99.6% reduction, at
the price of one extra forward pass. In FLOPs this turns $6N$ per token into
$8N$, a 33% increase. Megatron-style _selective_ recompute is the middle path:
recompute only the expensive attention sub-block, trading a smaller saving for
less added compute.

## Data parallelism: split the batch, then pay for it

Data parallelism (DP) replicates the whole model on every device and splits the
batch. Each replica computes a gradient on its own shard; the gradients must be
summed before the optimizer step, which is a gradient all-reduce.

DP is the first axis to reach for because it is the only one with no intra-layer
communication. The cost is entirely in the all-reduce, and it has a specific
shape. In a ring all-reduce each device sends and receives roughly
$2(N_{params} \cdot b)$ bytes per step, where $b$ is bytes per element —
essentially independent of the device count:

| Data-parallel degree | Per-device all-reduce traffic (bf16) |
| -------------------- | ------------------------------------ |
| 8                    | 23.6 GB                              |
| 64                   | 26.5 GB                              |
| 512                  | 26.9 GB                              |
| 2048                 | 26.9 GB                              |

Going from 8 to 2048 devices _halves the wall-clock time_ of the all-reduce
while leaving each device's byte count nearly unchanged. That unchanged byte
count is the problem: it is now a larger fraction of a step that is
correspondingly shorter, the collective stops hiding behind compute, and the
step time stops scaling.

Two standard mitigations:

- **Bucketing and overlap.** Coalesce small gradient tensors into large buffers
  and overlap communication with the backward pass of unrelated layers. Both
  attack the constant.
- **Sharding the state (ZeRO, FSDP).** Rather than replicating parameters,
  gradients and optimizer state everywhere, partition them across devices and
  reconstruct each piece when needed. ZeRO partitions optimizer state (stage
  1), gradients (stage 2) and parameters (stage 3); FSDP is the PyTorch
  implementation. This turns the 108 GB of persistent state into $108/G$ GB per
  device — 105 MB at 1024-way sharding, against 27.0 GB for parameters alone at
  the same degree — and is why DP scales to thousands of devices where it
  previously bottlenecked.

DP's ceiling is set by how much state it can shard before communication dominates,
and by the fact that it cannot split a layer. When one layer's state no longer
fits on a device even sharded, DP is exhausted and the other axes apply.

## Tensor parallelism: split one matrix multiply

Tensor parallelism (TP) cuts a single layer across devices along its matrix
dimension. Given an input $\mathbf{x} \in \mathbb{R}^{n \times d}$ and weight
$W \in \mathbb{R}^{d \times d_{model}}$ (rows × columns), the output is
$\mathbf{y} = \mathbf{x}W$. Partitioning $W$ by rows into $k$ blocks
$W = [W_1; \dots; W_k]$ lets each device compute a slice $\mathbf{y}_i$
independently — no communication at all on the way in, because $\mathbf{x}$ is
replicated.

Communication appears at the _next_ projection, which needs the full
$\mathbf{y}$. An all-gather reconstructs it. The feed-forward layer does the
same in reverse: with SwiGLU, gate and up each produce a $d_{ff}$-wide
intermediate, and the down-projection needs all of it, so a reduce-scatter
returns partial sums.

For one feed-forward block at $d_{model} = 4096$, $d_{ff} = 11008$, $S = 4096$,
TP degree 8, bf16:

| Direction                                              | Bytes per rank |
| ------------------------------------------------------ | -------------- |
| All-gather of the $d_{ff}$-wide intermediate (forward) | 11.3 MB        |
| Reduce-scatter to $d_{model}$ (forward)                | 4.2 MB         |
| Forward total                                          | 15.5 MB        |
| With backward (≈2x)                                    | 46.4 MB        |

The FLOPs in that block are $3 \times 2 \times S \times d_{model} \times d_{ff} =
1.108\times10^{12}$ forward and $3.32\times10^{12}$ with backward, which is also
the scope of the byte count. Against 46.4 MB per rank the ratio of communication
time to compute time is 0.014 at 300 TFLOP/s against 300 GB/s, and 0.005 at
900 GB/s. **This is why tensor parallelism works**: TP reduces the matrix sizes,
and reduced matrix sizes make the _compute_ slower, which makes the
_communication_ relatively cheaper.

The same arithmetic explains why TP stays inside a small group. Communication
here is a few collectives synchronized within a layer, so the latency is
exposed rather than overlapped. TP is confined to devices in one high-bandwidth
domain — typically 8 GPUs on a node — and the rest of the device count is served
by pipeline parallelism.

## Pipeline parallelism: split by layer, and pay for the bubble

Pipeline parallelism (PP) assigns consecutive layers to different devices. As a
micro-batch proceeds, stage $k$ begins on the _next_ micro-batch, so after the
pipeline fills every stage is busy at once — except that the first stage must
fill before the last stage drains, and nothing else runs during either phase.

For a pipeline of $p$ stages processing $m$ micro-batches, the fraction of
ideal-time lost to this fill/drain is the **bubble fraction**:

$$
b = \frac{p - 1}{m + p - 1}.
$$

The derivation is a count of idle slots. Filling and draining takes $p-1$
stage-times on top of the $m$ stage-times of real work, so each stage is
occupied for $m + p - 1$ slots but useful for only $m$ of them. The idle
fraction is $(p-1)/(m+p-1)$ and the useful fraction is $m/(m+p-1)$; the two sum
to 1 exactly, which is a cheap check that the formula was read correctly. At
$p = 16$, $m = 64$: 79 slots occupied, 64 useful, 18.99% idle.

```python
## Runnable; reproduces the two tables below.
def bubble(p, m):
    """Fraction of ideal time lost to pipeline fill and drain.

    p = pipeline stages, m = micro-batches. Each stage is occupied for
    m + p - 1 slots but useful for only m of them.
    """
    if m < p:
        raise ValueError(f"m={m} < p={p}: never reaches steady state")
    return (p - 1) / (m + p - 1)


for m in (8, 16, 32, 64, 128):
    row = f"m={m:<4d}"
    for p in (8, 16, 32, 64):
        row += f"{100 * bubble(p, m):7.1f}%" if m >= p else "     n/a"
    print(row)

for tp, pp, dp in ((8, 2, 32), (8, 4, 16), (4, 8, 16), (8, 8, 8)):
    assert tp * pp * dp == 512
    print(f"TP={tp} PP={pp} DP={dp}: {100 * bubble(pp, dp):.1f}% bubble")
```

Requiring $m \geq p$, so the pipeline reaches steady state:

| Bubble fraction | $p = 8$ | $p = 16$ | $p = 32$ | $p = 64$ |
| --------------- | ------- | -------- | -------- | -------- |
| $m = 8$         | 46.7%   | 65.2%    | 79.5%    | 88.7%    |
| $m = 16$        | 30.4%   | 48.4%    | 66.0%    | 79.7%    |
| $m = 32$        | 17.9%   | 31.9%    | 49.2%    | 66.3%    |
| $m = 64$        | 9.9%    | 19.0%    | 32.6%    | 49.6%    |
| $m = 128$       | 5.2%    | 10.5%    | 19.5%    | 33.0%    |

At $p = 64$, $m = 64$ the pipeline is 49.61% idle — almost as bad as a shallow
one, because one micro-batch per stage leaves no overlap at all.

At 512 devices in a 3D layout, the bubble is set by $p$ and the DP degree $m$:

| Layout (TP × PP × DP) | Devices | Bubble |
| --------------------- | ------- | ------ |
| 8 × 2 × 32            | 512     | 3.0%   |
| 8 × 4 × 16            | 512     | 15.8%  |
| 4 × 8 × 16            | 512     | 30.4%  |
| 8 × 8 × 8             | 512     | 46.7%  |

Two things follow. The bubble shrinks only as $1/m$, so halving the bubble costs
doubling the micro-batches. And **more micro-batches cost memory**, because all
$m$ are in flight at once: at $S = 8192$ with $p = 16$, the in-flight activation
shard grows from 0.13 GB at $m = 16$ to 1.07 GB at $m = 128$. PP trades memory
for utilization, a trade that eventually runs out of memory.

Later methods restructure this: 1F1B (forward on one micro-batch, backward on
another) and zero-bubble schedules change when activations are held and when
backward passes execute, so fewer devices idle. The formula above is the ideal
1F1B ceiling; the alternatives go below it at the cost of scheduling machinery.

## Sequence parallelism and the 3D combination

Sequence parallelism (SP) splits the _sequence_ dimension of LayerNorm and
dropout across devices, so activations are not replicated across the TP group.
It is a companion to tensor parallelism rather than an independent axis: with TP
alone, LayerNorm inputs and dropout masks are replicated, so the retained memory
for those tensors does not shrink with the TP degree. SP removes that
replication, cutting them by $1/TP$ as well — a factor of 8 at TP = 8.

The three axes compose multiplicatively: a
$\text{TP} \times \text{PP} \times \text{DP} = N$ device layout runs each layer
sharded across TP devices, assigns layers to PP stages, and splits the batch
across DP replicas. The assignment is an optimization, not a formality — the
standard constraint is that TP stays within a node (so $4 \leq \text{TP} \leq
8$), PP fills out the device count while keeping the bubble acceptable, and DP
takes the remainder.

## What this costs, and what it does not fix

**Communication is not free, and the axes differ in kind.** DP's all-reduce is
bulk, overlappable and bandwidth-bound — amenable to sharding and overlap. TP's
collectives are small, frequent, latency-bound, and must synchronize within a
layer, which is why TP is confined to a node. PP sends point-to-point
activations between adjacent stages, so its cost grows with sequence length but
not with batch size.

**The parallel layout is itself a hyperparameter.** Changing TP degree changes
the floating-point reduction order, so two runs with identical hyperparameters
but different layouts produce slightly different results. And the layout does
not decide $N$ or $D$ — that comes from
[the scaling laws](/en/blog/scaling-laws-parameters-and-data), meeting training
only through wall-clock, since a 30% bubble means the same budget buys 30% fewer
tokens. **None of it fixes what the tokens are worth**, which is
[data curation](/en/blog/data-curation-quality-and-contamination).

**Training and inference want opposite machines.** Every axis here assumes a
micro-batch of thousands of tokens, which is what makes weights amortized over
enough arithmetic to be worth reading. At decode time a step processes one
token, so a weight-stationary GEMM's arithmetic intensity is exactly $M$ FLOP
per byte — at $M = 1$ the device reads 2 bytes per 2 FLOPs and is memory-bound
by roughly 300x on a 989 TFLOP/s, 3.35 TB/s device. The same fix applies —
raise $M$ by batching more sequences — and that is what continuous batching and
the paging of KV cache blocks described by Kwon et al. 2023 are built around.
See [the KV cache lesson](/en/blog/kv-cache-memory-of-long-contexts) and
[quantization](/en/blog/quantization-precision-and-efficiency) for that
half of the story.

## References

- Shoeybi et al. 2020, _Megatron-LM: Training Multi-Billion Parameter Language
  Models Using Model Parallelism_ — the canonical account of tensor and pipeline
  parallelism and selective recompute. Identifier not verified here.
- Huang et al. 2019, _GPipe: Efficient Training of Giant Neural Networks using
  Pipeline Parallelism_ — the bubble and micro-batch formulation. Identifier not
  verified here.
- Rajbhandari et al. 2019, _ZeRO: Memory Optimizations Toward Training Trillion
  Parameter Models_ — optimizer, gradient and parameter sharding. Identifier not
  verified here.
- Narayanan et al. 2021, _Efficient Large-Scale Language Model Training on GPU
  Clusters Using Megatron-LM_ — 3D parallelism at scale. Identifier not verified
  here.
- Dai et al. 2021, _DeepSpeed: Memory-Efficient Optimizations for Training Huge
  Models_ — ZeRO implementation and pipeline scheduling. Identifier not verified
  here.
- Kwon et al. 2023, _Efficient Memory Management for Large Language Model
  Serving with PagedAttention_,
  [arXiv:2309.06180](https://arxiv.org/abs/2309.06180) — the inference-side
  memory story, cited as the contrast to the training regime above.
- PyTorch documentation for
  [`torch.distributed.fsdp`](https://pytorch.org/docs/stable/fsdp.html),
  `DistributedDataParallel`, and
  [`torch.distributed.pipelining`](https://pytorch.org/docs/stable/distributed.pipelining.html).
