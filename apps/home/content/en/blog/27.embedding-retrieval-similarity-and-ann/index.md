---
title: 'Embedding retrieval: similarity search, ANN, and recall'
description: 'Vector similarity, exact versus approximate search, the recall-latency trade-off, and how retrieval quality is actually measured.'
date: '2026-10-10'
author: 'John Martin'
tags:
  - evaluation
  - ai
featured: false
cover: ../../../assets/cover-27-embedding-retrieval-similarity-and-ann.svg
coverAlt: 'Abstract ann rings motif on a light background beside the lesson title'
articleId: embedding-retrieval-similarity-and-ann
seriesId: evaluation-and-rag
seriesOrder: 3
contentType: research-review
level: intermediate
prerequisites:
  - embeddings-learned-geometry
relatedArticleIds:
  - reranking-and-hybrid-search
  - rag-fundamentals
---

# Embedding retrieval: similarity search, ANN, and recall

Your search returns ten passages and the right one is not among them. The
question is whether that is an embedding problem, an index problem, or a
ranking problem, and the answer determines what you should change. This lesson
gives you the measurements to tell them apart: the similarity functions that
define "nearby", why exact search costs $O(Nd)$ and approximate search trades
away answers for latency, and how to compute recall@k against a known relevant
set instead of guessing from anecdotes.

The lesson on [embeddings](/en/blog/embeddings-learned-geometry) covers where
the vectors come from. This one assumes you have them.

## Three similarity functions, and why the choice is mostly bookkeeping

Let $\mathbf{q}$ be a query embedding and $\mathbf{d}$ a document embedding, each
of dimension $d$.

- **Dot product** $\mathbf{q} \cdot \mathbf{d} = \sum_{j=1}^{d} q_j d_j$ weighs
  each coordinate by both magnitudes. Two long vectors that point the same way
  score high, which conflates "similar direction" with "large magnitude".
- **Euclidean distance** $\|\mathbf{q} - \mathbf{d}\|_2 = \sqrt{\sum_{j=1}^{d}
  (q_j - d_j)^2}$ measures straight-line separation. It is bounded below by zero
  and unbounded above, and it is sensitive to scale.
- **Cosine similarity** normalizes both vectors first:

$$
\cos(\mathbf{q}, \mathbf{d}) = \frac{\mathbf{q} \cdot \mathbf{d}}{\|\mathbf{q}\|_2 \|\mathbf{d}\|_2}
$$

Dividing by the norms removes magnitude, leaving the angle between the vectors,
and the result lands in $[-1, 1]$.

The relationship that makes this bookkeeping tractable: if all document vectors
are **unit-normalized**, then $\|\mathbf{q}\|_2 = 1$ and $\|\mathbf{d}\|_2 = 1$, so
cosine similarity collapses to the dot product. Most production vector indexes
store normalized vectors precisely so that the cheapest operation — a matrix
multiply — computes the intended similarity. Normalizing once at index time and
once per query turns any of the three into the same inner-product search, at the
cost of having committed to one metric before you measured anything. Changing
that choice later means re-embedding the entire corpus, so it is worth testing
cosine against dot product on your data early rather than inheriting a default.

## Exact search: brute force and its one virtue

The exact answer scores the query against every stored vector and sorts the
result. It costs $O(Nd)$ for $N$ vectors of dimension $d$, plus
$O(N \log N)$ for the sort, and it is parallelizable: the score matrix is one
large matrix multiply, which is exactly the operation BLAS is optimized for.

Exact search has one decisive property: it is the ground truth. Whatever it
returns _is_ the top-$k$, which is why every approximation is measured by its
agreement with it. When the corpus is small enough to fit in memory, exact
search is often the right choice, and popular libraries default to it for
precisely this reason.

## Approximate nearest neighbor, and what it actually gives up

Approximate nearest neighbor (ANN) indexes accept a small loss of recall in
exchange for sublinear query time. The families differ in what they approximate:

- **IVF (inverted file).** Cluster the vectors with k-means into `nlist` cells.
  At query time, find the `nprobe` cells nearest the query and score only the
  vectors inside them. Vectors in unprobed cells are never scored, which is
  precisely where recall is lost. `nprobe` is the recall/latency dial.
- **HNSW (Malkov & Yashunin, 2016).** Build a layered proximity graph. Each
  vector above layer 0 has a small set of long-range neighbors; the lowest layer
  holds every vector with many short-range ones. A search starts at the top layer
  and greedily hops toward the query, then descends. Recall is controlled by
  `ef` (search breadth) and `M` (graph degree, which sets build cost and memory).
  This is the dominant choice in production vector databases because it gives
  high recall at low latency without needing a training pass.
