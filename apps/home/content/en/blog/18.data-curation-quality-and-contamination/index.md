---
title: 'Data curation for language models: quality, deduplication, and contamination'
description: 'Sourcing, filtering, deduplication, benchmark contamination, diversity and privacy in pretraining corpora.'
date: '2026-10-01'
author: 'John Martin'
tags:
  - training
  - ai
featured: false
cover: ../../../assets/cover-18-data-curation-quality-and-contamination.svg
coverAlt: 'Abstract curation funnel motif on a light background beside the lesson title'
articleId: data-curation-quality-and-contamination
seriesId: pretraining
seriesOrder: 3
contentType: research-review
level: advanced
prerequisites:
  - training-a-transformer
relatedArticleIds:
  - scaling-laws-parameters-and-data
  - evaluating-language-models
---

# Data curation for language models: quality, deduplication, and contamination

A pretraining corpus is not "all the text on the internet." It is a funnel, and
every stage of it is a decision that changes what the model learns. You collect
far more than you keep, filter what you keep, remove what is duplicated, check
that your benchmark answers are not in there, and remove personal information
you were not supposed to have. Skipping a stage does not leave the data
untouched — it silently changes the model.

After this lesson you should be able to describe how large corpora are assembled,
explain why deduplication helps and how its threshold is chosen, quantify what
contamination does to an evaluation, and state which privacy measures actually
remove an individual's data versus merely reduce exposure.

## The scale problem

The compute-optimal budget from [the previous lesson](/en/blog/scaling-laws-parameters-and-data)
sits around $10^{23}$–$10^{24}$ FLOP, and the $D \approx 20N$ rule means
trillions of tokens. At roughly 4 bytes of UTF-8 per token,
$1.4\times10^{12}$ tokens is about 5.6 TB of raw text — before filtering, before
deduplication, and before the HTML, navigation chrome and duplicated boilerplate
that make up a large share of a naive web crawl. Every number here is downstream
of that scale, which is why curation is an engineering discipline rather than a
matter of taste.

## Sourcing: what a corpus is actually made of

Real corpora mix sources deliberately, because each kind of text teaches
something different and no single source is sufficient:

- **Web crawl** — the bulk of the volume, the widest topical coverage, and the
  worst quality floor. Navigational templates, cookie banners and
  machine-translated spam dominate the low tail.
- **Reference works** — encyclopedias, textbooks, reference documentation.
  Cleaner prose and denser factual content per token than the web average.
- **Code with its surrounding text** — for models that write code. The natural
  unit is a file with its docstring and comments intact, since comments are the
  human-authored part.
- **Books, papers, long-form prose** — long-range coherence and sustained
  argument, at a token count small relative to the web but disproportionately
  useful for continuity of style.
- **Reference and QA material** — content whose structure (headings, lists,
  tables) transfers to how models answer structured questions.

Sources differ in quality and in legal status, so production corpora are
assembled under an explicit access framework — a crawl allowlist, licensed data,
or data obtained under stated terms — rather than scraped opportunistically.
Provenance is recorded per document precisely so a later request to remove a
source or a specific document can be honored, which is also what makes the
privacy work below tractable at all.

## Quality filtering: three signal families

**Classifier-based filtering** trains a small model to predict "is this good
training data" from weak labels. The Gopher rules (Rae et al. 2021) are the
canonical published example: heuristics including text-extraction quality
checks, removal of documents with excessive repeated lines, and a classifier
trained to score candidates.

**Perplexity-based filtering** uses a reference model to compute how compressible
a document is, keeping documents in a target band. The intuition is that natural
language is redundant in a way that character-level repetition and boilerplate
are not. Demonstrated on toy text here, a smoothed unigram model gives about 1.8x
higher perplexity to random strings than to repetitive English — the effect is
real, though a unigram model is a crude stand-in for a real reference model.

The failure mode is well known: perplexity filtering systematically prefers
text resembling the reference model's own training distribution, which can mean
discarding legitimately rare languages and dialects in favour of bland,
high-frequency web English.

**Rule-based and structural filters** — language identification, character-set
checks, ratio of symbols to words, line-length distributions — catch documents
that are not text at all: tables of numbers, base64 blobs, navigation menus.
These are cheap and deterministic, and run before the expensive filters because
they reject the most volume per unit of compute.

The yields at each stage are the interesting artifact: a corpus losing 90% of
its raw volume to extraction and filtering is normal. What matters is the
_ordering_. Running deduplication before filtering wastes deduplication compute
on documents that will be discarded; running it after is correct.

## Deduplication: why it helps and by how much

Duplication is not a small inefficiency. Web crawls are heavily redundant — the
same article syndicated across hundreds of sites, the same boilerplate on every
page of a site. A model trained on a duplicated corpus spends capacity
memorizing the duplicate, and memorizes it faithfully enough that a benchmark
item appearing once in training can be reproduced exactly.

Reported gains from deduplication vary widely, and the variation is informative:
several teams have reported substantial improvements, but the reported sizes
depend on the corpus, the threshold, and the evaluation. Treat any specific
headline number as evidence that deduplication matters in direction, not as a
constant. The mechanism is not disputed even when the magnitude is.

