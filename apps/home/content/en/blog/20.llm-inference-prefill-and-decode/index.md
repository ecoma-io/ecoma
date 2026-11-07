---
title: 'LLM inference: prefill, decode, and autoregressive generation'
description: 'The two phases of generation, why they have opposite bottlenecks, and how batching trades latency against throughput.'
date: '2026-10-03'
author: 'John Martin'
tags:
  - inference
  - ai
featured: false
cover: ../../../assets/cover-20-llm-inference-prefill-and-decode.svg
coverAlt: 'Abstract prefill timeline motif on a light background beside the lesson title'
articleId: llm-inference-prefill-and-decode
seriesId: inference
seriesOrder: 1
contentType: theory
level: intermediate
prerequisites:
  - multi-head-attention-and-transformer-blocks
  - language-modeling-next-token-prediction
relatedArticleIds:
  - kv-cache-memory-of-long-contexts
  - quantization-precision-and-efficiency
---

# LLM inference: prefill, decode, and autoregressive generation

Generating text with a transformer is not one operation but two, and the split
matters more than any other fact about inference. A production system that
treats generation as a single loop cannot be tuned, because the two halves want
opposite things from the hardware: one wants more arithmetic per byte moved, the
other wants fewer bytes moved per token produced. After this lesson you should be
able to look at a serving log, decide which phase a slowdown came from, compute a
roofline bound for each, and explain why adding concurrency helps one phase and
does nothing for the other.

The starting point is the autoregressive factorization from
[language modeling: probability, likelihood, and next-token prediction](/en/blog/language-modeling-next-token-prediction).
A model with parameters $\theta$ defines a distribution over the next token,
$p(y_{t+1} \mid y_1, \dots, y_t)$, and the joint distribution over a sequence of
length $n$ factorizes as

$$
p(y_1, \dots, y_n) = \prod_{t=1}^{n} p(y_t \mid y_{<t})
$$

Every one of those conditional distributions costs a forward pass. Nothing in the
architecture lets step $t+1$ reuse the compute of step $t$, because $y_{t+1}$ did
not exist when step $t$ ran. What _can_ be reused is the intermediate state: the
key and value tensors computed for positions $1 \dots t$ are identical at step
$t+1$, since they depend only on the tokens at or before their own position.

## Prefill: the prompt, processed in parallel

Given a prompt of $S$ tokens, prefill runs one forward pass with all $S$ positions
in the batch. Inside each attention head the operation is a matrix multiply,
$QK^\top$, of size $S \times d_k$ against $d_k \times S$, producing an
$S \times S$ score matrix. Every row of that matrix is independent, so every row —
every position — is evaluated at once. Prefill is the only part of generation that
looks like ordinary batched training.

The cost is dominated by the linear layers. A matrix multiply of a
$d_{model} \times d_{model}$ weight against $S$ vectors performs
$2 \cdot d_{model}^2 \cdot S$ floating-point operations, and summing over all the
linear layers in the model gives roughly $2N$ FLOPs per token, where $N$ is the
parameter count. Prefill therefore costs

$$
\text{FLOPs} \approx 2 N S
$$

The attention part is separate and smaller at these lengths: the two matmuls
$QK^\top$ and $(\text{scores})V$ cost about $4 S^2 d_{model}$ per layer, so the
ratio of attention work to linear work grows with $S$ and eventually dominates —
but it is still negligible at the context lengths most systems serve.

Prefill also produces something decode cannot recompute cheaply: the KV cache.
At each layer, the projections $K = X W_K$ and $V = X W_V$ turn the $S$ prompt
positions into $S$ key vectors and $S$ value vectors, which are saved. Those
saved tensors are what makes the second phase possible at all.
[The KV cache lesson](/en/blog/kv-cache-memory-of-long-contexts) derives exactly
how many bytes that costs.

## Decode: one token, whole model

Decode is the same forward pass with $S = 1$ at the new position, reading the
prompt's $S$ cached keys and values for attention instead of recomputing them. The
difference in cost is not subtle:

|                            | Prefill ($S$ tokens) | Decode (1 token) |
| -------------------------- | -------------------- | ---------------- |
| Parallelism over positions | all $S$ at once      | one              |
| FLOPs                      | $\approx 2NS$        | $\approx 2N$     |
| Weight bytes read          | $N \cdot b$ once     | $N \cdot b$ once |
| Arithmetic intensity       | $S$ FLOP/byte        | $1$ FLOP/byte    |
| Bound                      | compute              | memory bandwidth |

Here $b$ is bytes per weight element (2 for bf16). The weight bytes are the same
in both phases, because a forward pass reads every weight exactly once regardless
of how many positions it serves. In prefill those bytes are amortized over $S$
positions and the hardware is kept busy; in decode they are amortized over one,
and the arithmetic units spend most of the step idle.

That is the whole asymmetry, and it is exactly what the **roofline model**
predicts. Arithmetic intensity is FLOPs divided by bytes moved; a device with peak
throughput $F$ and bandwidth $B$ switches from memory-bound to compute-bound at
a _machine balance_ of $F / B$ FLOP per byte. Using NVIDIA's published figures for
the A100 80GB SXM — 312 TFLOPS dense bf16 Tensor Core, 2,039 GB/s of HBM
bandwidth — the machine balance is

$$
F / B = 312 \times 10^{12} / 2.039 \times 10^{12} \approx 153 \text{ FLOP/byte}
$$

Prefill at $S = 4096$ has an intensity of 4096 FLOP/byte, 27 times the machine
balance, so it runs compute-bound with room to spare. Decode at batch size 1 has
an intensity of 1 FLOP/byte, 153 times _below_ balance, so it runs memory-bound:
the tensor cores finish their 44.9 microseconds of work while the memory system
spends 6.9 milliseconds delivering the weights.

## Reading a serving log against the roofline

Here is the arithmetic for a 7B-class model on that same A100, using only $2N$
FLOPs per token and $N \cdot b$ bytes of weights per step. Attention over the KV
cache is excluded, which is a real omission at long context and
[The KV cache lesson](/en/blog/kv-cache-memory-of-long-contexts) quantifies it.

```python
"""Roofline accounting for the two inference phases. No model, just the arithmetic."""

PARAMETERS = 7_000_000_000
# NVIDIA's published figures for the A100 80GB SXM: 2,039 GB/s of HBM bandwidth,
# 312 TFLOPS dense BF16 Tensor Core.
BANDWIDTH = 2.039e12  # bytes per second
FLOPS = 312e12  # floating-point operations per second

# One dense weight contributes one multiply and one add per token it touches, so
# a forward pass costs about 2 FLOPs per parameter per token.
FLOPS_PER_TOKEN = 2 * PARAMETERS


def prefill_seconds(tokens):
    """The prompt is processed as one wide matrix multiply: compute-bound."""
    return FLOPS_PER_TOKEN * tokens / FLOPS


def decode_step_seconds(batch):
    """Each decode step streams every weight once; the batch rides along free."""
    weight_bytes = PARAMETERS * 2  # bf16
    by_memory = weight_bytes / BANDWIDTH
    by_compute = FLOPS_PER_TOKEN * batch / FLOPS
    return max(by_memory, by_compute), by_memory, by_compute


def main():
    balance = FLOPS / BANDWIDTH
    print(f"machine balance: {balance:.0f} FLOP per byte")
    density = FLOPS_PER_TOKEN / (2 * PARAMETERS)
    print(f"decode arithmetic intensity at batch 1: {density:.1f} FLOP/byte")
    print()

    print("prompt of 1000 tokens, then 100 generated tokens, batch 1")
    ttft = prefill_seconds(1000)
    step, _, _ = decode_step_seconds(1)
    total = ttft + 100 * step
    print(f"  time to first token: {ttft * 1e3:.1f} ms")
    print(f"  inter-token latency:  {step * 1e3:.1f} ms")
    print(f"  total:               {total * 1e3:.1f} ms")
    print(f"  prefill share:       {ttft / total:.1%}")
    print()

    print("decode step at growing batch size")
    for batch in (1, 8, 32, 64, 128, 256):
        step, by_mem, by_compute = decode_step_seconds(batch)
        bound = "compute" if by_compute > by_mem else "memory"
        print(
            f"  batch {batch:3d}: {step * 1e3:6.2f} ms, "
            f"aggregate {batch / step:8.0f} tokens/s, bound: {bound}"
        )


if __name__ == "__main__":
    main()
```

