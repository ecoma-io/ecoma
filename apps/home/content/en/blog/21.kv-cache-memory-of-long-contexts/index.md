---
title: 'The KV cache: why long contexts consume so much memory'
description: 'Derive the memory a KV cache occupies, and see which of layers, heads, sequence length or precision dominates the bill.'
date: '2026-10-04'
author: 'John Martin'
tags:
  - inference
  - ai
featured: false
cover: ../../../assets/cover-21-kv-cache-memory-of-long-contexts.svg
coverAlt: 'Abstract memory bars motif on a light background beside the lesson title'
articleId: kv-cache-memory-of-long-contexts
seriesId: inference
seriesOrder: 2
contentType: theory
level: intermediate
prerequisites:
  - llm-inference-prefill-and-decode
  - attention-from-first-principles
relatedArticleIds:
  - quantization-precision-and-efficiency
  - distributed-training-parallelism
---

# The KV cache: why long contexts consume so much memory

Ask an engineer why a 128k-token request will not fit and the answer is usually
"memory", which is true and useless. The useful answer names the four factors the
footprint is a product of — layers, KV heads, sequence length, precision — and
knows which one the deployment controls. After this lesson you should be able to
derive the KV cache size from a model's architecture, compute it for a real 7B-class
configuration, and decide whether to shorten the context, change the attention
variant, or change the cache dtype.

The mechanism is the one introduced in
[the inference lesson](/en/blog/llm-inference-prefill-and-decode): during prefill
each attention layer projects its input into keys and values, and those projections
are saved so decode does not have to recompute them. This lesson is about the size
of what gets saved, and the first thing to understand is that the cache grows with
the _context_, not with the model.

## The formula, term by term

Attention computes three projections from the layer input $X$, a
$S \times d_{model}$ matrix of one row per position:

$$
Q = X W_Q, \qquad K = X W_K, \qquad V = X W_V
$$

with $W_Q, W_K, W_V$ each of size $d_{model} \times d_{model}$. Each projection
produces $S \times d_{model}$ values. The queries are needed only inside the
current forward pass — they are consumed immediately and thrown away. The keys and
values are needed at every future step, so they are retained, one pair per layer,
for the life of the request.

That gives the whole footprint. Write $L$ for the number of layers, $H_{kv}$ for the
number of key/value heads, $d_{head}$ for the dimension of one head, $S$ for the
current sequence length, $B$ for the number of sequences in the batch, and $c$ for
the bytes per cached element:

$$
\text{bytes} = \underbrace{2}_{\text{keys and values}} \cdot \underbrace{L}_{\text{layers}} \cdot \underbrace{H_{kv}}_{\text{KV heads}} \cdot \underbrace{d_{head}}_{\text{per head}} \cdot \underbrace{S}_{\text{positions}} \cdot \underbrace{B}_{\text{sequences}} \cdot \underbrace{c}_{\text{precision}}
$$

Every factor is architectural or runtime; none of them is optional. The 2 is the
first thing people forget, and it is not a rounding error — keys and values are
equally large.

One clarification before the arithmetic. In multi-head attention, each of the $h$
query heads has its own key and value head, so $H_{kv} = h$. **Grouped-query
attention (GQA)** breaks that pairing: several query heads share one key/value
head, and the number of shared groups $g$ is the ratio $h / H_{kv}$. The
projection matrices become $W_K$ of size $H_{kv} d_{head} \times d_{model}$ and
likewise for $V$, which is the mechanism — fewer columns to project, so fewer
vectors to cache. $H_{kv}$ is the quantity in the formula, not $h$.

## A worked 7B-class configuration

Take a decoder-only transformer with these published-style dimensions, and
compute from the formula rather than from a number someone quoted:

- $L = 32$ layers
- $h = 32$ query heads, $d_{model} = 4096$, so $d_{head} = 4096 / 32 = 128$
- GQA with $g = 4$, so $H_{kv} = 32 / 4 = 8$
- $S = 4096$ tokens, $B = 1$, bf16 cache so $c = 2$ bytes

Substituting:

$$
2 \cdot 32 \cdot 8 \cdot 128 \cdot 4096 \cdot 1 \cdot 2 = 536{,}870{,}912 \text{ bytes}
$$

