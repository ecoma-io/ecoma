---
title: 'Reranking and hybrid search: improving retrieval quality'
description: 'Lexical retrieval, dense retrieval, hybrid fusion, cross-encoder reranking, ranking metrics, and candidate recall versus ranking quality.'
date: '2026-10-11'
author: 'John Martin'
tags:
  - evaluation
  - ai
featured: false
cover: ../../../assets/cover-28-reranking-and-hybrid-search.svg
coverAlt: 'Abstract rerank ladder motif on a light background beside the lesson title'
articleId: reranking-and-hybrid-search
seriesId: evaluation-and-rag
seriesOrder: 4
contentType: research-review
level: intermediate
prerequisites:
  - embedding-retrieval-similarity-and-ann
relatedArticleIds:
  - evaluating-rag-systems
  - rag-fundamentals
---

# Reranking and hybrid search: improving retrieval quality

Retrieval brought back nine good candidates and put the right one at position
seven. No amount of index tuning fixes that, because the candidate was never
missing — it was ranked badly. This lesson covers the two halves of retrieval
quality separately: getting the right documents into the candidate set, and
ordering them once they are there. You will end up able to score BM25 by hand,
fuse a lexical and a dense ranking without knowing their scales, compute MRR and
NDCG precisely, and tell from a single measurement whether your problem is
candidate generation or ranking.

## Lexical retrieval and the term that makes BM25 work

A lexical retriever scores documents by matching query terms literally. BM25
(Robertson et al., the TREC line of work) is the refinement that still dominates:
term frequency saturates, document length is normalized, and rare terms count for
more. For a query $Q$, document $D$, and collection of $N$ documents:

$$
\mathrm{score}(Q, D) = \sum_{t \in Q} \mathrm{IDF}(t) \cdot \frac{f(t, D) \cdot (k_1 + 1)}{f(t, D) + k_1 \left(1 - b + b \frac{|D|}{\mathrm{avgdl}}\right)}
$$

Each symbol earns its place. $f(t, D)$ is the **term frequency**: how many times
term $t$ occurs in document $D$. $|D|$ is the document length in tokens and
$\mathrm{avgdl}$ is the average length across the collection. The ratio
$|D| / \mathrm{avgdl}$ is what makes long documents not automatically win, and the
parameter $b \in [0,1]$ controls how strongly length is penalized; $b = 0$ ignores
length entirely. The parameter $k_1$ controls saturation in the numerator's
denominator: as $f(t,D)$ grows, the factor
$f(t,D)(k_1+1) / (f(t,D) + k_1(\ldots))$ approaches $k_1 + 1$, so the tenth
occurrence of a term adds far less than the second. This is the property that
distinguishes BM25 from raw term counting, where a long document mentioning a word
thirty times would outrank one that mentions it three times.

The IDF term does the opposite job, weighting _distinctiveness_:

$$
\mathrm{IDF}(t) = \ln \frac{N - \mathrm{df}(t) + 0.5}{\mathrm{df}(t) + 0.5} + 1
$$

where $\mathrm{df}(t)$ is the number of documents containing $t$. A term in every
document gets an IDF near zero, so repeating it adds nothing; a rare term gets a
large weight. The $+1$ keeps the value non-negative, which matters in small
collections where the classic Robertson IDF turns negative for terms appearing in
more than half the documents.

Here is a four-document collection scored by hand, so the arithmetic is checkable:

```python
import math

docs = {
    "d1": "the quick brown fox jumps",
    "d2": "the lazy dog sleeps",
    "d3": "quick brown foxes leap",
    "d4": "a quick brown hare naps",
}
N = len(docs)
k1, b = 1.2, 0.75
query = "quick fox"


def bm25(query, doc, docs, k1=1.2, b=0.75):
    """BM25 score of one document for one query."""
    N = len(docs)
    dl = len(docs[doc].split())
    avgdl = sum(len(v.split()) for v in docs.values()) / N
    total = 0.0
    for term in query.split():
        tf = docs[doc].split().count(term)
        if tf == 0:
            continue
        df = sum(1 for v in docs.values() if term in v.split())
        idf = math.log((N - df + 0.5) / (df + 0.5) + 1)
        total += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
    return total


scores = {d: bm25(query, d, docs) for d in docs}
for d, s in scores.items():
    print(f"BM25({d}) = {s:.6f}")
print("ranking:", sorted(scores, key=lambda d: -scores[d]))
```

```
BM25(d1) = 1.492793
BM25(d2) = 0.000000
BM25(d3) = 0.373659
BM25(d4) = 0.341167
ranking: ['d1', 'd3', 'd4', 'd2']
```