The printed output:

```
machine balance: 153 FLOP per byte
decode arithmetic intensity at batch 1: 1.0 FLOP/byte

prompt of 1000 tokens, then 100 generated tokens, batch 1
  time to first token: 44.9 ms
  inter-token latency:  6.9 ms
  total:               731.5 ms
  prefill share:       6.1%

decode step at growing batch size
  batch   1:   6.87 ms, aggregate      146 tokens/s, bound: memory
  batch   8:   6.87 ms, aggregate     1165 tokens/s, bound: memory
  batch  32:   6.87 ms, aggregate     4661 tokens/s, bound: memory
  batch  64:   6.87 ms, aggregate     9321 tokens/s, bound: memory
  batch 128:   6.87 ms, aggregate    18642 tokens/s, bound: memory
  batch 256:  11.49 ms, aggregate    22286 tokens/s, bound: compute
```

Read the last block carefully, because it is the single most useful operational
fact in this lesson. Going from batch 1 to batch 128 costs nothing in step time
and multiplies aggregate throughput by 128. The step only starts costing more at
batch 256, where the compute term catches the memory term — and 256 is close to
the machine balance of 153, as expected. Real servers do not reach this ideal:
kernel inefficiencies, KV cache traffic and communication all eat into the
ceiling. The bound is a target, not a prediction.

## Two latencies, not one

Users feel two different numbers, and they are governed by different phases:

- **Time to first token (TTFT)** is prefill, plus queueing. It is what an
  interactive user waits through while nothing appears on screen.
- **Inter-token latency (ITL)** is one decode step, plus queueing. Multiplied by
  the number of generated tokens, it gives the time from first token to last.

In the example above, a 1000-token prompt and a 100-token answer spend 6.1% of
the wall clock in prefill and 93.9% in decode, because the answer is 100 steps
against a prompt that costs 1000 tokens of arithmetic at 153 times the
efficiency. Swap in a 20,000-token prompt and the same 100-token answer: prefill
becomes 897 ms of a 1,584 ms budget, or 57%. The phase mix is set by the ratio of
prompt length to generated length, which is why a single "latency" metric is
inadequate for describing an inference service.

Throughput, the third number, counts tokens produced per second across all
requests. It is not latency — it is what a batch-processing workload cares about
and what an interactive workload pays for in waiting. A server tuned for
throughput deliberately accepts worse ITL, and there is no setting that maximizes
both.

## Why batching works, and what static batching wastes

The reason batch 128 is as fast per sequence as batch 1 is structural: a decode
step streams the 14 GB of weights once and produces one token for each of the 128
sequences in flight. Each sequence's token rides along inside the same matmul.
This is only possible while the steps are _synchronized_ — every sequence must
advance at the same rate, or the matrix shapes diverge.

That constraint is where naive serving wastes capacity. Static batching fills a
batch of size $B$, pads every sequence to the longest one, and runs all $B$
sequences until every one finishes. Two problems follow:

- **Padding.** A batch holding one 4096-token prompt and one 512-token prompt
  executes 8192 token-steps to do 4608 units of useful work — 43.8% of the
  arithmetic is on padding. Four concurrent 512-token prompts padded to a common
  4096 waste 87.5%.
- **Head-of-line blocking.** A short completion occupies its lane until the long
  one finishes. In a batch of eight, once half the sequences have finished, four
  lanes are idle while the remaining four still wait on the same memory-bound
  step.

