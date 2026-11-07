---
title: 'Embeddings: turning discrete symbols into learned geometry'
description: 'Embedding tables, similarity functions, and what vector geometry can and cannot tell you.'
date: '2026-09-23'
author: 'John Martin'
tags:
  - machine-learning
  - ai
featured: false
cover: ../../../assets/cover-10-embeddings-learned-geometry.svg
coverAlt: 'Abstract point cloud motif on a light background beside the lesson title'
articleId: embeddings-learned-geometry
seriesId: classical-machine-learning
seriesOrder: 5
contentType: theory
level: intermediate
prerequisites:
  - linear-algebra-projections-and-rank
  - supervised-learning-and-generalization
relatedArticleIds:
  - embedding-retrieval-similarity-and-ann
  - tokenization-text-to-model-input
---

# Embeddings: turning discrete symbols into learned geometry

A retrieval system receives a query and returns documents. The documents are text;
the query is text. Neither is a point, and there is no arithmetic on strings that
corresponds to meaning — edit distance says `crown` and `crow` are neighbours, which
is true and useless. So the first thing any such system does is throw away the
strings and keep a fixed-length vector per item, and the whole design question becomes
what to put in those vectors and what to compute between them.

There is a tempting story here: replace symbols with points, and meaning becomes
distance. That story is roughly true, and it is wrong in specific ways that matter
enough to cost accuracy. A vector's length is not meaning. Most of the coordinates
in a real embedding space are nearly constant across every item, so raw cosine
similarity is dominated by a component that carries no information at all. And the
analogy arithmetic that made word embeddings famous is a genuine property of a
particular corpus, not a law about language.

After reading this you should be able to state what cosine and Euclidean distance
each measure, derive why they agree exactly on the unit sphere and disagree sharply
off it, build a distributional embedding from raw counts, and explain why
mean-centering an embedding space changes retrieval behaviour.

## From symbol to point

An embedding of a set of $V$ items into $\mathbb{R}^d$ is a table $E \in
\mathbb{R}^{V \times d}$ whose $j$-th row $\mathbf{e}_j$ is the vector for item $j$.
For a word, $V$ is the vocabulary size and $d$ is a few hundred. For a document,
$V$ is the collection size. Nothing about the table is learned by magic: the rows are
parameters, updated by gradient descent, and their usefulness is judged entirely by
whether the geometry they induce matches a similarity you care about.

That is the whole contract. Everything below is about how to make the geometry
earned rather than assumed.

Two similarity functions cover almost all use, and the choice between them is not
stylistic.

**Cosine similarity** is the inner product after normalization:

$$
\mathrm{cos}(\mathbf{a}, \mathbf{b}) = \frac{\mathbf{a} \cdot \mathbf{b}}
{\|\mathbf{a}\|_2 \, \|\mathbf{b}\|_2}
$$

**Euclidean distance** is the straight-line norm:

$$
\|\mathbf{a} - \mathbf{b}\|_2 = \sqrt{\sum_i (a_i - b_i)^2}
$$

The difference is entirely about the norm $\sqrt{a_i^2 + b_i^2}$. Cosine throws it
away; Euclidean does not. Both are one matrix product and one square root, so cost is
never the reason to choose. The reason is what the norm means.

```python
import numpy as np

np.set_printoptions(suppress=True)

r1 = np.random.default_rng(0)
U = r1.normal(0, 1, (6, 3))
V = r1.normal(0, 1, (4, 3))
U /= np.linalg.norm(U, axis=1, keepdims=True)
V /= np.linalg.norm(V, axis=1, keepdims=True)

cosine = lambda a, b: float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
euclid = lambda a, b: float(np.linalg.norm(a - b))

anchor = np.array([1.0, 0.0])
for k in (1.0, 2.0, 5.0):
    b = k * anchor
    print(f"scale {k:4.1f}  cosine {cosine(anchor, b):+.6f}  euclidean {euclid(anchor, b):.6f}")

pairs = [(cosine(U[i], V[j]), euclid(U[i], V[j])) for i in range(6) for j in range(4)]
by_cos = sorted(pairs, reverse=True)
by_euc = sorted(pairs, key=lambda t: t[1])
print(f"top 3 by cosine:    {[(round(c, 4), round(e, 4)) for c, e in by_cos[:3]]}")
print(f"top 3 by euclidean: {[(round(c, 4), round(e, 4)) for c, e in by_euc[:3]]}")
print(f"same ordering on the unit sphere: {[p[1] for p in by_cos] == [p[1] for p in by_euc]}")
```