`d2` scores zero because it matches neither query term. `d1` wins decisively: it
contains both `quick` and `fox`, while `d3` matches only `quick` (its `foxes` does
not match the stem `fox`, which is a real limitation of unstemmed lexical matching)
and `d4` matches only `quick` too, losing to `d3` on length normalization since
`d3` is shorter. Notice `d3` and `d4` are close despite `d4` also containing `a`
and `hare` — BM25 is scoring query terms, and non-query terms contribute nothing.

The practical failure mode is vocabulary mismatch. A user searching `refund
policy` gets nothing for a document headed `Returns & Cancellations`, and no
amount of tuning $k_1$ or $b$ repairs it. This is the gap that motivated dense
retrieval.

## Dense retrieval matches meaning, and fails differently

Dense passage retrieval (Karpukhin et al., 2020) encodes the query and each
passage with a bi-encoder — two towers that produce one vector each — and
retrieves by vector similarity, which is the machinery in
[embedding retrieval](/en/blog/embedding-retrieval-similarity-and-ann). Training
the towers on question-to-passage pairs is what makes this work; an off-the-shelf
sentence embedding trained only on semantic similarity does not know that a
question and its answer passage should land near each other.

Sentence-BERT (Reimers & Gurevych, 2019) made such embeddings cheap enough to
use by distilling a cross-encoder into a bi-encoder's vectors, and is the usual
starting point in practice.

Dense retrieval solves vocabulary mismatch: `refund policy` and `Returns &
Cancellations` become near each other. It introduces different failures:

- **Failure on rare, exact identifiers.** A part number, an error code, or a
  person's name is often a single token with little distributional signal, and
  the embedding blurs it. Lexical retrieval handles these perfectly.
- **Failure on exact keyword filtering.** Metadata constraints like `status =
  archived` must be enforced as filters, never as similarity.
- **A silent embedding upgrade problem.** Changing embedding models invalidates
  every stored vector. This is the same footgun as the similarity choice in the
  previous lesson, at corpus scale.

The two approaches fail in systematically different places, which is what makes
combining them worth the complexity:

| Property                       | BM25 (lexical)                      | Dense (bi-encoder)                    |
| ------------------------------ | ----------------------------------- | ------------------------------------- |
| Matches                        | literal terms, stemmed              | semantic similarity                   |
| Rare identifiers, part numbers | strong                              | often weak                            |
| Vocabulary mismatch            | fails                               | strong                                |
| Exact keyword filters          | strong, but as a filter not a score | must be enforced separately           |
| Corpus dependency              | IDF recomputed per collection       | embeddings stable across corpora      |
| Cost of reindexing             | fast, minutes                       | re-embed the whole corpus             |
| Failure mode                   | returns nothing                     | returns something plausible and wrong |

The two families fail on disjoint cases, which is the entire argument for
combining them.

## Fusing two rankings whose scores cannot be compared

Weighted sum fusion takes a score from each system and adds them with a weight
$w$ on the lexical side. The obstacle is that the raw scores are incomparable:
BM25 scores are unbounded and corpus-dependent, cosine similarity lives in
$[-1, 1]$. You must normalize first, and min-max is the usual choice — rescale
each system's scores to $[0,1]$ over the candidate set. That has a defect worth
stating: min-max depends on the candidates present, so the same document gets a
different normalized score in different result sets.

Reciprocal rank fusion (RRF) sidesteps the problem by discarding magnitudes
entirely and using only ranks:

$$
\mathrm{RRF}(d) = \sum_{r \in \mathcal{R}} \frac{1}{K + \mathrm{rank}_r(d)}
$$

where $\mathcal{R}$ is the set of systems and $\mathrm{rank}_r(d)$ is document
$d$'s rank in system $r$. The constant $K$ damps the influence of the top
positions; $K = 60$ is the conventional value.