- **Product quantization (Subramanya et al., 2009).** Compress rather than prune.
  Split each vector into $m$ subvectors, assign each to its nearest centroid in a
  learned codebook, and store the code indexes. The index shrinks by roughly the
  compression ratio, and the distance is estimated from the codes. This is a
  memory optimization that usually stacks _under_ HNSW: HNSW navigates the
  compressed codes rather than the full vectors.

## The recall/latency trade-off, measured

Here is a runnable comparison. It builds a small clustered corpus — real
embeddings are not uniform on the sphere, and cluster structure is what makes
ANN behave as it does in practice — then compares exact search against an IVF
index at several `nprobe` settings, reporting recall@10 and how many vectors
each query actually scores.

```python
import numpy as np

rng = np.random.default_rng(7)
d, N, n_queries, K = 64, 20_000, 200, 10
n_topics = 20

centres = rng.normal(size=(n_topics, d))
centres /= np.linalg.norm(centres, axis=1, keepdims=True)

topics = rng.integers(0, n_topics, size=N)
X = centres[topics] + 0.55 * rng.normal(size=(N, d))
X /= np.linalg.norm(X, axis=1, keepdims=True)

qt = rng.integers(0, n_topics, size=n_queries)
Q = centres[qt] + 0.35 * rng.normal(size=(n_queries, d))
Q /= np.linalg.norm(Q, axis=1, keepdims=True)


def recall_at_k(pred, gold, k):
    """Fraction of the k true neighbours recovered within the top-k."""
    hits = sum(len(set(pred[i][:k]) & set(gold[i][:k])) for i in range(n_queries))
    return hits / (n_queries * k)


# Exact search defines the ground truth: it is the top-K by brute force.
gold = np.argsort(-(Q @ X.T), axis=1)[:, :K]
print(f"exact brute force   recall@{K} = {recall_at_k(gold, gold, K):.4f}")


def kmeans(data, k, iters=15, seed=0):
    r = np.random.default_rng(seed)
    c = data[r.choice(len(data), k, replace=False)].copy()
    for _ in range(iters):
        a = np.argmin(((data[:, None, :] - c[None, :, :]) ** 2).sum(-1), axis=1)
        for j in range(k):
            m = a == j
            if m.any():
                c[j] = data[m].mean(0)
    return c, a


nlist = 64
centroids, cell = kmeans(X, nlist)

for nprobe in (1, 4, 8, 16, 32, 64):
    pred, scored = [], 0
    for q in Q:
        cells = np.argsort(((centroids - q) ** 2).sum(-1))[:nprobe]
        visited = np.where(np.isin(cell, cells))[0]
        scored += len(visited)
        local = visited[np.argsort(-(X[visited] @ q))[:K]]
        pred.append(np.concatenate([local, [-1] * (K - len(local))]))
    frac = 100 * scored / n_queries / N
    print(
        f"IVF nprobe={nprobe:<2}    recall@{K} = {recall_at_k(np.array(pred), gold, K):.4f}"
        f"   scored/query = {scored / n_queries:7.1f} ({frac:5.2f}%)"
    )
```

Quantization is the other axis, and it trades recall for memory rather than
latency. The next block is the same corpus and the same codebook machinery,
swept over the number of subspaces:

```python
full = X.astype(np.float32)
exact = np.argsort(-(Q @ full.T), axis=1)[:, :K]
print(
    f"float32 index {full.nbytes/1024:7.0f} KiB"
    f"  recall@{K} = {recall_at_k(exact, gold, K):.4f}"
    f"  recall@1 = {recall_at_k(exact, gold, 1):.4f}"
)

for m in (16, 32, 64):
    per = d // m
    sub = X.reshape(N, m, per)
    codes = np.empty((N, m), dtype=np.uint8)
    codebooks = np.empty((m, 16, per), dtype=np.float32)
    for j in range(m):
        cb, a = kmeans(sub[:, j], 16)
        codebooks[j] = cb.reshape(16, per)
        codes[:, j] = a

    # Rebuild the vectors the codebooks describe, then search those.
    recon = codebooks[np.arange(m)[None, :], codes].reshape(N, d)
    top = np.argsort(-(Q @ recon.T), axis=1)[:, :K]
    print(
        f"m={m:<2} ({per:2d} dims/subspace) {N*m*4/8/1024:6.0f} KiB"
        f"  recall@{K} = {recall_at_k(top, gold, K):.4f}"
        f"  recall@1 = {recall_at_k(top, gold, 1):.4f}"
    )
```