Vectors at `scale 5.0` are five times longer than the anchor yet score cosine
`+1.000000` and Euclidean `4.000000` against it — the same direction, opposite
verdicts. Whatever the norm of an embedding encodes is whatever you have just told
your retriever to weight.

There is an exact algebraic identity behind the unit-sphere agreement:

$$
\|\mathbf{a} - \mathbf{b}\|_2^2 = \|\mathbf{a}\|_2^2 + \|\mathbf{b}\|_2^2 - 2\,\mathbf{a} \cdot \mathbf{b}
$$

If $\|\mathbf{a}\|_2 = \|\mathbf{b}\|_2 = 1$ the two norm terms are constants, so
minimizing the distance is exactly maximizing the dot product, and cosine is the
same ranking. When the norms differ, the identity still holds but the term
$\|\mathbf{a}\|_2^2 + \|\mathbf{b}\|_2^2$ no longer cancels and stops being a constant
across pairs — which is exactly when Euclidean starts measuring something cosine
ignores.

## Building an embedding from counts

You do not need a neural network to get a distributional embedding. The classical
pipeline is: count co-occurrences, reweight so that ubiquitous words stop
dominating, then compress with a truncated factorization. Each step has a reason.

**Step one, counts.** Let $C_{ij}$ count how often item $i$ co-occurs with item $j$
in a context window. $C$ is a $V \times V$ matrix — rows × columns — and it is
utterly uninformative on its own, because a word like _the_ co-occurs with
everything.

**Step two, reweighting.** Divide by the marginals and take the log:

$$
\mathrm{PMI}_{ij} = \log \frac{p(i, j)}{p(i)\, p(j)}
$$

PMI is positive for pairs that co-occur more than independence predicts. Raw positive
PMI additionally floors the negatives to zero, on the grounds that a pair is either
informative or it is evidence of nothing. That is a crude but effective filter.

**Step three, factorization.** The matrix $M$ is $V \times V$ and, for any real
corpus, near-singular: most of its mass sits in a handful of directions. Write
$M \approx U\Sigma V^\top$ and keep the top $d$ columns, so that $\mathbf{e}_j$ is
row $j$ of $U_d\Sigma_d$. This is a truncated eigendecomposition of an association
matrix, and it is the step that turns a $V$-dimensional one-hot into a
$d$-dimensional point. SVD is the standard tool:
[`numpy.linalg.svd`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.svd.html).

```python
TOPICS = {
    "royal":  ["king", "queen", "prince", "princess", "royal", "crown"],
    "animal": ["bull", "cow", "cat", "kitten", "whisker", "bark"],
    "vessel": ["ship", "boat", "sloop", "canoe", "deck", "mast"],
}
MALE = ["king", "prince", "bull", "cat", "ship", "sloop"]
FEMALE = ["queen", "princess", "cow", "kitten", "boat", "canoe"]
NEUTRAL = ["royal", "crown", "whisker", "bark", "deck", "mast"]

VOCAB = [w for group in TOPICS.values() for w in group]
IDX = {w: i for i, w in enumerate(VOCAB)}
r2 = np.random.default_rng(0)

CONTEXT = {}
for group in TOPICS.values():
    for i, w in enumerate(group):
        CONTEXT[w] = [group[(i + k) % len(group)] for k in (1, 2, 3, 4)]
for w in MALE + FEMALE:
    topic = next(g for g in TOPICS.values() if w in g)
    CONTEXT[w] = CONTEXT[w] + [x for x in topic if x in NEUTRAL]
for w in VOCAB:
    CONTEXT[w] = CONTEXT[w] + list(r2.choice(VOCAB, size=2, replace=False))

C = np.zeros((len(VOCAB), len(VOCAB)))
for w, partners in CONTEXT.items():
    for p in partners:
        C[IDX[w], IDX[p]] += 1.0

row, col = C.sum(1, keepdims=True), C.sum(0, keepdims=True)
total = float(C.sum())
seen = C > 0
PPMI = np.zeros_like(C)
PPMI[seen] = np.log(C[seen] * total / (row * col)[seen])
PPMI[PPMI < 0.0] = 0.0

Us, S, Vt = np.linalg.svd(PPMI, full_matrices=False)
print(f"singular values: {' '.join(f'{s:.4f}' for s in S[:6])}")

D = 8
E = Us[:, :D] * S[:D]
v = lambda w: E[IDX[w]]
cos = lambda p, q: float(p @ q / (np.linalg.norm(p) * np.linalg.norm(q)))

for a, b in (("king", "queen"), ("king", "bull"), ("bull", "cow"),
             ("cat", "kitten"), ("king", "ship"), ("queen", "ship")):
    print(f"    {a:6s} {b:7s} {cos(v(a), v(b)):+.4f}")
```

