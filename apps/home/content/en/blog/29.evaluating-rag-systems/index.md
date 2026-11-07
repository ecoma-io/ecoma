---
title: 'Evaluating RAG systems: retrieval quality, faithfulness, and answer relevance'
description: 'Separate retrieval evaluation from generation evaluation, and judge correctness, faithfulness and citation support independently.'
date: '2026-10-12'
author: 'John Martin'
tags:
  - evaluation
  - ai
featured: false
cover: ../../../assets/cover-29-evaluating-rag-systems.svg
coverAlt: 'Abstract claim check motif on a light background beside the lesson title'
articleId: evaluating-rag-systems
seriesId: evaluation-and-rag
seriesOrder: 5
contentType: benchmark
level: advanced
prerequisites:
  - rag-fundamentals
  - evaluating-language-models
relatedArticleIds:
  - reproducible-llm-experiments
  - reranking-and-hybrid-search
---

# Evaluating RAG systems: retrieval quality, faithfulness, and answer relevance

A RAG system answers 82% of questions correctly and you cannot tell whether the
other 18% come from a retriever that missed the document, a context stuffed with
half-relevant passages, or a model that read the evidence and summarized it
badly. Those three need different fixes, different owners, and different budgets —
and a single end-to-end number hides all three. This lesson builds the
measurement stack for RAG: retrieval evaluated separately from generation,
correctness separated from faithfulness, and a frank treatment of LLM-as-judge
including where it is biased and how to calibrate it. The failure taxonomy is the
part that pays: it turns "accuracy dropped" into a work item.

## Measure retrieval on its own terms

Retrieval has a ground truth that generation does not: a set of documents known
to be relevant. The core measurement is whether the gold document was retrieved.

- **Hit rate@$k$** — 1 if at least one relevant document appears in the top $k$,
  else 0. The simplest useful signal, and the right one when a single document
  answers the question.
- **Recall@$k$** — $|R_k \cap G| / |G|$, the fraction of relevant documents
  retrieved. The right one when an answer needs several documents, where it
  strictly dominates hit rate.

Both need a judgement of what is relevant, which is a labelling task rather than
an algorithmic one. The honest way to build the pool is to take the union of
results from every system you intend to compare, annotate that union once, and
then score each system against it. Skipping the union step means documents no
system retrieved are invisible to the evaluation, and every system gets credit it
did not earn.

Critically, retrieval quality must be measured **before** generation consumes it.
Once the model has answered, you can no longer attribute a failure to retrieval
versus reading. Log the retrieved set, the prompt, and the raw output for every
evaluation query, so that failures can be replayed offline.

## Measure generation against three separate questions

Once you have an answer, three properties are independent and must be scored
independently, because they fail for different reasons.

- **Correctness** — does the answer match the reference? Scored by exact match or
  token-level F1 for extractive tasks, and by human or LLM judging for free-form
  ones. This is the metric users feel, and it depends on retrieval having
  succeeded.
- **Faithfulness** — is every claim in the answer supported by the retrieved
  context? Note what faithfulness does _not_ mean: it says nothing about whether
  the context was right. An answer that faithfully quotes an irrelevant or
  out-of-date passage is faithful and useless.
- **Answer relevance** — does the answer address the question that was asked?
  Retrieving related material and answering the wrong question is a distinct
  failure, and it is what an over-broad query or a bad prompt produces.

Correctness and faithfulness are genuinely orthogonal, and conflating them is the
most common way a RAG evaluation misleads. Written formally, with $C$ the set of
claims an answer makes, $S$ the subset the retrieved context supports, and $L$
the subset carrying a citation:

$$
\mathrm{faithfulness} = \frac{|S|}{|C|},
\qquad
\mathrm{citation\ coverage} = \frac{|L|}{|C|}
$$

Consider an answer making three claims, two backed by the retrieved chunk and
one invented:

| Property                   | Value                      | Reading                             |
| -------------------------- | -------------------------- | ----------------------------------- |
| Claim A: revenue rose 12%  | supported, cites chunk-3   | fine                                |
| Claim B: costs fell in Q3  | supported, cites chunk-3   | fine                                |
| Claim C: headcount doubled | not supported, no citation | invention                           |
| Faithfulness               | 2/3 = 0.6667               | a third of the answer is unbacked   |
| Citation coverage          | 2/3 = 0.6667               | unsupported claims are also uncited |

The invented claim is uncited, which is the useful coincidence — but it is not
guaranteed. A system can hallucinate _and_ attach a citation, and then citation
coverage reads 1.0 while faithfulness is lower. Measuring citation presence
separately from citation support is exactly what catches this, and it is why
"did it cite a source" is not a proxy for "is it true".

## Citations and attribution

Citation support asks a specific question per citation: does the cited span
actually entail the claim attached to it? This is stricter than "a citation is
present" and much stricter than "the answer mentions the source", and it is the
only version that detects a citation pointing at the wrong passage in the right
document.

Three practical notes. First, attribution should be forced at construction time —
requiring an id for each claim makes support checkable, while hoping for
voluntary citations gives you an unmeasurable system. Second, measure
attribution _precision_ (of the claims made, how many are supported) separately
from _coverage_ (of the available evidence, how much was used); a system can have
high precision and low coverage, which reads as reliable and uninformed.
Third, citation correctness is verifiable against the source text without any
model, which makes it one of the cheapest trustworthy metrics in the stack.

## Failure analysis: the part that tells you what to build next

Bucketing every failure by cause turns a score into a backlog. Take 40 evaluated
questions and classify each failure:

| Bucket          | Count | Share | What fixes it                             |
| --------------- | ----- | ----- | ----------------------------------------- |
| Correct         | 26    | 65.0% | —                                         |
| Retrieval miss  | 6     | 15.0% | embeddings, chunking, query rewriting     |
| Distractor      | 4     | 10.0% | reranking, $k$ tuning, context ordering   |
| Synthesis error | 4     | 10.0% | prompt, model choice, instruction clarity |
| Total           | 40    | 100%  |                                           |

The three failure buckets mean different things:

- **Retrieval miss** — the gold document never entered the candidate set. Only
  upstream work helps: chunking, embedding model, query expansion.
- **Distractor** — the gold document was retrieved _and_ irrelevant ones
  crowded it out of the final context. The retriever worked; the ranking or the
  context budget did not.
- **Synthesis error** — the right evidence was present and the model used it
  wrongly, or ignored it and answered from parametric memory.

The arithmetic that follows is the whole point of the table. Retrieval reached
the gold document for 34 of 40 questions, so a _perfect_ retriever would cap
accuracy at $(26 + 4 + 4) / 40 = 0.85$. The remaining 15% is unreachable by any
amount of retrieval work. That ceiling tells you the maximum return on the
retriever before you spend anything on it — and here, the two retrieval buckets
together are 10% of questions, while the synthesis bucket is 10% as well, so the
work splits evenly rather than pointing unambiguously at retrieval. Note also
that this ceiling is only valid if better retrieval does not introduce new
distractors, which is exactly why the distractor bucket is tracked separately.

The bucketing is mechanical once the labels exist, and cheap to recompute every
time the system changes:

```python
from collections import Counter

# Every evaluated question, labelled with what actually went wrong.
verdicts = ["correct"] * 26 + ["retrieval_miss"] * 6 + ["distractor"] * 4 + ["synthesis"] * 4
counts = Counter(verdicts)
total = len(verdicts)

print(f"{'bucket':<16}{'count':>6}{'share':>9}")
for bucket in ("correct", "retrieval_miss", "distractor", "synthesis"):
    print(f"{bucket:<16}{counts[bucket]:>6}{100 * counts[bucket] / total:>8.1f}%")
print(f"{'total':<16}{total:>6}")

# Ceiling on accuracy from perfect retrieval: only retrieval_miss is fixed by it.
reachable = total - counts["retrieval_miss"]
print(f"\nretrieval found gold for {reachable}/{total} questions")
print(f"accuracy ceiling with a perfect retriever = {reachable / total:.4f}")

# Faithfulness and citation coverage over the claims in one answer.
claims = [
    ("revenue rose 12%", True, "chunk-3"),
    ("costs fell in Q3", True, "chunk-3"),
    ("headcount doubled", False, None),
]
supported = sum(1 for _, s, _ in claims if s)
cited = sum(1 for _, _, c in claims if c is not None)
print(f"\nfaithfulness      = {supported}/{len(claims)} = {supported / len(claims):.4f}")
print(f"citation coverage = {cited}/{len(claims)} = {cited / len(claims):.4f}")
```