```
float32 index   5000 KiB  recall@10 = 1.0000  recall@1 = 1.0000
m=16 ( 4 dims/subspace)   156 KiB  recall@10 = 0.2290  recall@1 = 0.1500
m=32 ( 2 dims/subspace)   312 KiB  recall@10 = 0.4965  recall@1 = 0.3350
m=64 ( 1 dims/subspace)   625 KiB  recall@10 = 0.8020  recall@1 = 0.7000
```

Two details in that block matter. The codes are held in a `uint8` array — one
byte per subspace, not four bits — and the size printed is the _packed_ size
`N*m*4/8`, so the numbers describe what the index would cost on disk rather than
what this array occupies. And search runs against reconstructed vectors, which is
brute force on an approximation: a real implementation scores the query against
the codebook and never materializes the reconstruction, but both orderings agree,
which is what makes the recall figure meaningful.

The output traces a clean monotone curve:

| `nprobe` | recall@10 | vectors scored per query | share of corpus |
| -------- | --------- | ------------------------ | --------------- |
| 1        | 0.1295    | 317.3                    | 1.59%           |
| 4        | 0.3555    | 1259.5                   | 6.30%           |
| 8        | 0.5165    | 2507.6                   | 12.54%          |
| 16       | 0.7165    | 5005.3                   | 25.03%          |
| 32       | 0.9040    | 9992.7                   | 49.96%          |
| 64       | 1.0000    | 20000.0                  | 100.00%         |

Three things are worth reading off it. Recall rises monotonically with `nprobe`
while the work grows proportionally — at `nprobe = 1` the index scores 1.59% of
the corpus and finds 13% of the neighbours. At `nprobe = 64`, which is all cells,
recall is exactly $1.0000$ and every vector is scored: the index has degenerated
into exact search, which is a useful correctness check that the code is right.
And the useful region is the middle: `nprobe = 16$–$32` buys 0.72 to 0.90 recall
at a quarter to a half of the work, while `nprobe = 1` is far too aggressive for
anything but the most forgiving query set.

Note how flat this curve is. With only 20 topics and 64 cells, a single probe
often misses an entire topic cluster, and recovering all ten neighbours requires
touching half the corpus. Real embeddings with finer topic structure behave
better than this toy, but the shape of the trade-off — recall bought roughly
linearly in work — is the general result, not an artifact of the example.

Product quantization trades accuracy for memory instead of latency. It splits the
64 dimensions into $m$ subspaces, fits 16 centroids on each — 4 bits per subspace,
so $4m$ bits per vector — and stores only the centroid index of each subspace. At
$m = 64$, one dimension per subspace, that is 4 bits per dimension instead of 32
and the index shrinks from 5000 KiB to 625 KiB, an 8× cut.

The cost shows up in recall, and it is steep enough that the number of subspaces
matters more than the bit width does:

| `m` | dims per subspace | index size | recall@10 | recall@1 |
| --- | ----------------- | ---------- | --------- | -------- |
| 16  | 4                 | 156 KiB    | 0.2290    | 0.1500   |
| 32  | 2                 | 312 KiB    | 0.4965    | 0.3350   |
| 64  | 1                 | 625 KiB    | 0.8020    | 0.7000   |

All three rows store 4 bits per subspace, so memory scales with $m$ — but recall
does not. Going from $m = 16$ to $m = 64$ quadruples the index and lifts recall@10
from 0.23 to 0.80. A 2-dimensional subspace is too small for a centroid to
describe: the codebook has 16 entries but they are all nearly the same point, so
the code carries almost no information. One dimension per subspace is the
degenerate case where quantization and plain rounding coincide, and it is the
cheapest setting that keeps the codebook actually useful.

Two properties of the numbers are worth naming. Degradation is worse at the top of
the ranking: recall@1 (0.7000) sits further below recall@10 (0.8020) than exact
search's 1.0000 would suggest, because the top few neighbours are separated by
small distances, which is exactly what coarse codes blur. And the compression
ratio is set by arithmetic, not by retrieval quality — 32 bits down to 4 bits is
8× by construction, whatever the recall turns out to be.

## Recall@k is measured against a ground-truth set, and that phrase hides the hard part

Given a ground-truth set of relevant documents $G$ for a query, recall@$k$ is the
fraction of $G$ that appears in the top-$k$ results:

$$
\mathrm{recall}@k = \frac{|R_k \cap G|}{|G|}
$$

where $R_k$ is the returned set. Written that way it looks trivial, and the
difficulty is entirely in constructing $G$. There are three cases, and they are
not equally trustworthy.

