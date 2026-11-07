---
title: 'RAG fundamentals: retrieval, context construction, and generation'
description: 'The retrieval-augmented generation pipeline, document preparation, chunking trade-offs, context construction and grounding limits.'
date: '2026-10-09'
author: 'John Martin'
tags:
  - evaluation
  - ai
featured: false
cover: ../../../assets/cover-26-rag-fundamentals.svg
coverAlt: 'Abstract retrieve context generate motif on a light background beside the lesson title'
articleId: rag-fundamentals
seriesId: evaluation-and-rag
seriesOrder: 2
contentType: research-review
level: intermediate
prerequisites:
  - embeddings-learned-geometry
  - llm-inference-prefill-and-decode
relatedArticleIds:
  - embedding-retrieval-similarity-and-ann
  - evaluating-rag-systems
---

# RAG fundamentals: retrieval, context construction, and generation

A model confidently invents a refund policy that your support wiki never mentions.
The tempting fix is to prepend the wiki to the prompt and hope. That works
sometimes, and it fails for reasons that live in the middle of the pipeline
rather than in the model. This lesson walks the four stages of
retrieval-augmented generation — index, retrieve, construct context, generate —
and shows where quality is actually decided. You will end up able to say whether
a wrong answer came from a bad chunk, a bad ranking, or a bad prompt, and to size
a context budget arithmetically instead of by guessing.

Lewis et al. (2020), "Retrieval-Augmented Generation for Knowledge-Intensive NLP
Tasks" ([arXiv:2005.11401](https://arxiv.org/abs/2005.11401)), introduced the
retrieve-then-read formulation this lesson describes. The architecture is now
standard infrastructure rather than a research contribution, and the interesting
questions have moved to the seams between its stages.

## The four stages and where they can fail

- **Index.** Parse, clean, chunk, embed, and store each unit of retrieval.
  Failures here are invisible for weeks: a PDF table that parsed into three
  lines of noise sits in the index looking perfectly healthy.
- **Retrieve.** Turn the question into a query, search the index, take the top
  $k$ chunks. Failure means the answer was never in the prompt, so no amount of
  model quality can recover it.
- **Construct context.** Fit selected chunks into a prompt: order them, label
  them, decide how many fit. This is where good retrieval gets thrown away.
- **Generate.** Prompt the model with the context and the question. Failure here
  is the one most people mean when they say "hallucination", but it is the
  rarest of the four.

The useful habit is to keep these four apart when debugging. A system that
answers wrongly is usually assumed to fail at stage four; it much more often
failed at stage two, and no prompt engineering will recover it.

## Document preparation is where the corpus is won

Before anything is embedded, the source has to become clean text. HTML has
navigation, cookie banners, and duplicated blocks. PDFs have headers, footers,
page numbers, and columns that read across when parsed linearly. A document that
survives parsing badly will be retrieved for the wrong reasons forever.

Metadata is the other half. Every chunk wants a document id, a title, a source
URL, a section heading, and any filterable attribute — date, product, tenant,
language. This serves two purposes. It lets you attribute an answer to a source,
and it lets you _filter_ before you search, which is far cheaper than retrieving
broadly and discarding afterwards. In a multi-tenant system the tenant filter is
also a security boundary, not just a relevance device.

## Chunking trades recall against precision against cost

Chunking is the least glamorous decision in the pipeline and one of the most
consequential. Two opposing errors are possible. Chunks that are too large carry
irrelevant text, which dilutes the embedding and pushes the chunk down the
ranking; chunks that are too small split a fact away from its subject, so no
individual chunk can answer the question.

The common strategies differ in where they place boundaries:

- **Fixed-size with overlap.** Cut every $w$ tokens, where $w$ is typically a few
  hundred, overlapping consecutive chunks by some amount so a sentence spanning a
  boundary is not lost. Predictable and cheap; it ignores structure entirely.
- **Sentence or paragraph aware.** Never cut inside a sentence. Preserves local
  coherence at the cost of variable chunk sizes.
- **Recursive splitting.** Try a large split, and where a piece is still too
  big, split it again by progressively finer separators. This is the default in
  several widely used libraries.
- **Semantic.** Embed consecutive sentences, and cut where consecutive-sentence
  similarity drops. Boundaries follow meaning, at the cost of an extra pass over
  the corpus.

Overlap has a specific interaction with recall: a chunk that starts mid-sentence
embeds differently from the same chunk padded at the front. Overlap makes the
index tolerant of arbitrary query alignment, and it costs storage roughly
proportionally to the overlap fraction.

Sizing is arithmetic once you fix the budget. Take a prompt budget of 4000
tokens, reserve 300 for system instructions and room for the answer, and assume 40
tokens of overhead per chunk for its title and separators. That leaves 3700
usable tokens.

Let $B$ be the prompt budget in tokens, $R$ the tokens reserved for
instructions and the answer, $c$ the chunk size, and $o$ the per-chunk overhead.
The number of whole chunks that fit is a floor division:

$$
k = \left\lfloor \frac{B - R}{c + o} \right\rfloor
$$

For $B = 4000$, $R = 300$, and $o = 40$, usable space is $3700$ tokens:

| Chunk size | Overhead | Chunks that fit | Content tokens covered |
| ---------- | -------- | --------------- | ---------------------- |
| 128        | 40       | 22              | 2816                   |
| 256        | 40       | 12              | 3072                   |
| 512        | 40       | 6               | 3072                   |
| 1024       | 40       | 3               | 3072                   |

