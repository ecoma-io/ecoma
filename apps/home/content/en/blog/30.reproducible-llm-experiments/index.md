---
title: 'Reproducible LLM experiments: from hypothesis to reliable results'
description: 'Hypotheses, baselines, controlled variables, seeds, dataset and version tracking, statistical uncertainty, ablations and negative results.'
date: '2026-10-13'
author: 'John Martin'
tags:
  - evaluation
  - ai
featured: false
cover: ../../../assets/cover-30-reproducible-llm-experiments.svg
coverAlt: 'Abstract error bars motif on a light background beside the lesson title'
articleId: reproducible-llm-experiments
seriesId: evaluation-and-rag
seriesOrder: 6
contentType: experiment
level: intermediate
prerequisites:
  - evaluating-language-models
  - evaluating-rag-systems
relatedArticleIds:
  - data-curation-quality-and-contamination
  - overfitting-regularization-bias-variance
---

# Reproducible LLM experiments: from hypothesis to reliable results

An experiment looks like it worked, three months later nobody can reproduce it,
and the number in the slide deck turns out to have been a single lucky run. This
lesson is the discipline that prevents that: how to state a hypothesis someone
else can check, choose a baseline worth beating, control the variables that move
on their own, report uncertainty instead of a point estimate, and publish the
experiments that did not work. After this you should be able to hand someone
your configuration and have them regenerate your table.

The failure this guards against is specific and quiet: a real effect that you
cannot distinguish from noise, reported as a result, and then built on.

## State the hypothesis before you run anything

A hypothesis is falsifiable and numeric. "RAG improves answer quality" cannot be
shown false, so it cannot guide anything. A usable one names the intervention,
the comparison, the metric, and the size of effect you would consider meaningful:

> With chunk size 512 instead of 256, recall@10 on the support corpus rises from
> 0.62 to at least 0.70, measured on the same 500 questions.

Write it down before running it, including the threshold that would make you
abandon the idea. A threshold chosen after seeing the data is not a threshold.
The discipline for connecting this to a decision is in
[evaluating language models](/en/blog/evaluating-language-models); the
measurement stack it draws on is in
[evaluating RAG systems](/en/blog/evaluating-rag-systems).

## The baseline is part of the hypothesis

A comparison needs two arms and a reason. The default baseline is the system in
production, because that is the thing you are replacing, but others are worth
naming explicitly:

- **Trivial baselines** keep the result honest. A random retriever, a BM25-only
  retriever, or "always answer from the model's parametric memory" cost almost
  nothing and reveal whether your system beats chance at all. Retrieval systems
  frequently look impressive against a strong baseline and worse than a cheap one.
- **Ablations** remove one component at a time to attribute the gain. A hybrid
  system no better than its dense half has learned nothing from fusion.
- **The oracle** marks the ceiling: the best answer achievable given perfect
  retrieval. This bounds how much any retrieval work can possibly return.

Report the number of arms and their configuration with the result. A result with
no baseline is a data point, not a finding.

## Controlling variables, including the ones you did not choose

Most experimental variation is not caused by the thing under test. In a retrieval
or generation system, the variables that move on their own include:

- **Prompt template.** Changing a space or an instruction reorders results.
  Template is a versioned artifact; an unversioned prompt is an unreproducible
  experiment.
- **Decoding parameters.** Temperature, top-p, max tokens, stop sequences. A
  greedy decode and a sampled decode are different systems.
- **Index state.** The corpus gains and loses documents; embeddings change when
  the model does. An experiment run against a different index than the baseline
  measures the index, not the change.
- **Data version.** Evaluation sets get amended. Hash the split, not its name.
- **Order effects.** Batching changes floating-point reduction order, which
  changes results in the last bits.

That last point deserves emphasis because it surprises people. Nondeterminism is
genuinely a property of GPU kernels, as the lesson on [distributed
training](/en/blog/distributed-training-parallelism) covers, but also of batch
composition, atomics, and library version. Identical inputs can produce
differently-rounded outputs, which can change an argmax, which changes a token,
which changes the rest of the sequence.

## Seeds, and what a seed actually fixes

A seed fixes a random number generator: data shuffling, dropout masks, negative
sampling, and sampling in generation. It does **not** fix nondeterministic kernels
or thread-count-dependent reduction order. A seeded run is reproducible only
insofar as the rest of the stack is.

The practical response is to set seeds everywhere you can _and_ to measure the
residual variation instead of assuming it away. Five runs of an identical
configuration:

```
accuracies: 0.700  0.715  0.685  0.730  0.705
mean 0.7070   sd 0.0168   sem 0.0075
95% t-interval (df=4, t=2.776): [0.6861, 0.7279]
best-minus-worst spread: 0.0450
```

That spread is the number that matters. Any claimed improvement below it is
indistinguishable from run-to-run noise, and reporting a single run as "the"
result is reporting noise.

## Track versions or the run is a rumour

Three things must be pinned for a result to be reconstructable:

- **Code** — a commit hash, not a branch name.
- **Data and models** — dataset version, evaluation split hash, model weight
  revision, embedding model version. An embedding change invalidates the whole
  index, as noted in
  [embedding retrieval](/en/blog/embedding-retrieval-similarity-and-ann).
- **Environment** — dependency lockfile, hardware, inference backend.

Record them with the results automatically, on every run. A config written down
by hand is a config that is wrong within two months.

## Report uncertainty, not point estimates

