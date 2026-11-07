---
title: 'Language modeling: probability, likelihood, and next-token prediction'
description: 'The autoregressive factorization, teacher forcing, and what next-token prediction does and does not teach a model.'
date: '2026-09-25'
author: 'John Martin'
tags:
  - language-modeling
  - ai
featured: false
cover: ../../../assets/cover-12-language-modeling-next-token-prediction.svg
coverAlt: 'Abstract chain probability motif on a light background beside the lesson title'
articleId: language-modeling-next-token-prediction
seriesId: language-modeling
seriesOrder: 2
contentType: theory
level: intermediate
prerequisites:
  - tokenization-text-to-model-input
  - information-theory-and-cross-entropy
relatedArticleIds:
  - attention-from-first-principles
  - evaluating-language-models
---

# Language modeling: probability, likelihood, and next-token prediction

Autoregressive language modeling has one job: given the tokens so far, assign a probability to every token in the vocabulary for what comes next. Everything else — generation, perplexity, pretraining loss — is a consequence of that distribution or a way of measuring it.

The objective looks trivially simple, which is exactly why it is worth being precise about. Three things are routinely confused: the probability of a sequence, the loss a model actually optimizes, and the metric a practitioner reports. They are related but distinct, and most confusion about "what does the model learn" dissolves once they are separated. By the end of this lesson you should be able to write the factorization yourself, compute a likelihood by hand, explain why training never generates text, and state clearly what next-token prediction does and does not install in a model.

## The chain rule, applied to text

Write a token sequence as $x_1, x_2, \ldots, x_n$. The joint probability of the whole thing is intractable to model directly, because the space of sequences is $V^n$. The **chain rule** of probability says any joint distribution factorises into a product of conditionals:

$$
P(x_1, x_2, \ldots, x_n) = \prod_{t=1}^{n} P(x_t \mid x_1, x_2, \ldots, x_{t-1})
$$

For language this reads: the probability of a sentence is the probability of its first token times the probability of the second given the first, and so on. Each conditional is a distribution over $V$ options conditioned on a prefix. That distribution is what the network computes.

This is not an approximation the model makes. It is exact. The model is given credit for a full joint distribution, assembled from $n$ next-token distributions, and the whole point of the architecture is to make each conditional cheap to evaluate in parallel. The derivation in [attention from first principles](/en/blog/attention-from-first-principles) explains how a single forward pass yields the conditional at every position at once.

The autoregressive factorization therefore converts an intractable joint problem into $n$ tractable categoricals. The price is a constraint on what data looks like: the factorization is causal by construction, and each token is conditioned only on its left context.

## A worked chain, computed exactly

Take the six-token sentence "the cat sat on the mat". Suppose a model produces these next-token distributions:

| prefix             | next token | probability |
| ------------------ | ---------- | ----------- |
| (start)            | the        | 0.40        |
| the                | cat        | 0.30        |
| the cat            | sat        | 0.55        |
| the cat sat        | on         | 0.70        |
| the cat sat on     | the        | 0.60        |
| the cat sat on the | mat        | 0.80        |

Multiplying along the chain:

$$
P(\text{the cat sat on the mat}) = 0.40 \times 0.30 \times 0.55 \times 0.70 \times 0.60 \times 0.80 = 0.022176
$$

The running product, so each step is auditable: $0.400000$, then $0.120000$, then $0.066000$, then $0.046200$, then $0.027720$, then $0.022176$.

Two observations follow immediately. First, probabilities shrink fast: even a model that is individually confident at every step assigns low probability to the sequence, because six numbers below one multiply. This is why likelihood is always handled in logs. Second, assigning probability to a _sequence_ is the wrong operation to reason with, since it conflates length and quality. The natural quantity is the average log probability per token.

Taking logs, with $e$ the base of natural logarithms:

$$
\frac{1}{n} \log P(x_1, \ldots, x_n) = \frac{1}{n} \sum_{t=1}^{n} \log P(x_t \mid x_{<t})
$$

For the sentence above the total log probability is $-3.808745$ nats, giving $-0.634791$ nats per token. A distribution that spreads mass evenly over $V$ tokens costs $\ln V$ nats per token, which is why a uniform model over a 50257-token vocabulary sits at $10.8249$ nats per token. The model's job is to push that number down.

## What the training loop actually optimizes

The per-token negative log probability is the training loss:

$$
L(\theta) = -\frac{1}{n} \sum_{t=1}^{n} \log P_\theta(x_t \mid x_{<t})
$$

Minimising it maximises the likelihood of the training data under the model, which is the cross-entropy objective derived in [information theory and cross-entropy](/en/blog/information-theory-and-cross-entropy). This is a supervised learning problem with the labels supplied by the text itself: the label for position $t$ is token $x_{t+1}$.

The detail that trips people up is how those labels are used. At training time the model is **not** asked what comes next after what it just predicted. It receives the true token sequence and predicts every position simultaneously, each position conditioned on the real preceding tokens rather than on the model's own output. This is **teacher forcing**, and it is what makes training tractable: the $n$ conditionals are independent given the prefix, so they all compute in one forward pass instead of $n$ sequential passes.

The mismatch is real and worth naming. At training the context is always _correct_; at generation the context is whatever the model emitted, including its own mistakes. A model that assigned even modest probability to the wrong continuation would see a context it never saw in training. Teacher forcing keeps training stable and fast, and it introduces a gap that later methods address by sampling from the model during training rather than always from the data, an approach Press and colleagues popularised in work on train-first, test-last training.

## Likelihood versus perplexity

**Perplexity** is the exponentiated average negative log likelihood, a rescaling that makes it read as a probability over an implicit set of options:

$$
\mathrm{PPL} = \exp\left(-\frac{1}{n} \sum_{t=1}^{n} \log P_\theta(x_t \mid x_{<t})\right)
$$

The interpretation is the effective number of equally likely choices the model was unsure between at each step. A perplexity of 1.0 means it was never surprised; $V$ means it performed no better than guessing uniformly.

Our worked example gives $\exp(0.634791) = 1.8866$. All of it in one place:

```python
import math

tokens = ["the", "cat", "sat", "on", "the", "mat"]

probs = {
    (): {"the": 0.40, "a": 0.25, "I": 0.20, "there": 0.15},
    ("the",): {"cat": 0.30, "dog": 0.30, "quick": 0.25, "lazy": 0.15},
    ("the", "cat"): {"sat": 0.55, "slept": 0.25, "ran": 0.20},
    ("the", "cat", "sat"): {"on": 0.70, "down": 0.30},
    ("the", "cat", "sat", "on"): {"the": 0.60, "a": 0.40},
    ("the", "cat", "sat", "on", "the"): {"mat": 0.80, "floor": 0.20},
}

chain, log_likelihood = 1.0, 0.0
for i in range(1, len(tokens) + 1):
    p = probs[tuple(tokens[: i - 1])][tokens[i - 1]]
    chain *= p
    log_likelihood += math.log(p)

n = len(tokens)
print(f"P(x)          = {chain:.6f}")            # 0.022176
print(f"log P (nats)  = {log_likelihood:.6f}")    # -3.808745
print(f"perplexity    = {math.exp(-log_likelihood / n):.4f}")   # 1.8866
```

A sharper model on the same sentence, with per-step probabilities of 0.90, 0.60, 0.85, 0.95, 0.98, 0.97, achieves $-0.146777$ nats per token and perplexity $1.1581$ — a gain of $0.488014$ nats per token for the same six tokens. The point of perplexity is that it is comparable across datasets of different sizes and lengths in a way raw likelihood is not.

Two cautions belong with it. Perplexity is dominated by frequent tokens, since they contribute most of the probability mass, which makes it a good measure of overall modelling and a poor measure of behaviour on rare facts. And perplexities from two different tokenizers are not comparable at all, because the tokenizations differ; comparing them requires normalising per byte or per character. [Evaluating language models](/en/blog/evaluating-language-models) returns to what this metric can and cannot tell you.

## Generation is repeated sampling

Training defines a distribution; inference uses it. Generation means drawing $x_{t} \sim P_\theta(\cdot \mid x_{<t})$ and appending, repeatedly. What varies is the _sampling rule_, which is not part of the likelihood at all:

- **Greedy** takes the argmax. Deterministic, and prone to repetition.
- **Temperature** rescales the logits before the softmax. Low temperature sharpens toward greedy; high flattens toward random.
- **Top-k** and **top-p** restrict sampling to the $k$ most likely tokens, or to the smallest set whose probability mass reaches $p$.

All of these are downstream of the learned distribution, and none of them are learned. A model can have a good perplexity and produce poor text under a bad sampling rule, which is why perplexity and generation quality are separate evaluation targets.

## What next-token prediction does and does not teach

This is where honest accounting is worth more than enthusiasm.

It plainly does teach the distribution of text: grammar, spelling, agreement, idiom, topic, and register, because all of these lower the average loss. Predicting the next token requires knowing which continuations are plausible, and that is what syntax largely is. This is the setting of the autoregressive language model introduced by Bengio and colleagues in 2003, decades before the transformer and still the objective the transformer trains.

It does not, by itself, install a reliable **database** of facts. The distinction is one of mechanism. Rare facts are mentioned a handful of times in any corpus, so gradient descent receives correspondingly few updates about them, and each occurrence can be memorized rather than generalised. The result is the pattern in [the KV cache lesson's neighbour](/en/blog/llm-inference-prefill-and-decode) where a model can produce a fact fluently when prompted with a fragment of it and fail to produce the same fact otherwise: recall depends on whether the training signal ever pushed the parameters to store it in a retrievable form.

It does not teach **grounding**, the property of answers being tied to verifiable sources, because the objective rewards any continuation that reduces loss, not one that is true. This is the gap [RAG](/en/blog/rag-fundamentals) exists to close.

And the composition limit is worth stating precisely. Dziri and colleagues found that transformers fail to generalise compositionally even when their pretraining data is deliberately balanced across the relevant combinations, so a model trained on many examples of `A is B` and `C is D` need not handle `A is D`. Depth of composition is the axis along which these models degrade.

None of this is a defect in the objective. It is a statement of scope. Next-token prediction is an extremely strong unsupervised signal available in unlimited quantity, and it is not the only one.

## What the objective cannot express

Two further limits are structural rather than incidental.

Training on next-token likelihood rewards assigning high probability to _typical_ continuations. It gives almost no pressure toward producing only correct ones, which is why hallucination persists and why the preference optimisation described in [preference optimisation](/en/blog/preference-optimization-rlhf-and-dpo) has to be introduced as a separate objective rather than folded into this one.

And because the loss treats all tokens as equally weighted observations, a single sequence's importance is decided by length and nothing else. Facts that are true once in a corpus are worth exactly as much, per occurrence, as the pattern that English words usually follow a determiner. There is no gradient signal that says one of these matters more than the other.

---

## References

- Vaswani et al., "Attention Is All You Need", NeurIPS 2017, arXiv:1706.03762.
- Dziri et al., "Faith and Fate: Limits of Transformers on Compositionality", EMNLP 2023.