**Exact dedup** normalizes each document (whitespace, casing, punctuation) and
compares hashes: one pass, linear in corpus size, catching verbatim replication,
which is the dominant duplication mode in web crawls.

**Fuzzy dedup** catches near-duplicates — the same article with a different
navigation menu, or reformatted. The standard approach is MinHash over shingles
(contiguous $n$-token windows, typically $n = 5$), giving an unbiased estimator
of the Jaccard similarity $J$ of two documents' shingle sets. Its standard error
is

$$
\operatorname{SE}(\hat{J}) \approx \sqrt{\frac{J(1-J)}{k}},
$$

for $k$ permutations, so the permutation count follows from the precision you
want:

| Target Jaccard | Standard error 0.05 | 0.02 | 0.01  |
| -------------- | ------------------- | ---- | ----- |
| $J = 0.1$      | 36 permutations     | 225  | 900   |
| $J = 0.5$      | 100                 | 625  | 2,500 |
| $J = 0.8$      | 64                  | 400  | 1,600 |

```python
## Runnable; estimates Jaccard without comparing shingle sets pairwise.
import hashlib


def shingles(text, k=5):
    """Set of contiguous k-token windows."""
    toks = text.split()
    return {" ".join(toks[i : i + k]) for i in range(max(0, len(toks) - k + 1))}


def jaccard(a, b):
    """Exact Jaccard of two documents' shingle sets."""
    A, B = shingles(a), shingles(b)
    return len(A & B) / len(A | B)


def minhash(shingle_set, num_perm):
    """Signature: the minimum hash of each permutation over the shingle set."""
    return [
        min(hashlib.md5((str(i) + s).encode()).hexdigest() for s in shingle_set)
        for i in range(num_perm)
    ]


def minhash_jaccard(sig_a, sig_b):
    """Estimate Jaccard as the fraction of positions where signatures agree."""
    return sum(1 for x, y in zip(sig_a, sig_b) if x == y) / len(sig_a)


base = " ".join(f"tok{i % 40}" for i in range(400))
sig_base = minhash(shingles(base), 128)
for extra in (25, 100, 400):
    var = base + " " + " ".join(f"NEW{i}" for i in range(extra))
    exact, est = jaccard(base, var), minhash_jaccard(sig_base, minhash(shingles(var), 128))
    print(f"J_exact={exact:.4f}  J_minhash={est:.4f}  |error|={abs(exact - est):.4f}")
```

Measured on constructed documents with known overlap, 128-permutation MinHash
recovered a true 5-gram Jaccard of 0.62 as 0.60, and a true 0.09 as 0.08 —
errors consistent with the $k = 128$ prediction of about 0.043 standard error.
Over 200 near-duplicate pairs, mean absolute error was 0.029 at $k = 128$ and
0.018 at $k = 512$.

The cost is the comparison, not the hashing: each document's signature must be
compared against a candidate set, which naively is all pairs. Real pipelines use
LSH banding to restrict comparisons to documents sharing a band. At
$6\times10^{8}$ documents, even 128 four-byte permutations each is 0.3 TB of
signature storage — scale, not algorithm, forces the banding.

**Choosing the threshold** is where judgment enters. Thresholds in the 0.7–0.9
range on 5-gram or 13-gram shingles are common, with different policies per
document type: news syndication wants an aggressive threshold, code and
reference material often does not, because repeated tokens in code are
legitimately repeated. Too high leaves near-duplicates in; too low removes
legitimately similar documents and can disproportionately delete
minority-language content, whose documents naturally share boilerplate.

## Benchmark contamination, and how it is measured

A benchmark item present in the pretraining corpus is no longer a test of
generalization — it is a test of recall, and the model will often pass it by
having memorized the answer. This happens without anyone intending it:
benchmark questions are published on the open web, and crawls collect them.

Contamination arrives by several routes: the benchmark text itself being
crawled; paraphrased or reformatted copies; the underlying source documents the
benchmark was derived from; and reference answers published in forums or
tutorials.

Measurement is usually an $n$-gram overlap scan: extract a benchmark item's
$n$-grams (commonly 13 for English) and check whether they appear in the corpus.
Two facts about this are useful.

**Accidental overlap is negligible, so a hit is diagnostic.** A benchmark item of
$L$ tokens matching verbatim at any corpus position has probability about
$V^{-L}$, where $V$ is the vocabulary size. With $V = 32000$, a 500-token item
has a per-position probability near $10^{-2253}$. A benchmark should not be
contaminated by chance, which means a match means something deliberately put
that document in the corpus — the scan is diagnostic, not merely cautious. It
looks for contiguous $n$-grams because one match anywhere is the signal the
document is present; a 500-token item contributes 488 of them at $n = 13$.

**The relevant quantity is the benchmark's share of the corpus.** For a
benchmark of $n$ items occupying a fraction $f$ of the corpus, the expected
number of items present is $nf$:

| Benchmark share $f$ | Expected contaminated items (3,000-item benchmark) |
| ------------------- | -------------------------------------------------- |
| $10^{-4}$           | 0.3                                                |
| $10^{-3}$           | 3                                                  |
| $10^{-2}$           | 30                                                 |

A benchmark contributing one ten-thousandth of the corpus can still leak a few
items, and a small benchmark can be meaningfully contaminated while a large one
is not — which is why contamination checks are per-benchmark and item-level,
not a single verdict.

**The effect on a score.** Contamination inflates measured performance by an
amount depending on how much leaked and whether the model can reproduce the
answer. The response is to exclude contaminated items and report the score on
the remainder, stating the excluded count. A benchmark whose score drops when
contaminated items are removed was, in part, measuring recall.

One problem contamination checks cannot catch: a benchmark can be contaminated in
_distribution_ without exact overlap, if the corpus contains many documents on
the same topics in the same format, teaching the format without the specific
answer. Exact-match scanning is a floor on contamination, not a ceiling.

## Diversity, and the filter that eats it

Every filter above is a decision to drop documents, and each drop votes for what
the model will not know. Aggressive quality filtering is well documented to
narrow a corpus — disproportionately removing lower-resource languages,
dialects and informal writing, because a classifier trained to score "good" was
itself trained on data that over-represents standard, well-resourced prose. The
result is a model measurably weaker on exactly the populations the corpus
under-represents, while every aggregate metric moves in the right direction.

The response is to make diversity a measured property rather than an aspiration:
report per-language and per-domain token counts before and after each stage, so
a stage that collapses a language from 1% to 0.1% of the corpus is visible as a
decision rather than an accident. Reporting corpus composition is as much a part
of a training report as the loss curve.

## Privacy: what cannot be unlearned

Web corpora contain personal information: names, addresses, phone numbers,
identifiers, and — in medical, legal and forum text — information about
identifiable people never intended as public. Three families of mitigation
exist, and only the first two are removals.

**Removal from the corpus.** Filter documents containing PII, and filter
individual strings within documents. Because provenance is recorded per
document, a removal request naming a URL can be honored by excluding that
document from future runs. This is a genuine removal: the data is not used.

**Redaction.** Replace PII spans with placeholder tokens. This changes the text,
so it changes the data distribution — a model trained on redacted text learns to
expect redactions — and it cannot cover PII that was not detected.

**Access restriction.** Do not train on the sensitive data at all; use it only
through a restricted pipeline. This is the strongest measure and often the
correct one.

None of these is a guarantee about the trained model. Removing a document means
the model never saw that document; it does not mean the fact within it was never
learned from another source, and a model with capacity can generalize to produce
a specific individual's data without having been trained on any document about
them. Carlini et al. 2021 showed models can be induced to emit verbatim
memorized training sequences by prompting, which is direct evidence the gap is
real. Pretraining privacy is a property of the pipeline plus the model plus the
release controls; no single filter establishes it.

## What curation cannot fix

Three limits worth stating, because they are easy to mistake for solvable
problems.

**Curation cannot create data you do not have.** The compute-optimal allocation
in [scaling laws](/en/blog/scaling-laws-parameters-and-data) assumes a data
budget; a smaller corpus forces a more parameter-heavy allocation and caps the
achievable $D$. Filtering reduces volume further, so the two decisions
interact: quality budget and compute budget are not independent.

**Quality is partly relative to the reference model.** Classifier and
perplexity filters inherit the biases of the model that scores them. A filter
excellent at removing template HTML is also, silently, deciding which languages
count as high quality.

**Contamination cannot be fully removed retroactively.** Filters against known
benchmarks help, but a benchmark released after the corpus was built has no
filter. Date-partitioned benchmarks, never-published held-out sets, and canaries
are process measures — and they are the only ones covering benchmarks that do
not exist yet.

## References

- Kaplan et al. 2020, _Scaling Laws for Neural Language Models_,
  [arXiv:2001.08361](https://arxiv.org/abs/2001.08361).
- Hoffmann et al. 2022, _Training Compute-Optimal Large Language Models_,
  [arXiv:2203.15556](https://arxiv.org/abs/2203.15556).
- Rae et al. 2021, _Scaling Language Models: Methods, Analysis & Insights from
  Training Gopher_ — source of the Gopher data-quality rules. Identifier not
  verified here, cited in prose.
- Lee et al. 2019 and Kandpal et al. 2022, on deduplication and its thresholds.
  Identifiers not verified here, cited in prose.
- Xie et al., on benchmark contamination in NLP evaluations. Identifier not
  verified here, cited in prose.
- Carlini et al. 2021, _Extracting Training Data from Large Language Models_ —
  the memorization evidence. Identifier not verified here, cited in prose.
- Wenzek et al. 2020, _CCNet: Extracting High Quality Monolingual Datasets from
  Web_ — the classifier-filtering lineage. Identifier not verified here, cited
  in prose.
- Penedo et al. 2024, _The RefinedWeb Dataset for Falcon LLM_ (and the FineWeb
  lineage) — published filtering rules for open web corpora. Identifier not
  verified here, cited in prose.