This is also why end-to-end accuracy is a poor optimization target. Improving it
requires simultaneously getting harder, unmeasured decisions right.

## LLM judges are useful and biased

Judging free-form answers by hand does not scale, so the practical choice is an
LLM judge with a written rubric. It correlates with human judgement well enough
to be useful, and it carries specific, documented biases:

- **Position bias** — the judge favours whichever output appears first, so swap
  the order and re-measure. A comparison whose verdict flips with ordering is
  measuring position, not quality.
- **Verbosity bias** — longer answers with more hedging score higher even when
  the extra text adds nothing. G-Eval (Liu et al., 2023) showed that rubric-based
  judging with explicit step-by-step criteria substantially improves agreement
  over naive prompting.
- **Self-preference** — a judge tends to favour text from the same model family
  it belongs to, which quietly biases any comparison between models of
  different lineages, including evaluations published by those models.

The mitigations are practical rather than theoretical:

- **Randomize and report.** Run both orderings, average, and publish the
  position-agreement rate as its own number.
- **Calibrate against human labels.** Take a sample scored by both, and report
  the judge's agreement with humans per criterion. This is the number that says
  whether the judge can be trusted, and it belongs in every results table that
  relies on one.
- **Use multiple judges for decisions that matter.** Disagreement between
  independent judges bounds your confidence more honestly than a single verdict.
- **Prefer verifiable metrics where they exist.** Citation entailment and exact
  match need no judge at all.

RAGAS (Es et al., 2023) formalizes this by decomposing RAG evaluation into
retrieval and generation components with separately computed faithfulness and
answer-relevance scores, and is the standard reference for the decomposition
used here. The
[TruLens documentation](https://www.trulens.org/) is a practical reference for
instrumenting these measures in a running system.

## What this evaluation stack cannot tell you

Judging faithfulness by model is not the same as verifying it against a source,
and the gap shows up exactly where systems are weakest: unsupported claims that
happen to be fluent. Human calibration sets are small by necessity, so a judge's
agreement rate is itself estimated with wide error bars.

Recall metrics also depend entirely on a relevance pool built from the systems
you already have; a new retrieval approach that surfaces genuinely relevant
documents nobody retrieved looks like a regression against that pool. Pooling
helps and does not solve this.

The genuinely open problem is reliable abstention. A system that knows when its
evidence is insufficient, and says so, would outperform one that always answers;
measuring whether a system abstains _correctly_ rather than abstains often is
still an unsolved evaluation problem, and the metrics above do not capture it.

## References

- Shahul Es, Jithin James, Luis Espinosa-Anke and Steven Schockaert, "RAGAS:
  Automated Evaluation of Retrieval Augmented Generation", EACL 2024 Demo,
  arXiv:2309.15217 — reference-free faithfulness and answer-relevance metrics,
  which is the measurement this lesson treats as promising but unsettled.
- Nandan Thakur, Nils Reimers, Andreas Rücklé, Steffen Klutters, Swapnil
  Puri, Alexander Fritz, Oleksandr Yandex and Savarese, "BEIR: A Heterogeneous
  Benchmark for Zero-shot Evaluation of Information Retrieval Models", NeurIPS
  2021 Datasets and Benchmarks, arXiv:2104.08663 — where the retrieval-side
  Recall@k and nDCG figures above are measured.
- The [TruLens documentation](https://www.trulens.org/) — the instrumentation
  and evaluation framework referenced above; it is a practical tool reference,
  not evidence for any metric defined here.