Two mechanisms fix these, and both are in
[vLLM](https://github.com/vllm-project/vllm), described in Kwon et al. 2023
(PagedAttention, [arXiv:2309.06180](https://arxiv.org/abs/2309.06180)):

- **Continuous batching** runs the decode loop step by step and, after each
  step, admits new requests into any freed slots. A sequence that finishes at step
  3 releases its slot immediately. Lanes stay full, and no padding is needed
  because the shapes are driven by the batch, not by the longest member.
- **PagedAttention** removes the fragmentation that a growing cache would
  otherwise cause. The analogy is virtual memory: reserve each sequence's KV cache
  in fixed-size blocks and index them through a block table, the way an OS maps a
  process's pages into non-contiguous physical frames. Sequences of any length
  then cost exactly what they use. Without it, a cache reserved for the maximum
  length is mostly wasted, and reserved contiguously it can fragment badly enough
  to strand a large share of device memory.

These are memory-management and scheduling changes, not model changes. They make
the roofline bound above reachable more often.

## How the three levers move the bottleneck

**Model size.** Decode step time is linear in $N$ and independent of batch size
until the compute term catches up, so halving the parameter count halves ITL at
batch 1. A 70B-class model at bf16 needs 130.4 GiB of weights; its decode step
takes 68.7 ms, a ceiling of 14.6 tokens per second on one A100 regardless of
batch. That is why multi-GPU tensor parallelism
([distributed training](/en/blog/distributed-training-parallelism) covers the same
mechanics at training time) and quantization
([the next lesson](/en/blog/quantization-precision-and-efficiency)) are the two
levers for fitting a model at all.

**Context length.** Prefill cost is linear in $S$ — doubling the prompt doubles
the FLOPs — and the KV cache grows linearly too, so a longer prompt raises TTFT
through two independent channels. Decode gains a second, smaller cost: every
step must read the whole cache. At $S = 32768$ with 8 KV heads, that cache is
4.29 GB against 14 GB of weights, so memory traffic per decode step rises by 31%.
At $S = 131072$ the cache is 17.2 GB and the extra traffic more than doubles the
step. Long context is exactly the regime where decode stops being pure weight
streaming and starts being cache streaming.

**Batch size.** The lever that costs nothing. Batch size raises aggregate
throughput almost linearly until the machine balance, and raises individual ITL
by almost nothing until it does. It is the right knob for throughput and the
wrong knob for a latency-sensitive endpoint, where the right answer is usually
fewer concurrent requests on more replicas.

## What this model leaves out

The roofline bound treats the model as uniform weights and ignores everything
else, and that gap is where production disappoints. Attention over the KV cache
is excluded from the FLOP count entirely; at long context it is the term that
first stops being negligible. Kernel launch overhead and per-layer synchronization
dominate small-batch decode on some frameworks, so measured ITL at batch 1 can be
several times the memory-bound bound. Prefix caching changes the prefill cost
substantially for repeated system prompts, which is why a serving stack should
hash and reuse prefixes rather than recomputing them. And hardware changes the
balance: a device trading FLOPs for bandwidth moves the crossover batch size, and
so does a mixture-of-experts model, whose decode step reads only the experts one
token happens to activate.

The 153 FLOP/byte crossover is a property of an A100, not of transformers. The
qualitative split — prefill compute-bound, decode bandwidth-bound — has held
across every accelerator generation since, and the shape of the argument, not the
constant, is what transfers.

## References

- Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, Ying Sheng, Lianmin Zheng, Cody Hao
  Yu, Joseph E. Gonzalez, Hao Zhang and Ion Stoica, "Efficient Memory Management
  for Large Language Model Serving with PagedAttention", SOSP 2023,
  arXiv:2309.06180 — the KV cache paging scheme this lesson's serving numbers
  assume, and the source of the fragmentation the prefill/decode split depends
  on.
- NVIDIA, "A100 Tensor Core GPU Architecture" whitepaper — the 2,039 GB/s HBM
  bandwidth and 312 TFLOPS bf16 figures the roofline crossover is computed from.
  These are hardware specifications, not measured results on any particular
  model.
- The [vLLM project](https://github.com/vllm-project/vllm) — the implementation
  whose continuous batching and PagedAttention behaviour the schedule argument
  above describes.