```python
# Two systems that disagree: the lexical favourite is not the dense favourite.
lex = {"A": 9.10, "B": 6.40, "C": 6.05, "D": 5.90}
den = {"A": 0.55, "B": 0.88, "C": 0.30, "D": 0.31}


def minmax(d):
    lo, hi = min(d.values()), max(d.values())
    return {k: (v - lo) / (hi - lo) for k, v in d.items()}


ln, dn = minmax(lex), minmax(den)
for w in (0.2, 0.5, 0.8):
    fused = {k: w * ln[k] + (1 - w) * dn[k] for k in lex}
    order = ",".join(sorted(fused, key=lambda k: -fused[k]))
    print(f"w_lex={w}: " + " ".join(f"{k}={fused[k]:.3f}" for k in lex) + "  -> " + order)

# Solving w*ln[A] + (1-w)*dn[A] == w*ln[B] + (1-w)*dn[B] gives the crossover.
a, b, da, db = ln["A"], ln["B"], dn["A"], dn["B"]
print(f"crossover w* = {(db - da) / ((a - b) + (db - da)):.6f}")

lex_rank = {"A": 1, "B": 2, "C": 3, "D": 4}
den_rank = {"A": 3, "B": 1, "C": 4, "D": 2}
K = 60
rrf = {k: 1 / (K + lex_rank[k]) + 1 / (K + den_rank[k]) for k in lex_rank}
for k in lex_rank:
    print(f"RRF({k}) = 1/(60+{lex_rank[k]}) + 1/(60+{den_rank[k]}) = {rrf[k]:.6f}")
print("RRF ranking:", ",".join(sorted(rrf, key=lambda k: -rrf[k])))
```

```
w_lex=0.2: A=0.545 B=0.831 C=0.009 D=0.014  -> B,A,D,C
w_lex=0.5: A=0.716 B=0.578 C=0.023 D=0.009  -> A,B,C,D
w_lex=0.8: A=0.886 B=0.325 C=0.037 D=0.003  -> A,B,C,D
crossover w* = 0.402746
RRF(A) = 1/(60+1) + 1/(60+3) = 0.032266
RRF(B) = 1/(60+2) + 1/(60+1) = 0.032522
RRF(C) = 1/(60+3) + 1/(60+4) = 0.031498
RRF(D) = 1/(60+4) + 1/(60+2) = 0.031754
RRF ranking: B,A,D,C
```

The weighted-sum rows show why fusion is a tuning problem and not a free win: at
$w = 0.2$ the dense system wins and ranks `B` first, at $w = 0.5$ and above the
lexical system wins, and the crossover is at $w^* = 0.402746$. One weight
flips the answer, and the correct weight is corpus-specific and query-specific.
The RRF result is worth comparing: it ranks `B` first too, despite `A` being the
lexical favourite, because `B` sits near the top of both lists. That is RRF
acting as an agreement detector. And RRF produces that answer with no weight to
choose and no score to calibrate — multiply the entire lexical dictionary by 100
and the ranks, and therefore the RRF output, are unchanged.

The corresponding cost is that RRF throws away magnitude information. A document
ranked first with a score barely above the second is treated the same as one that
dominated its list, which can be either helpful or harmful depending on whether
your score gaps are meaningful.

## Cross-encoder reranking and why it costs more

Every retriever so far scored documents independently: embed each passage once,
score against the query. A cross-encoder (Johnson, 2019) instead feeds the query
and the document together through a single transformer and scores the pair
directly. Because the two attend to each other at every layer, the model can
represent token-level interactions that independent scoring cannot — "the
service was _not_ faulty" reads differently from "the service was faulty".

The cost is arithmetic, not incidental. Scoring $C$ candidates independently
costs $C$ forward passes of a small model, or one pass per candidate. A
cross-encoder must run the query _with_ each candidate, and the attention cost
grows quadratically with sequence length, so each of those passes is far more
expensive than the embedding lookups it replaces. This is why the standard
architecture is retrieve-then-rerank: use the cheap bi-encoder to cut $N$
documents down to $C \approx 50$–$200$, then spend the expensive model only on
those. Reranking the whole corpus with a cross-encoder is not a cost decision,
it is a budget error.

## Ranking metrics, defined precisely

- **Recall@$k$** is $|R_k \cap G| / |G|$, the fraction of relevant documents
  retrieved at all. Position-blind.
- **Mean reciprocal rank** measures where the _first_ relevant document lands. For
  one query with its first relevant document at rank $r$, the reciprocal rank is
  $1/r$, and MRR is the mean over queries:

$$
\mathrm{MRR} = \frac{1}{n}\sum_{i=1}^{n} \frac{1}{\mathrm{rank}_i}
$$

- **NDCG@k** handles graded relevance and discounts by position. With gain
  $g_i$ at rank $i$ and an ideal ordering $g_i^*$:

$$
\mathrm{DCG}@k = \sum_{i=1}^{k} \frac{g_i}{\log_2(i + 1)},
\qquad
\mathrm{NDCG}@k = \frac{\mathrm{DCG}@k}{\mathrm{DCG}@k^{\text{ideal}}}
$$

The $\log_2(i+1)$ denominator is the discount: position 1 gets weight 1, position
2 gets $1/\log_2 3 \approx 0.63$, position 10 gets $1/\log_2 11 \approx 0.29$.

