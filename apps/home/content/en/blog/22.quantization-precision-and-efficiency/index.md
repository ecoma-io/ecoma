---
title: 'Quantization: trading numerical precision for efficiency'
description: 'Weight and activation quantization, calibration, measured quality loss, and why smaller weights do not automatically mean faster inference.'
date: '2026-10-05'
author: 'John Martin'
tags:
  - inference
  - ai
featured: false
cover: ../../../assets/cover-22-quantization-precision-and-efficiency.svg
coverAlt: 'Abstract quantize steps motif on a light background beside the lesson title'
articleId: quantization-precision-and-efficiency
seriesId: inference
seriesOrder: 3
contentType: theory
level: intermediate
prerequisites:
  - kv-cache-memory-of-long-contexts
relatedArticleIds:
  - supervised-fine-tuning-instructions
  - llm-inference-prefill-and-decode
---

# Quantization: trading numerical precision for efficiency

Reducing a model's weights from 16 bits to 4 is the most popular way to make an
LLM deployable, and it is also the most widely mis-sold. A 4× reduction in bytes
does not produce a 4× faster service, and the gap between the two numbers is where
the engineering actually lives. After this lesson you should be able to write and
run a quantizer, explain why outlier channels break low-precision schemes, list
the families of production algorithms by what they change, and predict from first
principles whether a given quantization will make a memory-bound workload faster.

The starting point is the roofline arithmetic from
[the inference lesson](/en/blog/llm-inference-prefill-and-decode). At batch size 1
a decode step is memory-bandwidth-bound: its time is the weight bytes divided by
device bandwidth. That single fact is the reason quantization is worth doing, and
also the reason it does not deliver what its bit count suggests.

## What quantization does

Quantization maps a continuous value to a discrete one. For a symmetric
per-tensor scheme with $b$ bits, the largest magnitude in the tensor sets a
fixed step $\Delta$, and every weight is replaced by the nearest multiple of it:

$$
\Delta = \frac{\max_i |w_i|}{2^{b-1} - 1}, \qquad
\hat{w}_i = \Delta \cdot \operatorname{round}\!\left(\frac{w_i}{\Delta}\right)
$$

At $b = 16$ and bf16 that step is absurdly fine — bf16 has 8 explicit mantissa
bits and $2^{15}-1 = 32767$ levels, so 16-bit absmax quantization is essentially
the identity. At $b = 4$ there are $2^3-1 = 7$ positive levels, and the step is
determined by the single largest weight in the tensor. Every other weight is
forced onto a 7-step grid relative to that extreme.

That last sentence is the whole problem in one line. The error on any individual
weight is at most $\Delta/2$, which sounds small; but $\Delta$ is set by the
outlier, so all 32767 of the _ordinary_ weights inherit a coarse grid from one
extreme value.

Here is that measured, on a synthetic weight matrix with one deliberately
outlying column:

```python
"""Symmetric absmax quantization, and why the error is not a smooth function of bits."""

import numpy as np


def quantize_dequantize(x, bits):
    """Round a float array to `bits` and back.

    `qmax` is the largest representable level, so the quantization step is
    absmax(x) / qmax and every value lands on step * round(x / step).
    """
    qmax = 2 ** (bits - 1) - 1
    step = np.abs(x).max() / qmax
    q = np.clip(np.round(x / step), -qmax - 1, qmax)
    return q * step


def relative_error(x, x_hat):
    return np.linalg.norm(x - x_hat) / np.linalg.norm(x)


def groupwise(x, bits, group):
    """One scale per row per group of `group` consecutive input columns."""
    qmax = 2 ** (bits - 1) - 1
    rows, cols = x.shape
    blocked = x.reshape(rows, cols // group, group)
    step = np.abs(blocked).max(axis=2, keepdims=True) / qmax
    q = np.clip(np.round(blocked / step), -qmax - 1, qmax)
    return (q * step).reshape(rows, cols)


rng = np.random.default_rng(0)
W = rng.standard_normal((256, 512))
W[:, 100] *= 30.0  # one systematic outlier channel, as real weight matrices have

print(f"weight matrix, {W.shape[0]} rows x {W.shape[1]} columns, absmax {np.abs(W).max():.1f}\n")

print("one scale for the whole matrix")
for bits in (8, 4, 2):
    print(f"  {bits} bit: relative error {relative_error(W, quantize_dequantize(W, bits)):.3f}")

print("\n4 bit, one scale per row per group of input columns")
for group in (512, 128, 64):
    error = relative_error(W, groupwise(W, 4, group))
    overhead = 16 / group
    print(f"  group {group:3d}: relative error {error:.3f}, scale overhead {overhead:.3f} bits/weight")

print("\nsame sweep on a matrix with no outlier channel")
plain = rng.standard_normal((256, 512))
for bits in (8, 4, 2):
    print(f"  {bits} bit: relative error {relative_error(plain, quantize_dequantize(plain, bits)):.3f}")
```