which is 512 MiB exactly. One sequence of 4096 tokens on one GPU, on a model
whose _weights_ take 13.04 GiB at bf16. The same 32-head multi-head attention
would need 2 GiB — exactly four times more, one factor of $g$.

The per-layer share is $536{,}870{,}912 / 32 = 16$ MiB, which is the useful
unit for reasoning about where memory goes: every layer pays the same price, so
there is no layer-shaped shortcut. And the sequence length enters linearly and
without offset, which is where the pain lives.

```python
"""KV cache footprint, derived rather than guessed."""

LAYERS = 32
HEADS = 32  # query heads
KV_HEADS = 8  # GQA: 8 key/value heads shared by 4 query heads each
D_MODEL = 4096
HEAD_DIM = D_MODEL // HEADS  # 128


def kv_bytes(sequence_length, batch=1, bytes_per_element=2, kv_heads=KV_HEADS):
    # 2 for the key and the value tensor
    # L layers
    # H_kv key/value heads (NOT the query head count)
    # d_head per head
    # S positions
    # B sequences in the batch
    # bytes per element
    return (
        2
        * LAYERS
        * kv_heads
        * HEAD_DIM
        * sequence_length
        * batch
        * bytes_per_element
    )


WEIGHT_BYTES = 7_000_000_000 * 2  # 7B parameters at bf16


def main():
    print(f"head dim {HEAD_DIM}, layers {LAYERS}, KV heads {KV_HEADS}\n")

    print("one sequence of 4096 tokens, bf16 KV cache")
    variants = (
        ("multi-head attention (32 KV heads)", HEADS),
        ("GQA (8 KV heads)", KV_HEADS),
    )
    for label, kv_heads in variants:
        total = kv_bytes(4096, kv_heads=kv_heads)
        print(f"  {label:36s} {total / 2**20:8.1f} MiB")

    print("\nsame sequence at other precisions, GQA")
    for bits, bytes_per_element in ((16, 2), (8, 1)):
        total = kv_bytes(4096, bytes_per_element=bytes_per_element)
        print(f"  {bits:2d}-bit KV: {total / 2**20:8.1f} MiB")

    print("\nGQA, bf16, sequence length sweep against the weights")
    for sequence_length in (2048, 4096, 8192, 32768, 131072):
        cache = kv_bytes(sequence_length)
        print(
            f"  S = {sequence_length:6d}: {cache / 2**30:6.2f} GiB cache, "
            f"{cache / WEIGHT_BYTES:5.2f}x the {WEIGHT_BYTES / 2**30:.2f} GiB of weights"
        )

    print("\nconcurrency on one 80 GB card, GQA + bf16, weights resident")
    free = 80 * 2**30 - WEIGHT_BYTES
    for sequence_length in (4096, 8192, 16384, 32768):
        per_sequence = kv_bytes(sequence_length)
        print(f"  S = {sequence_length:6d}: {free / per_sequence:6.0f} concurrent sequences")


if __name__ == "__main__":
    main()
```

## Why the growth in $S$ is the problem

Every factor in the formula is fixed when a model is trained except $S$ and $B$,
and both are things the _user_ controls. This is the asymmetry that makes long
context expensive: shrinking the model by 2× halves the weight footprint, but a
user asking for 128k tokens instead of 4k adds 124k tokens of cache to a request
that was already small. Nothing about the model was inefficient; the bill grew
because the workload did.

The sweep above makes the ratio explicit. The 13.04 GiB of weights are a constant
across every row:

| Sequence length | KV cache, GQA bf16 | Ratio to weights |
| --------------- | ------------------ | ---------------- |
| 2048            | 0.25 GiB           | 0.02×            |
| 4096            | 0.50 GiB           | 0.04×            |
| 8192            | 1.00 GiB           | 0.08×            |
| 32768           | 4.00 GiB           | 0.31×            |
| 131072          | 16.00 GiB          | 1.23×            |

The last row is the one that matters. At 128k the cache is _larger than the
model_, and because $B$ multiplies the same expression, the concurrency the card
can serve collapses at exactly the same rate. On an 80 GB card holding this model
at bf16 with the weights resident, the arithmetic gives:

| Sequence length | Concurrent sequences, GQA bf16 |
| --------------- | ------------------------------ |
| 4096            | 134                            |
| 8192            | 67                             |
| 16384           | 33                             |
| 32768           | 17                             |

Halving the context doubles the tenants. That is why long-context serving is
mostly a memory-capacity problem wearing a memory-bandwidth costume, and why a
capability of 128k rarely means "many users at 128k" on one card.

The other reason $S$ hurts is bandwidth, not capacity. During decode, every step
reads the whole cache. At $S = 32768$ with 8 KV heads, that is 4.29 GB of traffic
per step against 14 GB of weights — a 31% increase in the memory-bound step time
from
[the previous lesson](/en/blog/llm-inference-prefill-and-decode). At
$S = 131072$ the cache read is 17.2 GB and the weights are no longer the main
thing being streamed.

## Precision multiplies the whole table

The $c$ factor is the cheapest knob in the formula, because halving it halves
everything. With GQA at $S = 4096$:

| Cache dtype | Bytes per element | KV cache | Relative |
| ----------- | ----------------- | -------- | -------- |
| fp16 / bf16 | 2                 | 512 MiB  | 1.00×    |
| int8        | 1                 | 256 MiB  | 0.50×    |
| int4        | 0.5               | 128 MiB  | 0.25×    |

Int8 KV caches are the common production choice and the reason long-context
serving is viable at all; fp8 is the intermediate step on newer stacks. The cost
is real but bounded and measurable: the KV cache is a _read-only_ structure for
the duration of a request, so the error introduced at write time does not
compound across steps the way a training error would. Quantizing the cache is also
considerably less dangerous than quantizing weights, because
[the quantization lesson](/en/blog/quantization-precision-and-efficiency) is
mostly about error that accumulates through every matrix multiply in the model,
and the cache enters only the attention matmuls.

Two operational notes. Not every implementation supports an int8 cache
uniformly — vLLM and TensorRT-LLM both expose the choice, and the flag names
differ, so verify rather than assume. And group-wise scales, if used, cost extra
bytes per group; at group size 64 with fp16 scales that adds 0.25 bits per
element, so a nominal "4-bit" cache is really 4.25 bits. The rounding is small
but the arithmetic should include it.

## What the formula does not tell you

The formula is exact for the tensors themselves and silent about everything
around them. It does not count the transient workspace a fused attention kernel
needs, the fragmentation between variable-length sequences, or the activations
held during prefill — and that last one matters: prefill of a 128k prompt needs
large intermediate activations that can exceed the cache it is about to fill.
Sliding-window and recurrent-hybrid architectures avoid the linear growth by
design, at the cost of not attending to the whole context. Distributed
tensor parallelism
([covered here](/en/blog/distributed-training-parallelism)) shards the cache
across devices by head, which reduces per-device capacity without changing the
total, and therefore does not solve the problem — it relocates it.

And a caveat about the worked example: the dimensions are plausible for a 7B-class
model, and the arithmetic on them is exact, but they are not the published
configuration of any particular checkpoint. Anyone quoting a specific number for a
specific model should read that model's own `config.json` and substitute the real
`num_hidden_layers`, `num_key_value_heads`, `hidden_size`, and `num_attention_heads`.
The formula does not change. The inputs do.

## References

- Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, Ying Sheng, Lianmin Zheng, Cody Hao
  Yu, Joseph E. Gonzalez, Hao Zhang and Ion Stoica, "Efficient Memory Management
  for Large Language Model Serving with PagedAttention", SOSP 2023,
  arXiv:2309.06180 — why the cache is stored as blocks rather than one
  contiguous tensor, and the measured effect of not fragmenting it.
- Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones,
  Aidan N. Gomez, Lukasz Kaiser and Illia Polosukhin, "Attention Is All You
  Need", NeurIPS 2017, arXiv:1706.03762 — the multi-head layout this lesson's
  `num_key_value_heads` argument is derived from, in particular grouped-query
  attention sharing keys and values across query heads.
- NVIDIA, "A100 Tensor Core GPU Architecture" whitepaper — the device
  bandwidth used to convert cache bytes into decode latency.