The corpus is three blocks — royalty, animals, ships — and the gender contrast
_repeats in all three_: king/queen, bull/cow, ship/boat. That repetition is the whole
design. A direction estimated from one pair is a guess; a direction confirmed by three
independent blocks is a property of the corpus.

The singular values decay from 6.4531 to 2.7280 over the first six directions out of
eighteen, and the cosines show the structure: _king_–_queen_ at `+0.9371` (same
block, same gender), _bull_–_cow_ at `+0.6854` (same block, opposite gender), _king_–_ship_
at `+0.2873` (different blocks, same gender), _queen_–_ship_ at `+0.2041`. Both
factors are present and neither dominates. That is why the count matrix had a real
low-rank structure to find.

**Analogy arithmetic.** If gender is a direction, then `king - man + woman` should
land near `queen`:

$$
\mathbf{e}_{\text{queen}} \approx \mathbf{e}_{\text{king}} - \mathbf{e}_{\text{man}} + \mathbf{e}_{\text{woman}}
$$

```python
q = v("king") - v("bull") + v("cow")
ranked = sorted(((cos(q, v(w)), w) for w in VOCAB), reverse=True)
names = [w for _, w in ranked]
print(f"analogy cosine to queen {cos(q, v('queen')):+.4f}, rank {names.index('queen') + 1} of {len(VOCAB)}")
print("top five: " + ", ".join(f"{w} {s:+.4f}" for s, w in ranked[:5]))
```

Queen lands at rank 3 of 18 with cosine `+0.6998`, behind _king_ at `+0.7793` and
_crown_ at `+0.7376`. **That is the honest result and it should not be dressed up:**
the arithmetic does not isolate gender, so the query lands in the neighbourhood of
royalty generally, and two other royalty words legitimately outrank the intended
answer. This is a corpus with eighteen items and no real distributional statistics.
Real embeddings, trained on billions of tokens with far more structure than three
graded blocks, do far better — which is why the analogy result is worth reporting at
all. But the failure mode is instructive and general: analogy quality is bounded by
how cleanly the direction is estimated, and arithmetic on vectors cannot manufacture
a distinction the corpus never encoded.

Two cautions about interpreting these numbers. The matrix is $18 \times 18$ and
symmetric by construction, so it has 171 independent entries at most; any pattern
this small could be a coincidence of my construction. And this is **not** word2vec:
Mikolov et al. (2013) trained a neural network on a skip-gram objective, and Levy &
Goldberg (2014) later showed that SGNS — skip-gram with negative sampling —
implicitly factorizes a shifted PMI matrix, which is why the two approaches produce
similar geometry. The factorization route above is the clearer way to see the
mechanism, not a historical claim about how word2vec was built.

## Anisotropy: the component that measures nothing

Here is the failure that does not show up in a toy corpus. Real embedding spaces are
**anisotropic** — not spread evenly, but clustered in a narrow cone around a common
direction. Two consequences follow, and both hurt retrieval.

First, every pair looks similar. If all vectors point roughly the same way, then
cosine is high for everything, and the top of a ranking is dominated by whichever
items happen to be least aligned with the shared direction rather than most relevant
to the query. Second, and more subtly, the useful signal is not gone — it has just
moved into the directions _orthogonal_ to the shared one, which is a small fraction
of the space.

```python
def mean_cos(M):
    """Mean pairwise cosine over all distinct pairs."""
    Un = M / np.linalg.norm(M, axis=1, keepdims=True)
    G = Un @ Un.T
    iu = np.triu_indices(len(M), 1)
    return float(G[iu].mean())


r3 = np.random.default_rng(7)
NOISE = r3.normal(0, 1, (3000, 128))
common = r3.normal(0, 1, 128)
for scale in (0.0, 0.5, 2.0, 8.0):
    M = NOISE + scale * common
    mu = M.mean(axis=0)
    print(f"shared component scale {scale:4.1f}: raw mean cosine {mean_cos(M):+.4f}   "
          f"centered {mean_cos(M - mu):+.4f}   "
          f"||mean||/mean||row|| {np.linalg.norm(mu) / np.mean(np.linalg.norm(M, axis=1)):.4f}")
```