```
weight matrix, 256 rows x 512 columns, absmax 86.2

one scale for the whole matrix
  8 bit: relative error 0.117
  4 bit: relative error 0.607
  2 bit: relative error 0.875

4 bit, one scale per row per group of input columns
  group 512: relative error 0.464, scale overhead 0.031 bits/weight
  group 128: relative error 0.239, scale overhead 0.125 bits/weight
  group  64: relative error 0.173, scale overhead 0.250 bits/weight

same sweep on a matrix with no outlier channel
  8 bit: relative error 0.010
  4 bit: relative error 0.190
  2 bit: relative error 0.965
```

Three things to read off this. First, error grows steeply as bits fall: 0.117 →
0.607 → 0.875 across 8, 4 and 2 bits, not the gentle factor of two one would
expect. Second, the outlier column dominates — the same 4-bit sweep on a matrix
without it gives 0.190 instead of 0.607, a factor of 3.2. Third, shrinking the
scale granularity recovers most of the loss: going from one scale per 512 weights
to one per 64 cuts the 4-bit error from 0.464 to 0.173, for 0.25 extra bits per
weight in fp16 scales.

Note the 2-bit line in the last block: without an outlier, error _rises_ to 0.965
as bits drop from 4 to 2, because the grid has only 3 representable levels and
clipping saturates. The failure is not graceful degradation into noise; it is a
cliff.

## Weights are not activations, and only one of them is static

Quantization literature distinguishes two targets and the distinction decides
which algorithm applies.

**Weight quantization** replaces $W$ with $\hat{W}$ offline and stores integers.
This is a solved engineering problem for inference: the weights are fixed at
publish time, so every scale can be computed by a full pass over the tensor with
no running data. It is the default choice for single-user or low-concurrency
serving.

**Activation quantization** quantizes the intermediate tensors produced at
runtime. Scales cannot be known in advance, because activations depend on the
input, so a scale must be computed on the fly, per tensor, per step. That
dequantize-then-compute cost lands directly on the critical path of the
memory-bound decode step — the one place you cannot afford extra work. This is
why many production stacks quantize weights only and leave activations in 16
bits.

**KV cache quantization** is the third target and the one that pays off at long
context: the cache is read-only for a request, so a scale computed once at write
time is valid for every subsequent read. It is treated in
[the KV cache lesson](/en/blog/kv-cache-memory-of-long-contexts).

## The families of algorithms, by what they change

All of these preserve the same basic structure — integers plus scales — and differ
in where the integers come from.

**Coarser scale granularity.** Per-tensor absmax (one scale) → per-output-channel
(one scale per row of $W$) → per-group along the input dimension (the group-wise
scheme every production format uses). Group size is the main dial: smaller groups
mean less error and more scale bytes. Common defaults are 128 for 4-bit weights
and 64 for KV caches. Per-channel schemes fix the _output_ axis because each row
of $W$ is a separate output feature whose dot product sees its own distribution.

**Round-to-nearest replaced by error compensation.** Round-to-nearest minimizes
error on each weight independently, which ignores that a whole row is summed.
GPTQ (Frantar et al., 2023) quantizes weights column by column using the
calibration activations, and after each column is rounded it adjusts the _not yet
quantized_ columns to partially compensate for the error just introduced. It is a
greedy layer-wise pass: still cheap, but the scales come from real data rather
than from the weight distribution alone. The result is a different kind of error —
the per-weight error is larger, but the error in the layer's output is smaller,
which is the quantity that matters.

**Activation-aware channel selection.** AWQ (Lin et al., 2023) observes that a
small number of weight channels carry weights large enough to dominate
activations, and protects those channels by scaling them and folding the inverse
scale into the preceding layer's weights. The integers stay uniformly quantized
per group; the magnitudes are redistributed so no group carries an outlier.

**Moving the difficulty into activations.** SmoothQuant (Xiao et al., 2023)
divides each input channel's activation outlier by a factor $s$ and multiplies
the corresponding weight column by $s$. Because activations are per-input-channel
while weights are per-output-column, the same scale can be applied on both sides
and the product is unchanged exactly — so this is a lossless reparameterization
that makes activations easier to quantize at no cost to the network's function.
The trade-off is a smoothing exponent you must choose, and too much smoothing
starves the weights of dynamic range.

**Mixed precision by layer.** Some matrices are kept in higher precision —
typically the first and last layers, which are known to be more sensitive. The
effective bits per weight become a weighted average, not the headline number.

## Calibration: choosing scales from data, not from assumptions

Every scheme above has a free parameter, and the choice of parameter is where
quantization research actually lives. Absmax needs no data at all — it is
computed from the weights themselves — but it assumes the extreme value is
representative, which outliers refute. The alternative is to measure the
distribution on a **calibration set**: a few hundred sequences sampled from the
target distribution, run through the model to collect activation statistics, from
which better scales or better rounding decisions are derived.

Calibration is a data-dependent choice, which brings its own problems. The set has
to resemble the traffic the model will actually see; a calibration set drawn from
the wrong domain produces scales tuned for the wrong activations. It has to be
large enough to be stable and small enough to be cheap — a few hundred sequences
of a few thousand tokens is typical. And it is a hyperparameter of the deployment,
not of the model, so a model quantized for one workload does not transfer
unchanged to another. "Int4" without a statement of the calibration set is an
incomplete specification.

