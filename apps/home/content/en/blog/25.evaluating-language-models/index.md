---
title: 'Evaluating language models: metrics, benchmarks, and experimental design'
description: 'Perplexity, task metrics, benchmark contamination, human evaluation and why one aggregate score cannot answer your question.'
date: '2026-10-08'
author: 'John Martin'
tags:
  - evaluation
  - ai
featured: false
cover: ../../../assets/cover-25-evaluating-language-models.svg
coverAlt: 'Abstract bar target motif on a light background beside the lesson title'
articleId: evaluating-language-models
seriesId: evaluation-and-rag
seriesOrder: 1
contentType: benchmark
level: intermediate
prerequisites:
  - language-modeling-next-token-prediction
  - data-curation-quality-and-contamination
relatedArticleIds:
  - evaluating-rag-systems
  - reproducible-llm-experiments
---

# Evaluating language models: metrics, benchmarks, and experimental design

Two candidates score almost identically on a public benchmark, and you must ship
one tonight. The aggregate score cannot tell you which, because it answers an
average question while your product asks a specific one. This lesson builds the
machinery to ask the specific question: what perplexity actually measures and
why it is not comparable across tokenizers, which task metric to reach for and
when each one fails, how contamination inflates published scores, how to design a
human evaluation you can afford, and how to attach an error bar to a difference
so small it may be noise.

## Perplexity is an average negative log-likelihood in disguise

Fix an evaluation corpus and tokenize it. Let $x_1, \dots, x_n$ be the resulting
tokens, and let $p_\theta(x_t \mid x_{<t})$ be the probability the model assigns
to token $x_t$ given everything before it. The per-token negative log-likelihood
is $-\log p_\theta(x_t \mid x_{<t})$, and perplexity is the exponential of the
mean:

$$
\mathrm{PPL} = \exp\!\left(-\frac{1}{n}\sum_{t=1}^{n}\log p_\theta(x_t \mid x_{<t})\right)
$$

The exponent is the average cross-entropy in nats, the quantity derived in
[information theory and cross-entropy](/en/blog/information-theory-and-cross-entropy).
Perplexity is that average on a multiplicative scale, which makes the units
intuitive: perplexity $V$ is what a model spreading probability uniformly over a
vocabulary of size $V$ would score.

Here is a five-token example where the model commits to a specific distribution.
On each token it assigns probability $(0.35, 0.30, 0.20, 0.10, 0.05)$ to the true
token, and these sum to one, so this is a well-formed categorical distribution.

| $t$ | $p$  | $-\log p$ |
| --- | ---- | --------- |
| 1   | 0.35 | 1.0498    |
| 2   | 0.30 | 1.2040    |
| 3   | 0.20 | 1.6094    |
| 4   | 0.10 | 2.3026    |
| 5   | 0.05 | 2.9957    |

The negative logs sum to $9.1616$, the mean is $1.8323$, and
$\exp(1.8323) = 6.2483$. In bits the mean is $1.8323 / \ln 2 = 2.6435$, against
$-\log(1/5) / \ln 2 = 2.3219$ bits for a uniform guess over the same five
options. The model is worse than uniform here, which is the honest reading:
perplexity $6.2483$ exceeds a vocabulary of size $5$.

```python
import math

# Per-token model probabilities for the five evaluation tokens.
probs = [0.35, 0.30, 0.20, 0.10, 0.05]
n = len(probs)
assert abs(sum(probs) - 1.0) < 1e-9, "not a probability distribution"

nll = [-math.log(p) for p in probs]
mean_nll = sum(nll) / n

print("nll per token :", [round(x, 4) for x in nll])
print("mean nll      :", round(mean_nll, 4))
print("perplexity    :", round(math.exp(mean_nll), 4))
print("bits per token:", round(mean_nll / math.log(2), 4))
```

## Why perplexity is not comparable across tokenizers

Perplexity is normalized _per token_, and the tokenizer is part of the model. A
tokenizer that splits text into more tokens gives a finer-grained target sequence
and pays the penalty repeatedly.

The extreme case makes this exact. A model assigning probability $1/V$ to every
token of a $V$-token vocabulary has mean negative log-likelihood $\ln V$, and
therefore perplexity exactly $V$. So a uniform model scores perplexity $50257$
with one tokenizer and $32000$ with another, with no change in knowledge
whatsoever. That is a ratio of $1.5705$: a model appearing 57% "better" purely
because of how it segments text.