Two different intervals are needed and they answer different questions. A
**confidence interval across seeds** describes the variability of the system under
its own randomness. Given $m$ runs with mean $\bar{x}$ and sample standard
deviation $s$, the standard error is $s / \sqrt{m}$:

$$
\mathrm{SEM} = \frac{s}{\sqrt{m}},
\qquad
\text{CI}_{95\%} = \bar{x} \pm t_{0.975,\,m-1} \cdot \frac{s}{\sqrt{m}}
$$

With the numbers above, $0.7070 \pm 2.776 \times 0.0075 = [0.6861, 0.7279]$.

A **bootstrap interval on a difference** resamples evaluation items to ask
whether the measured difference would hold on new items. Resampling queries,
not seeds, is the right unit when the question is about the evaluation set.

Significance has to be tested, not eyeballed. For two systems answering the same
questions the paired test is correct, because only the items where they disagree
carry signal; the unpaired version of the same comparison understates the
evidence. The lesson on
[evaluating language models](/en/blog/evaluating-language-models) works the
arithmetic on a concrete 1.1-point difference that does not survive testing.

## Ablations attribute, and can embarrass

An ablation removes one component and measures the drop. Its value is
attribution: a hybrid retriever that loses nothing when you delete the lexical
half was not using it. Ablations also find that your best number came from a
component you should delete for cost reasons.

Run ablations on the components that cost the most as well as those that matter
most. The system with the highest accuracy is not the one to ship if it costs four
times as much for one point, and an ablation table is what makes that trade
explicit.

## Negative results are results

The most useful habit is publishing experiments that failed, with the same rigour
as successes. A recorded negative result prevents someone else from spending a
week on the same dead end, and it protects your team from re-litigating a
decision every quarter.

What makes a negative result worth reporting:

- **It was a real hypothesis**, stated in advance, not a straw man.
- **It had the power to detect the effect.** Testing for a 0.5-point change with
  an evaluation set too small to resolve 0.5 points is not a negative result; it
  is an uninformative one. Say which.
- **It is reported with its uncertainty.** "No effect detected, 95% CI
  $[-0.4, +0.6]$ points" is informative. "No effect" is not.
- **The failure mode is recorded.** Whether the intervention was wrong, the
  implementation buggy, or the measurement inadequate determines whether anyone
  retries.

A minimal harness that makes this automatic looks like this:

```python
import json
import os
import random
import statistics


def run_once(config, seed):
    """One evaluated run. A real harness calls the system under test here."""
    random.seed(seed)
    accuracy = 0.70 + (random.random() - 0.5) * 0.02  # placeholder for the real metric
    return {"seed": seed, "accuracy": accuracy}


def evaluate(config, seeds=(0, 1, 2, 3, 4)):
    results = [run_once(config, s) for s in seeds]
    accs = [r["accuracy"] for r in results]

    mean = statistics.fmean(accs)
    sd = statistics.stdev(accs)
    sem = sd / len(accs) ** 0.5
    t_crit = 2.776  # t_{0.975, df=4} for five runs

    return {
        "config": config,
        "code_commit": os.environ.get("GIT_COMMIT", "unknown"),
        "data_version": os.environ.get("DATA_VERSION", "unknown"),
        "seeds": list(seeds),
        "mean": mean,
        "sd": sd,
        "sem": sem,
        "ci95": [mean - t_crit * sem, mean + t_crit * sem],
        "raw": results,
    }


report = evaluate({"model": "baseline", "chunk_size": 512, "n_eval": 500})
print(json.dumps(report, indent=2))
```

Every run emits its config, code hash, data version, per-seed raw scores, and an
interval, so no result can exist without the metadata needed to interpret it. The
requirements reduce to this:

| Requirement           | Recorded by                                | Failure it prevents           |
| --------------------- | ------------------------------------------ | ----------------------------- |
| Same setup rerunnable | code commit, dependency lock               | "it worked on my machine"     |
| Same inputs           | data hash, model revision, index version   | silent drift in the corpus    |
| Same procedure        | seed list, decoding params, template hash  | unrepeatable generation       |
| Uncertainty visible   | per-seed raw scores, CI                    | noise reported as improvement |
| Failures kept         | one log row per hypothesis, either outcome | repeating dead ends           |

## What reproducibility does not solve

Reproducibility makes a result re-obtainable; it does not make it correct. A
rigorously reproduced contaminated benchmark score is still wrong, and a
perfectly seeded run on a 40-item set still cannot resolve a 1-point difference.
The statistical discipline has hard floors: with $m$ seeds the interval narrows as
$1/\sqrt{m}$, so ten seeds do not rescue a small evaluation set, and no amount of
seeding removes measurement error in the metric itself.

Two things remain genuinely hard. Establishing a trustworthy automatic judge
without a human-graded reference is unresolved, and it is the subject of
[evaluating RAG systems](/en/blog/evaluating-rag-systems). And publishing
negative results requires a culture that treats them as information rather than
as failed work — that is organizational, not technical, and no harness enforces
it. The [Hugging Face reproducibility
guide](https://huggingface.co/docs/transformers) is a practical starting point
for the versioning discipline.

## References

- The [Hugging Face Transformers documentation](https://huggingface.co/docs/transformers)
  on reproducibility, seeds, and deterministic data ordering — the practical
  starting point for the requirements table above.
- Bradley Efron, "Bootstrap Methods: Another Look at the Jackknife", The Annals
  of Statistics 7(1), 1979 — the resampling procedure behind the interval this
  lesson requires next to every point estimate.