## Smaller weights are not proportionally faster

This is the point most deployments get wrong, so it is worth being concrete about
where the promised speedup goes.

For a 7B-class model, weight bytes per decode step and the resulting ceiling on a
2,039 GB/s device:

| Format          | Bits per weight | Weight bytes | Decode step | Ceiling   |
| --------------- | --------------- | ------------ | ----------- | --------- |
| bf16            | 16.000          | 14.00 GB     | 6.87 ms     | 146 tok/s |
| int8            | 8.000           | 7.00 GB      | 3.43 ms     | 291 tok/s |
| int4, group 128 | 4.125           | 3.61 GB      | 1.77 ms     | 565 tok/s |

The byte count falls by 3.9× from bf16 to int4. The _ideal_ step time falls by
the same factor — 3.9×, from 6.87 ms to 1.77 ms — and it does, because the step is
memory-bound and bandwidth is the only term. That is the honest version of the
claim, and it is a real gain.

The claim that fails is 4× from bf16 to 4-bit _including all overheads_. Three
terms eat it:

- **Kernel support.** A 4-bit weight has no hardware representation. Tensor cores
  consume 8-bit and 16-bit operands; a 4-bit matmul either unpacks to int8 (which
  throws away half the saving on the compute side) or runs on a slower custom
  kernel. The speedup is bounded by whichever of bandwidth and kernel throughput is
  worse, and at low bit widths it is increasingly the kernel.
- **Dequantization overhead.** For low-bit weights with activations in 16 bits,
  each weight must be unpacked and rescaled before the tensor-core multiply, or
  a fused dequant-matmul kernel does both. That work is real arithmetic on the
  critical path. It is hidden when the batch is large (the arithmetic overlaps
  with memory traffic) and exposed when the batch is 1.
- **The other bottleneck.** Quantizing weights does nothing for a
  compute-bound phase. A long prefill still costs $2NS$ FLOPs; if your workload is
  dominated by prefill, quantizing weights buys you capacity, not speed.

So the prediction procedure is: compute both terms from the roofline, find the
larger, and check that the kernel actually exists at your target batch size. At
batch 1 on a bandwidth-bound step, int8 weights should approach their 2× byte
reduction. At 4 bits, expect less, and measure. Measure especially because the
result depends on the GPU generation, the framework, and the batch size the
workload actually runs at.

The corollary matters for capacity planning. Where quantization reliably wins is
_fitting_: a 70B-class model at bf16 needs 130.4 GiB of weights, at int8 65.2 GiB,
at int4 group 128 33.6 GiB. The last of those is what makes a single card
possible, and that is a capability gain rather than a throughput gain.

## What quantization cannot buy

An int8 weight matrix can still produce confidently wrong output. Quantization
error is not noise around a correct answer; at 4 bits it is a systematic
distortion of the function the network computes, and the symptom is degraded
reasoning or degraded instruction-following on hard prompts while fluency stays
perfect. Two honest caveats: the tolerance for weight error is task- and
model-specific, and the "int4 loses almost nothing" claims in vendor material are
measured on specific benchmarks with specific calibration data under specific
tolerances — which is why the reproducible-experiment discipline in
[this series](/en/blog/reproducible-llm-experiments) is the only way to know
whether a change helped.

Second, quantization interacts with everything else in the stack, and the
interactions are not free. Multi-GPU tensor parallelism needs the quantized format
to shard cleanly along the sharded axis. Attention kernels are often the first
place to lose support at low bits, which is why many stacks leave them in higher
precision. And quantization order matters: a model quantized _before_ adaptation
may be quantized again afterwards, and the second pass sees weights that no
longer match the distribution the first calibration measured.

That is the end of what quantization buys. It is a memory and throughput lever
with a measurable quality cost, and every claim about it — including the ones
here — is a claim about a specific model, a specific calibration set and a
specific hardware target.

## References

- Elias Frantar, Saleh Ashkboos, Torsten Hoefler and Dan Alistarh, "GPTQ:
  Accurate Post-Training Quantization for Generative Pre-trained Transformers",
  ICLR 2023, arXiv:2210.17323 — the error-compensating column-wise rounding pass
  described above.
- Ji Lin, Jiaming Tang, Haotian Tang, Shang Yan, Chong Wang, Chao Deng, Yunzhen
  Li, Zhuang Liu, Lijuan Wang and Song Han, "AWQ: Activation-aware Weight
  Quantization for LLM Compression and Acceleration", MLSys 2024,
  arXiv:2306.00978 — protecting the small number of weight channels that carry
  the activation outliers, by folding a scale into the preceding layer.
- Guangxuan Xiao, Ji Lin, Mickael Seznec, Lingxiao Zhao, Isidore Sebag, Neil
  Westlake, Antoine Scemama and Bilel Zohra Drafa, "SmoothQuant: Accurate and
  Efficient Post-Training Quantization for Large Language Models", ICML 2023,
  arXiv:2211.10438 — migrating activation outliers into the weights, which is
  what makes 8-bit activation quantization tractable.