The safe comparison is bits per token, or better **bits per byte**, which fixes
the unit of accounting to something tokenizer-independent. The related lesson on
[tokenization](/en/blog/tokenization-text-to-model-input) covers why tokenizer
choice is not neutral preprocessing. The recurring mistakes are:

- Comparing a published perplexity against your own without matching tokenizer,
  vocabulary size, and the context length the number was computed under.
- Comparing across model families whose training corpora differ. Perplexity is
  corpus-relative: a model trained on the evaluation set's subject matter wins
  there regardless of its general quality.
- Reading perplexity as a capability proxy. A model can be excellent at
  perplexity and useless at following instructions, because next-token prediction
  and instruction following are different objectives.

## Task metrics answer different questions, and each has a failure mode

- **Accuracy** is the fraction of items classified correctly. It fails when
  classes are imbalanced and error costs differ. An accuracy of 65% can mean a
  useless model on a 70/30 split or a strong one on a balanced binary task.
- **Exact match** requires the prediction string to equal the reference string.
  It is unforgiving about surface form and refuses to credit semantically correct
  answers. Given the gold answer `the deficiency causes fatigue` and the
  prediction `the deficiency causes fatigue in patients`, the content is
  identical and exact match scores it zero.
- **Token-level F1** measures overlap between prediction and reference tokens. On
  that same pair the gold set is `{the, deficiency, causes, fatigue}` and the
  prediction is `{the, deficiency, causes, night, sweating}`. Three tokens
  overlap, so precision is $3/5 = 0.60$ and recall is $3/4 = 0.75$, giving
  $F_1 = 2 \cdot 0.60 \cdot 0.75 / (0.60 + 0.75) = 0.6667$. F1 fails in the
  opposite direction: it rewards a prediction stuffed with plausible extra
  tokens, which is why it must be read beside precision.

These are metric choices, not metric bugs. The engineering mistake is picking
one because it is convenient and never inspecting the confusion cases.

## Benchmark contamination

Contamination is test data, or its near-duplicate, appearing in the training
corpus. When it happens the reported score measures memorization rather than
generalization, and the inflation is invisible unless you look for it.

Detection is judgement rather than a clean procedure. The reliable signals are
n-gram overlap between training set and benchmark, suspiciously high scores on
examples whose labels are odd enough to be memorized, and a benchmark score that
improves with no corresponding capability improvement. These checks must run
_before_ training, because after the fact you cannot separate "learned the task"
from "learned the answers". The lesson on
[data curation and contamination](/en/blog/data-curation-quality-and-contamination)
covers the deduplication machinery that makes this measurable.

Contamination also caps a benchmark's usefulness. Once a benchmark is widely
trained on, its score stops ordering models by quality and starts ordering them
by exposure. That is why the suites worth trusting are either refreshed on a
schedule or paired with held-out sets that were never released publicly.

## Designing a human evaluation you can afford

Some properties cannot be automated: helpfulness, tone, whether an answer is
usable by the person asking. Human evaluation is the fallback, and the design
work goes into making it cheap enough to run.

- **Annotate the decision, not the world.** Ask raters to compare two outputs
  side by side rather than score each on a 1–5 scale. Comparisons are faster and
  more consistent between raters than absolute scores.
- **Write the rubric before the pilot.** Specific criteria such as "cites the
  source it used" or "does not assert a price" outperform "is this good?". A
  vague rubric produces data you cannot compare across rounds.
- **Measure inter-annotator agreement** and report it. If two trained raters
  agree only by chance on a binary criterion, the criterion is not measuring what
  you think, no matter how many judgments you collect.
- **Budget from the decision, not from the budget.** If the decision flips on a
  three-point accuracy difference, you need enough judgments to resolve three
  points. If the decision is coarse, stop early.

The automated alternative is not a substitute, and
[evaluating RAG systems](/en/blog/evaluating-rag-systems) covers where LLM judges
fail — position bias, verbosity bias, self-preference — and what to do about it.

## One aggregate score cannot answer a specific question

Take two systems scoring 72.0% and 73.1% on 1000 items. That looks like a
1.1-point win. The unpaired standard error of the difference is
$\sqrt{0.72 \cdot 0.28/1000 + 0.731 \cdot 0.269/1000} = 0.0200$, so
$z = 0.011 / 0.0200 = 0.55$. Read as a sign test, that is nothing.

Done properly the comparison is _paired_, because both systems answered the same
1000 questions. Only the items where they disagree carry information. Suppose
system B alone gets 25 items right that A gets wrong, and A alone gets 14 right
that B gets wrong. McNemar's statistic with continuity correction is
$(25 - 14 - 1)^2 / (25 + 14) = 2.564$, giving $p = 0.109$ on one degree of
freedom. Not significant.