The shared component is pure noise — one direction, no information — and it alone
drives the raw mean cosine from `-0.0001` at scale 0.0 to `+0.9855` at scale 8.0.
Two hundred thousand documents that have nothing to do with each other score 0.9855
cosine. Subtract the mean and every row goes back to `-0.0003`, regardless of scale:
centering removes exactly the shared component and nothing else.

The third column says how much of a typical vector's length the mean accounts for —
`0.0160` when there is no shared direction, `0.9927` when the shared direction
dominates. At the extreme, the norm of an embedding is almost entirely the
component that is common to all embeddings, which is why raw cosine is the wrong
default and why normalization to the unit sphere is not a formality.

**Centering is not the only fix.** It removes the first principal direction and
nothing else. When several common directions exist, the standard alternative is
**all-but-the-top**: remove the top $k$ principal components before comparing. That is
the same linear algebra as PCA, run on the embedding matrix rather than on data:

```python
r4 = np.random.default_rng(3)
N, D_PCA = 4000, 256
spectrum = np.concatenate([np.full(4, 6.0), np.linspace(2.0, 0.05, D_PCA - 4)])
X = r4.normal(0, 1, (N, D_PCA)) * spectrum.reshape(1, -1)
Xc = X - X.mean(axis=0)
S = (Xc.T @ Xc) / (len(Xc) - 1)
evals = np.linalg.eigvalsh(S)[::-1]
cumulative = np.cumsum(evals / evals.sum())
for k in (1, 2, 4, 10, 50):
    print(f"top {k:3d} principal directions hold {cumulative[k - 1]:.4f} of the variance")

totals = []
for _ in range(200):
    R = np.linalg.qr(r4.normal(0, 1, (D_PCA, 10)))[0]
    totals.append(float(np.trace(R.T @ S @ R) / evals.sum()))
print(f"ten random orthonormal directions hold {np.mean(totals):.4f} of the variance")

flat = np.random.default_rng(3).normal(0, 1, (N, D_PCA))
flatc = flat - flat.mean(axis=0)
ev = np.linalg.eigvalsh((flatc.T @ flatc) / (len(flatc) - 1))[::-1]
print(f"isotropic cloud, top 10 of 256 hold {ev[:10].sum() / ev.sum():.4f}")
```

This spectrum is the reason PCA fails as a semantic representation, stated
numerically. The top 10 of 256 directions hold `0.3460` of the variance — about 8.9
times what ten random orthonormal directions hold (`0.0389`), and far more than the
`0.0589` a genuinely isotropic cloud gives. Yet 65% of the variance sits in the
remaining 246 directions, and the tail is where the discriminative detail lives. A
truncation that keeps the high-variance directions throws away most of the signal
along with the noise. **Variance is not importance**, and PCA is a poor embedding
because it optimizes the wrong objective.

## What makes a similarity function work

Put the pieces together in a retrieval setting. Documents are drawn from topic
clusters, and one noise direction is shared by all of them — the anisotropy above, at
realistic strength.

```python
r5 = np.random.default_rng(0)
D_R, TOPIC_N, PER, QUERY_N, K = 32, 40, 60, 2000, 10
centres = r5.normal(0, 1, (TOPIC_N, D_R))
shared = r5.normal(0, 1, D_R)
offset = lambda n, s: np.outer(r5.normal(s, 0.2, n), shared)

docs = np.repeat(centres, PER, axis=0) + r5.normal(0, 1.0, (TOPIC_N * PER, D_R))
docs = docs + offset(TOPIC_N * PER, 6.0)
labels = np.repeat(np.arange(TOPIC_N), PER)
queries = np.repeat(centres, QUERY_N // TOPIC_N, axis=0) + r5.normal(0, 1.0, (QUERY_N, D_R))
queries = queries + offset(QUERY_N, 6.0)
qlab = np.repeat(np.arange(TOPIC_N), QUERY_N // TOPIC_N)

mu = docs.mean(axis=0)
print(f"mean pairwise cosine among documents: {mean_cos(docs):.4f}")
print(f"||mean||/mean||row||: {np.linalg.norm(mu) / np.mean(np.linalg.norm(docs, axis=1)):.4f}")
for tag, Q, Dv in (("raw cosine", queries, docs),
                   ("centered cosine", queries - mu, docs - mu)):
    Qn = Q / np.linalg.norm(Q, axis=1, keepdims=True)
    Dn = Dv / np.linalg.norm(Dv, axis=1, keepdims=True)
    top = np.argsort(-(Qn @ Dn.T), axis=1)[:, :K]
    counts = np.bincount(top.ravel(), minlength=len(Dv))
    slots = QUERY_N * K
    prec = float(np.mean(labels[top] == qlab[:, None]))
    print(f"{tag:>16}: busiest document takes {counts.max():4d} of {slots} slots "
          f"(expected {slots / len(Dv):5.2f});  precision@{K} {prec:.4f}")
```