- **The ground truth is exact search's output.** Then recall@$k$ measures how
  closely the ANN index tracks exact search. This is legitimate and is what the
  table above reports — it answers "is my index faithful?", not "is my
  retrieval good?". A high number here can coexist with an index that retrieves
  nothing relevant, if relevance is judged by anything other than vector
  similarity.
- **The ground truth is human labels.** This is the real measure of retrieval
  quality, and it is expensive. Building it means pooling results from several
  systems, judging the union, and accepting that documents nobody retrieved are
  absent from the pool — which inflates recall for every system that was in the
  pool.
- **The ground truth is a proxy**, such as the source document that the question
  was written from. Cheap and often reasonable for question-answering corpora
  built from a known corpus, but it encodes an assumption: that the answer lives
  in the document the annotator had open.

The failure mode to avoid is the first case reported without the second. Many
teams tune `nprobe` until the index matches brute force, then report that recall
improved. Nothing about their system's ability to find the right document
changed.

The [BEIR benchmark](https://github.com/beir-cellar/beir) exists to make the
second case cheaper by standardizing many retrieval datasets under one
evaluation protocol; the
[Sentence Transformers documentation](https://www.sbert.net/) is a practical
reference for the embedding side.

## Isolating which stage is broken

Because exact search is available, the three failure modes separate cleanly.
Run the query both ways and compare against labelled ground truth:

- **Exact search finds it, ANN does not.** The index is misconfigured. Raise
  `nprobe` or `ef`, or check that vectors were normalized consistently at index
  and query time. This is a tuning bug, and it is the cheapest failure to fix.
- **Neither finds it, but a human would.** The embedding model does not place
  this query near this document. Try a different embedding model, or route the
  query to a lexical index as well — the fix is upstream in
  [reranking and hybrid search](/en/blog/reranking-and-hybrid-search).
- **Exact search finds it but the system still answers wrongly.** Retrieval was
  never the problem. Look at context construction and generation, which is the
  subject of [RAG fundamentals](/en/blog/rag-fundamentals).

This three-way split is the practical payoff of having exact search at all. It
converts "search feels bad" into a specific, fixable claim.

## What ANN cannot do

ANN gives up exactness by construction, and the loss is silent: the index never
reports that it skipped a better candidate. When recall drops, the system still
answers confidently, so a quality regression arrives as an increase in vague
wrong answers rather than as an error.

The memory ceiling is the other limit, and it is worth being precise about because
the arithmetic is unforgiving in an unexpected direction. The 625 KiB index above
holds 20,000 vectors at 32 bytes each, so a corpus of $n$ vectors costs $n/2^{25}$
GiB — about 0.30 GiB at ten million vectors, and 2.98 GiB at a hundred million.
Ten million is not a corpus that forces distributed search; a hundred million is,
and by a billion vectors the same arithmetic gives 29.80 GiB. The pressure arrives
later than the intuition suggests, and when it does arrive no amount of further
quantization closes the gap, because the remaining cost is the codebooks and the
graph structure that has to be searched, not the vector payload.

The real difficulty of scale is therefore not the bytes but the topology. An index
that fits is not yet queryable at a latency target: once the working set stops
fitting in RAM, every distance computation becomes a disk or network round trip,
and the fix is sharding plus a distributed search layer rather than a smaller
encoding.

What remains open is recall prediction. You can measure recall@k on a sample and
assume it holds, but there is no reliable cheap method to tell that a particular
configuration will satisfy a particular latency budget without benchmarking it on
the actual corpus, with the actual vectors, at the actual scale. The toy corpus
here is 20,000 vectors; the shape of the curve transfers, the constants do not.

## References

- Nandan Thakur, Nils Reimers, Andreas Rücklé, Steffen Kluters, Swapnil
  Puri, Alexander Fritz, Oleksandr Yandex and Savarese, "BEIR: A Heterogeneous
  Benchmark for Zero-shot Evaluation of Information Retrieval Models", NeurIPS
  2021 Datasets and Benchmarks, arXiv:2104.08663 — the zero-shot retrieval
  numbers used above.
- Jeff Johnson, Matthijs Douze and Hervé Jégou, "Billion-scale similarity
  search with GPUs", arXiv:1702.08734 — GPU k-selection and product
  quantization, the index design the product-quantization section measures
  against.
- Stefan Decker, Daniel Biehl, Jan Hendrik Buitinck and Isabelle Augenstein,
  "SIF: a fast and simple method for sentence embeddings", EMNLP 2017 — the
  weighted-common-component removal that the centering step in this lesson
  applies. Cited by title and venue: no arXiv identifier for this one was found,
  and a guessed identifier would have resolved to an unrelated astronomy paper.