Now ask the question that actually matters. GLUE (Bowman et al., 2018),
SuperGLUE (Wang et al., 2019), and MMLU (Hendrycks et al., 2021) are each
_aggregates_ over many subtasks. An average over subtasks of unequal size is
dominated by the largest and by whichever subtasks are hardest for both models.
The same average can hide one subtask regressing sharply. And a system scoring
well on an aggregate is still, concretely, the system that misclassifies the one
class your users care about.

Self-evaluation techniques such as SelfCheckGPT (Manakul et al., 2023) estimate
whether a generation is supported by the model's own sampled alternatives, which
is useful for flagging low-confidence output at scale. It is not a substitute
for task metrics, because a confidently wrong answer and a correctly hedged one
can both pass it.

The operational rule: state the question first, then choose the metric that
answers it. "Is the system better?" is not answerable. "Does the new retriever
raise recall@20 on the support corpus?" is.

## Reporting uncertainty

A single number invites over-reading. Report the interval, the sample size, and
how many runs produced it.

For a single proportion the Wilson interval is a good default, because the
normal approximation degrades near 0 and 1. For 360 correct out of 500
($p = 0.72$) the Wilson 95% interval is $[0.6791, 0.7576]$, which does not
contain $0.75$. A claim of "about 72%, possibly 75%" is unsupported.

For seed-to-seed variation report the mean and a t-interval. Five runs of an
identical configuration giving $0.700, 0.715, 0.685, 0.730, 0.705$ have mean
$0.7070$, sample standard deviation $0.0168$, and standard error of the mean
$0.0075$. With $t_{0.975,4} = 2.776$ the 95% interval is $[0.6861, 0.7279]$, a
width of $0.0417$, while the best-minus-worst spread is $0.0450$. Any claimed
improvement smaller than a few points sits inside this band for a single
configuration.

Sample size sets what you can resolve. Detecting a 2-point difference at
$p = 0.72$ with a $\pm 1.0$-point half-width needs roughly 15490 items per arm; at
$\pm 2.0$ points, roughly 3873. Most internal evaluations are nowhere near that,
which is why the honest default is to report that a difference was not resolvable
rather than to report a ranking.

Reproducibility is the other half: same data version, same weights, same prompt
template, same decoding parameters, same seeds. The discipline for actually doing
this is the subject of
[reproducible LLM experiments](/en/blog/reproducible-llm-experiments).

## What these metrics cannot tell you

Perplexity is one scalar over an entire token distribution and says nothing about
whether a specific instruction is followed. Accuracy, exact match, and F1 each
encode one assumption about what counts as correct, and a system can be tuned to
any of them without becoming more useful. Aggregates conceal per-category
regressions, and contamination cannot be ruled out after the fact.

The open question is not whether better metrics exist — RAGAS (Es et al., 2023)
pushes on faithfulness and answer relevance, and G-Eval (Liu et al., 2023) on
rubric-based scoring — but whether a model-graded criterion can be trusted
without the slow human-graded calibration set that validates it. Until that gap
closes, the defensible procedure is a small trusted set, a cheap automatic metric
that tracks it, and a stated error bar on everything else. The
[BEIR benchmark collection](https://github.com/beir-cellar/beir) is a useful
reference for how varied retrieval evaluation sets are in practice.

## References

- Nandan Thakur, Nils Reimers, Andreas Rücklé, Steffen Kluters, Swapnil
  Puri, Alexander Fritz, Oleksandr Yandex and Savarese, "BEIR: A Heterogeneous
  Benchmark for Zero-shot Evaluation of Information Retrieval Models", NeurIPS
  2021 Datasets and Benchmarks, arXiv:2104.08663 — the eighteen retrieval
  collections behind the point about how varied evaluation sets are.
- Niklas Muennighoff, Nouamane Tazi, Loïc Magne, Michael Muennighoff and
  Iryna Gurevych, "MTEB: Massive Text Embedding Benchmark", EACL 2023,
  arXiv:2210.07316 — the embedding-side counterpart to BEIR, covering more than
  fifty languages and seven task types.
- Shahul Es, Jithin James, Luis Espinosa-Anke and Steven Schockaert, "RAGAS:
  Automated Evaluation of Retrieval Augmented Generation", EACL 2024 Demo,
  arXiv:2309.15217 — reference-free evaluation of faithfulness and answer
  relevance, the approach this lesson names as an open question rather than a
  settled answer.