Mean pairwise cosine is `0.9533`, so on raw cosine almost nothing is distinguishable
from anything else. Centering lifts precision@10 from `0.8790` to `0.9005` — a real
improvement from deleting one direction.

The hubness column is the more interesting measurement, and it is about the index,
not the ranking. Over 20000 neighbour slots the busiest document takes 42 of them
when expected at random is 8.33, and it is still that document five times over. This
is **hubness**: a few points become neighbours of nearly everything, and in a real
vector index — an HNSW graph, an IVF partitioner — a hub distorts the graph
structure, not just the score list. Hubness is a property of the geometry, and
centering reduces it (42 down to 36 here), which is why post-processing helps
throughput and not only accuracy.

Note what centering does **not** fix: precision is still below 0.91, because the
clusters themselves overlap at this dimension and offset strength. No
post-processing rescues a representation that never separated the topics.

## What this lesson does not settle

The factorization pipeline is a historical illustration, not a recommendation.
Truncated SVD of a co-occurrence matrix is dominated by frequency effects that
contextual embeddings were invented to remove: every occurrence of _bank_ produces
one row, regardless of which sense was meant. Supervised sentence encoders
(Reimers & Gurevych, 2019) do better on retrieval for exactly this reason, at the
cost of requiring labels and a transformer.

Anisotropy has a documented explanation but no settled cure. The shared component is
believed to arise from a mismatch between the training objective and the geometry —
models trained with an unnormalized softmax are pushed toward occupying a small region
of the sphere rather than spreading out — but this remains an active question with
competing accounts. Ethayarajh (2019) measured the effect directly and found that the
contextualized representations of ELMo, BERT and GPT-2 are non-isotropic in every
layer, so the narrow-cone geometry above is a property of trained encoders rather than
of this toy corpus. Do not treat "center your embeddings" as a universal fix; it is a
cheap intervention that helps when anisotropy is the dominant problem and does nothing
when it is not.

Finally, similarity is not the same as relevance. Every measurement here scores
geometric proximity, and the ground truth is topical membership. A system that scores
`0.9005` on precision@10 in this synthetic setup would still be unusable if what you
needed was "documents that are _about_ this specific event" — near-duplicates and
off-topic-but-adjacent passages are geometrically excellent matches. The similarity
function is the part you can reason about from geometry alone; everything past it
needs a learned reranker, and that is where the remaining error lives. The practical
consequence is that the ANN index, the similarity choice, and the embedding model are
coupled decisions — changing the similarity function invalidates the index — which is
why
[embedding retrieval](/en/blog/embedding-retrieval-similarity-and-ann) treats them as
one design problem.

## References

- Tomas Mikolov, Kai Chen, Greg Corrado and Jeffrey Dean, "Efficient Estimation of
  Word Representations in Vector Space", ICLR Workshop 2013 — the skip-gram
  objective that made distributional vectors practical at scale.
- Omer Levy and Yoav Goldberg, "Neural Word Embedding as Implicit Matrix
  Factorization", NeurIPS 2014 — shows SGNS implicitly factorizes a shifted PMI
  matrix, which is why it reproduces the geometry above.
- Nils Reimers and Iryna Gurevych, "Sentence-BERT: Sentence Embeddings using Siamese
  BERT-Networks", EMNLP 2019 — supervised sentence encoders, and the standard
  baseline for semantic retrieval.
- Kawin Ethayarajh, "How Contextual are Contextualized Word Representations?
  Comparing the Geometry of BERT, ELMo, and GPT-2 Embeddings", EMNLP 2019,
  arXiv:1909.00512 — measures the isotropy question empirically, layer by layer,
  across BERT, ELMo and GPT-2; the finding is that no layer of any of the three is
  isotropic.
- Jeff Johnson, Matthijs Douze and Hervé Jégou, "Billion-scale similarity search with
  GPUs", arXiv:1702.08734 — GPU k-selection and product-quantization search at
  billion-vector scale, and the origin of the quantized indexes in production
  systems. The hubness measurements above are this lesson's own; the paper is cited
  for the index design, not for that measurement.