Two things fall out. Smaller chunks waste budget on repeated overhead — at 128
tokens you spend 880 tokens on titles and separators to cover 2816 content
tokens. Larger chunks cover the same content with fewer repetitions but force
each retrieval to carry more text, most of it irrelevant to a specific question.
The coverage column is nearly flat from 256 upward, which means the budget is not
the constraint in that range; chunk _granularity_ is. Note also the floor
division: 3700 divided by 552 leaves 388 tokens unused, and a budget-aware
implementation should either fill the tail with a partial chunk or accept the
waste deliberately.

The arithmetic is worth writing down rather than approximating:

```python
def chunks_that_fit(budget, reserved, chunk_tokens, overhead):
    """Whole chunks that fit after reserving room for instructions and output."""
    usable = budget - reserved
    per_chunk = chunk_tokens + overhead  # content plus its title and separators
    n = usable // per_chunk
    return n, n * chunk_tokens, usable - n * per_chunk


budget, reserved, overhead = 4000, 300, 40
print("usable:", budget - reserved)
for size in (128, 256, 512, 1024):
    n, content, wasted = chunks_that_fit(budget, reserved, size, overhead)
    print(f"{size:>5}: {n:>3} chunks, {content:>5} content tokens, {wasted} wasted")
```

Run it and the waste column grows with chunk size: 4 tokens at 128, 388 at 512,
508 at 1024. That remainder is the practical argument for letting the tail chunk
be partial instead of rounding down.
Choosing between them is an empirical question, answered by the retrieval metric
rather than by intuition. The lesson on
[embedding retrieval](/en/blog/embedding-retrieval-similarity-and-ann) covers
measuring recall@k, and [reranking and hybrid
search](/en/blog/reranking-and-hybrid-search) covers fixing the ranking once the
chunks are right.

## Context construction: how many chunks, in what order

Ordering is not cosmetic. Liu et al. (2023) studied how models use long inputs and
reported a pattern they call "lost in the middle": performance on relevant material
tends to be best when it appears at the beginning or end of the input, and worst
when it sits in the middle. The effect was measured on long-context models of the
2023 era, so treat the specific magnitude as unsettled rather than a constant.
The practical consequence survives regardless: put your best material at the
ends, and do not pad the middle with low-relevance chunks that push good
material inward.

A workable ordering puts the highest-scoring chunk first as a strong prior, then
fills with the remaining selected chunks, and optionally restates the question
after the context so the model is not left attending to a wall of text with no
recency cue.

There is a real trade-off in how many chunks to include. More context raises the
chance the answer is present, but it also raises cost, latency, and the
opportunity for distraction. The
[KV cache lesson](/en/blog/kv-cache-memory-of-long-contexts) derives why context
length is quadratically expensive to attend over. Beyond some point, additional
chunks make answers _worse_ because the model starts blending half-relevant
material — which is why "retrieve the top $k$" needs $k$ tuned like any other
hyperparameter, not set to the largest value that fits.

## Why grounding reduces hallucination without eliminating it

Retrieval grounds generation by giving the model text to copy from, and this
works because copying is far easier than recalling. But the guarantee is weaker
than it looks.

- **The context can be wrong or absent.** If retrieval returns nothing relevant,
  the model does not abstain; it falls back on parametric memory, which is where
  invention was always going to come from. An empty retrieval result is the most
  dangerous input you can feed a RAG system.
- **Partial evidence invites completion.** Given three retrieved facts about a
  four-part procedure, models reliably produce the fourth part. Nothing in the
  context contradicts the invention; it is simply absent.
- **Confident phrasing is not a citation.** Fluent text asserts its own
  reliability. Two systems can produce identical-sounding answers where one read
  the source and one did not.

So the honest statement is that RAG reduces hallucination by giving the model
something to be wrong _about_, and moves the failure mode from invention toward
misreading. What remains open is reliable abstention: knowing when the retrieved
evidence does not support an answer at all, and saying so. The
[evaluation lesson](/en/blog/evaluating-rag-systems) covers how to measure
whether a system does this rather than assuming it.

## Where the pipeline still fails

Retrieval quality is bounded by what was indexed: no chunking strategy recovers a
fact that the parser discarded or a source that was never collected. Metadata
filters that are too narrow silently shrink the corpus and can look like a
relevance regression. Long contexts degrade. And the whole pipeline adds latency
at three points — embedding the query, searching, then a longer prefill — which
is why the cheapest win is often at the retrieval stage, before the model is
involved at all. A useful reference for how varied these evaluation sets are is
the [BEIR benchmark collection](https://github.com/beir-cellar/beir).

## References

- Patrick Lewis, Ethan Perez, Aleksandra Piktus, Fabio Petroni, Vladimir
  Karpukhin, Naman Goyal, Heinrich Küttler, Mike Lewis, Wen-tau Yih, Tim
  Rocktäschel, Sebastian Riedel and Douwe Kiela, "Retrieval-Augmented
  Generation for Knowledge-Intensive NLP Tasks", NeurIPS 2020,
  arXiv:2005.11401 — the parametric-plus-non-parametric formulation this lesson's
  four stages are built on.
- Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Fabio Bevilacqua,
  Percy Liang and Douwe Kiela, "Lost in the Middle: How Language Models Use Long
  Contexts", TACL 2024 — why chunk order and placement change what a retrieved
  context actually contributes, which is the failure this lesson's ordering
  section is about. Cited by title and venue only: no arXiv identifier for this
  one has been confirmed against arxiv.org, and a guessed identifier would point
  at a real but unrelated paper.