```python
import math

# MRR: first relevant document at ranks 1, 2, 3, 4 across four queries.
ranks = [1, 2, 3, 4]
print(f"MRR = {sum(1 / r for r in ranks) / len(ranks):.6f}")
print(f"single query, rank 2 -> RR = {1 / 2:.4f}")


def dcg(gains):
    return sum(g / math.log2(i + 1) for i, g in enumerate(gains, start=1))


ideal = [3, 1, 0]      # graded relevance of the ideal top-3
retrieved = [1, 3, 0]  # our ranking: the weak document is placed first
idcg = dcg(ideal)
print(f"DCG  = {dcg(retrieved):.6f}")
print(f"IDCG = {idcg:.6f}")
print(f"NDCG@3 = {dcg(retrieved) / idcg:.6f}")
```

```
MRR = 0.520833
single query, rank 2 -> RR = 0.5000
DCG  = 2.892789
IDCG = 3.630930
NDCG@3 = 0.796708
```

The NDCG example is deliberately not a clean failure. Our ranking puts the
gain-1 document first and the gain-3 document second, so a reader sees a weaker
result above a stronger one, and NDCG@3 of $0.7967$ records a substantial loss
without collapsing to zero. Note also that this system returns the same three
documents as the ideal, in a different order: recall@3 would be 1.0. That is the
distinction the next section is about.

## Candidate recall and ranking quality are different numbers

Consider one query where the gold set is $\{g_1, g_2\}$ and the retrieval stack
returns, in order, `d7, d1, g1, d8, g2, d9`.

- **Candidate recall@6 = 1.0**: both gold documents reached the reranker.
- **Gold documents in the final top 2 = 0.0**: neither survived reranking.

Both facts are real and they point at opposite fixes. A cross-encoder cannot be
tuned to fix this, because it was given the right candidates and ranked them
badly. Conversely, a better embedding model cannot fix it, because the candidates
were already present. Any end-to-end metric that reports only the final answer
blends these two failure modes into one number, which is precisely the aggregate
problem set out in
[evaluating language models](/en/blog/evaluating-language-models).

The practical procedure is to instrument both and fix them in order. If candidate
recall is low, work upstream on chunking, embeddings, and query construction. If
candidate recall is high but the final ranking is poor, work on the reranker, the
fusion weights, or the number of candidates you rerank.

## What reranking cannot fix

Reranking reorders the candidate set; it never adds to it. A document absent from
the candidates is unreachable, which bounds every technique in this lesson by the
retriever underneath. Cross-encoders also inherit the biases of their training
data and can confidently prefer a longer passage that restates the question over a
terse one that answers it, so rerankers are not neutral.

Measurement remains the constraint. Tuning a fusion weight or a reranker on the
same split you report is how hybrid search ends up looking better than it is; the
discipline for avoiding that is in
[reproducible LLM experiments](/en/blog/reproducible-llm-experiments), and the
[Anserini](https://github.com/castorini/anserini) and
[BEIR](https://github.com/beir-cellar/beir) projects are good references for
standardized retrieval evaluation. What remains genuinely unsettled is whether
learned fusion, which predicts the right combination per query rather than using
one global weight, pays for its extra complexity in a way that generalizes past
the corpus it was tuned on — the crossover point computed above is fixed per
corpus, and that fixity is the limitation no amount of tuning removes.

## References

- Stephen Robertson and Hugo Zaragoza, "The Probabilistic Relevance Framework:
  BM25 and Beyond", Foundations and Trends in Information Retrieval, 2009 — the
  saturation and length-normalization derivation behind the scoring function
  implemented above.
- Gordon V. Cormack, Charles L. A. Clarke and Stefan Buettcher, "Reciprocal
  Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods",
  SIGIR 2009 — the rank-only fusion rule, including the constant $K = 60$ used
  here, which has no published derivation and is an empirical choice.
- Omar Khattab and Matei Zaharia, "ColBERT: Efficient and Effective Passage
  Search via Contextualized Late Interaction over BERT", SIGIR 2020,
  arXiv:2004.12832 — late interaction, the middle ground between bi-encoder and
  cross-encoder scoring.
- Vladimir Karpukhin, Barlas Oğuz, Sewon Min, Patrick Lewis, Ledell Wu,
  Sergey Edunov, Danqi Chen and Wen-tau Yih, "Dense Passage Retrieval for
  Open-Domain Question Answering", EMNLP 2020, arXiv:2004.04906 — the
  bi-encoder retrieval baseline the lexical scores here are fused against.
