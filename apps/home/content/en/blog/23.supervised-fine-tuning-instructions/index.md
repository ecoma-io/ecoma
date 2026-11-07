---
title: 'Supervised fine-tuning: teaching a pretrained model to follow instructions'
description: 'Data formatting, the training objective, what differs from pretraining, quality control, and the limits of instruction tuning.'
date: '2026-10-06'
author: 'John Martin'
tags:
  - inference
  - ai
featured: false
cover: ../../../assets/cover-23-supervised-fine-tuning-instructions.svg
coverAlt: 'Abstract instruction transform motif on a light background beside the lesson title'
articleId: supervised-fine-tuning-instructions
seriesId: inference
seriesOrder: 4
contentType: research-review
level: intermediate
prerequisites:
  - training-a-transformer
  - loss-functions-what-models-minimize
relatedArticleIds:
  - preference-optimization-rlhf-and-dpo
  - quantization-precision-and-efficiency
---

# Supervised fine-tuning: teaching a pretrained model to follow instructions

A pretrained language model is an excellent next-token predictor and a poor
assistant. It continues text the way the training corpus would have continued it,
which for a bare model means it will happily complete your question rather than
answer it, and it has no way to represent "here is the response" as a distinct
act. Supervised fine-tuning (SFT) is the intervention: continue ordinary
next-token training on examples where the correct continuation is a helpful
answer. After this lesson you should be able to format an instruction dataset so
the loss lands on the right tokens, explain what actually differs from pretraining,
judge whether a dataset is good enough before spending GPU-hours on it, and
articulate what SFT structurally cannot fix.

The objective is not new. It is exactly the cross-entropy from
[loss functions](/en/blog/loss-functions-what-models-minimize), minimized over the
same parameters $\theta$ by the same optimizer as
[pretraining](/en/blog/training-a-transformer), on the same objective — and that
shared objective is precisely the limit of what the method can do. Understanding
where the data changed and where it did not is the whole lesson.

## The data format is a design decision

An instruction example is a prompt, a response, and a template that combines them.
The template is not cosmetic: it is how the model learns that a particular
sequence of tokens means "a user turn is happening" rather than "more text". Two
requirements follow, and they are different requirements.

**The model must be able to _detect_ a turn boundary during inference.** Whatever
marker you train on has to be generated or recognized at serving time, and the
model must stop at it. This is what makes format tokens part of the tokenizer
vocabulary — the turn markers `<|im_start|>` and `<|end|>` in the example
below are learned embeddings, not text.

**The template must be identical between training and serving.** A model trained
on `<|im_start|>user ... <|im_start|>assistant` and served with plain Markdown
headers is being run outside its training distribution. This is the single most
common SFT deployment bug and it produces output that looks merely worse rather
than visibly broken, which makes it hard to diagnose from samples alone.

Here is a complete example as a model would see it, with the labels that decide
which tokens contribute to the loss:

```text
<|im_start|>system
You are a.<|end|><|im_start|>user
Summarize this:<|end|><|im_start|>assistant
A short summary.<|end|>
```

Two variants of this are common and behave differently. **Completion-only**
training puts the loss on the response alone. **Full-sequence** training puts it
on prompt and response both, which teaches the model to _write_ prompts as well as
answer them and is what most public instruction mixtures do. Neither is wrong, but
the choice must be deliberate, and it interacts with the base model: a base model
has no turn vocabulary at all, so full-sequence training is doing more work than it
looks.

## Masking the prompt out of the loss

Autoregressive training predicts token $t+1$ from tokens up to $t$, so a loss on
the response naturally supervises exactly the response: predicting the assistant's
first word is conditioned on the prompt, and that prediction is the first thing to
optimize. But if the loss is computed over the whole sequence, the prompt tokens
contribute too, and the model is trained to predict the user's own instruction.

Standard practice is to **mask the prompt tokens from the loss** with a sentinel
value that the loss function skips — `-100` in PyTorch's
`CrossEntropyLoss`, whose `ignore_index` defaults to `-100`. With a mask $m_t \in \{0, 1\}$
that is 1 on supervised positions, the loss is the masked mean

$$
\mathcal{L}_{SFT} = - \frac{1}{\sum_{t=1}^{n} m_t} \sum_{t=1}^{n} m_t \log p_\theta(y_t \mid y_{<t})
$$

and the worked example below is the full-sequence variant, with every prompt
token masked off: 21 tokens, 15 masked, 6 supervised.

```text
tokens  <|start|>   system      You are a   .           </s>        <|start|>   user
mask    .           .           .           .           .           .           .
labels  -100        -100        -100        -100        -100        -100        -100

tokens  Summar      ize          this       :           </s>        <|start|>   assistant
mask    .           .           .           .           .           .           .
labels  -100        -100        -100        -100        -100        -100        -100

tokens  </s>        A            short       summ       ary         .           </s>
mask    .           #           #           #           #           #           #
labels  -100        A            short       summ       ary         .           </s>
```

The `.` / `#` row is not part of the training data; it makes the boundary
visible. Here is the same split as arithmetic, on a toy forward pass:

```python
"""Loss masking in supervised fine-tuning, with the arithmetic worked out."""

import math

# A chat-formatted training example. Tokens are shown as the strings a subword
# tokenizer would emit; the exact split does not matter.
PROMPT = [
    "<|im_start|>", "system", "You are a", ".", "</s>",
    "<|im_start|>", "user", "Summar", "ize", " this", ":", "</s>",
    "<|im_start|>", "assistant", "</s>",
]
TARGET = ["A", " short", " summ", "ary", ".", "</s>"]

tokens = PROMPT + TARGET
# The prompt is given, not predicted, so it contributes no loss.
labels = [-100] * len(PROMPT) + TARGET

# Stand-in for a forward pass: the probability the model assigns to each next
# token, as read off the softmax.
NEXT_TOKEN_PROBABILITY = [
    0.99, 0.98, 0.97, 0.99, 0.98, 0.99, 0.99, 0.99, 0.95, 0.82, 0.62, 0.99,
    0.99, 0.97, 0.93,
    0.55, 0.38, 0.21, 0.07, 0.88, 0.31,
]


def main():
    supervised = [
        -math.log(p)
        for label, p in zip(labels, NEXT_TOKEN_PROBABILITY)
        if label != -100
    ]
    total = len(tokens)
    assert len(NEXT_TOKEN_PROBABILITY) == total, "one probability per token"
    print(f"{total} tokens, {len(PROMPT)} masked, {len(supervised)} supervised\n")
    for index, (token, label, p) in enumerate(zip(tokens, labels, NEXT_TOKEN_PROBABILITY)):
        detail = "masked" if label == -100 else f"nll {-math.log(p):.3f}"
        print(f"  {index:2d} {token!r:16s} p={p:.2f}  {detail}")
    print()
    print(f"mean over supervised tokens: {sum(supervised) / len(supervised):.4f}")
    print(f"mean over all tokens:        {sum(supervised) / total:.4f}")


if __name__ == "__main__":
    main()
```

The masking is not cosmetic. On this example the mean over supervised tokens is
1.1807; the same sum divided by all 21 tokens is 0.3373, a factor of 3.5. That
factor is the effective learning rate on the response. Two consequences follow,
both of which are felt in practice: masking is what keeps the gradient focused on
the behaviour you are training, and it is why "mask the prompt" must be true for
every example in the dataset, not most of them — a stray unmasked prompt skews the
per-token weighting of that batch.

## What actually differs from pretraining

The objective, the model, and the optimizer are the same. Four things change, and
each is a deliberate departure from
[the pretraining recipe](/en/blog/training-a-transformer):

|               | Pretraining                       | SFT                           |
| ------------- | --------------------------------- | ----------------------------- |
| Data          | trillions of tokens, raw web text | 10^3 to 10^6 curated examples |
| Learning rate | 10^-4 order                       | 10^-5 to 10^-6 order          |
| Epochs        | effectively 1 pass                | 2–3                           |
| Objective     | next token, everywhere            | next token, on responses only |

**Learning rate** is the sharpest difference. Pretraining uses a high rate because
the objective is far from converged and the run is short relative to the model's
life. SFT uses a rate 10 to 100 times lower, because the model is already good at
the objective — the loss starts low — and a high rate would move it far past the
narrow optimum and damage capabilities that were expensive to acquire. That is the
central risk of SFT and it is why the rate is not a tuning detail but a safety
constraint.

**Epochs** follow from the same reasoning plus data volume. Repeating a million
examples three times is 3000 effective steps; the model has enough capacity to
memorize them, and memorized answers to a narrow set of prompts are a real
failure mode rather than a theoretical one.

The size of the curated set is what makes this a different regime from
pretraining, and the instruction-tuning literature reads it that way: Wei et
al. 2021
([arXiv:2109.01652](https://arxiv.org/abs/2109.01652)) reach zero-shot ability
across a spread of tasks by fine-tuning on a few thousand instructions per task
rather than by scaling pretraining data.

**Data quality** dominates everything else, because there is so little of it. A
million examples are a rounding error in pretraining terms and the entire signal
in SFT terms. This is why SFT datasets are curated by construction: generated by a
stronger model, filtered, human-reviewed, and often a mixture of several sources
with different styles.

## Quality control, before the GPU-hours

A dataset is a build artifact and deserves the same pipeline discipline as code.
Concretely:

- **Deduplicate.** Near-duplicate examples teach the model to answer one question
  in one way and crowd out diversity. The methods developed for pretraining corpora
  (Lee et al. 2022, arXiv:2107.06499, ACL 2022; Kandpal et al. 2022) transfer
  directly; see
  [data curation](/en/blog/data-curation-quality-and-contamination).
- **Prefer verifiable responses.** Wei et al. 2021 kept only task outputs a
  program could check, which is the cheapest form of the filtering described
  below and the reason their mixture needed no human pass over every example.
- **Check for contamination.** Instruction datasets scraped from the web can
  contain benchmark questions with their answers, and a tuned model then scores
  well for reasons that will not reproduce in production.
- **Verify correctness by construction where possible.** For tasks with a checkable
  answer — code that compiles and passes tests, arithmetic, structured output that
  must match a schema — run the check on the response and discard failures. This
  converts a subjective quality question into a filter.
- **Sample and human-review.** Not everything is automatable. A human read of a
  few hundred examples across the mixture's categories catches the failure that
  filters miss: responses that are correct and useless, or fluent and subtly
  wrong.
- **Watch the mixture, not the average.** Datasets are mixtures, and a category
  comprising 60% of the data will dominate the model's behaviour regardless of how
  few examples in it you had to look at.

## What SFT structurally cannot do

**It imitates, it does not teach.** SFT is next-token cross-entropy on curated
examples. Its ceiling is the quality and coverage of those examples. If no example
demonstrates a capability, no amount of SFT will install it — the model learns the
_form_ of helpful responses and the conventions of the mixture, not the underlying
skill. This is why "SFT teaches the model to follow instructions" is a statement
about the instruction-following format, and why the model often does the format
faithfully over content it does not have.

**It can overfit, and the symptom is style collapse.** A few thousand examples,
three epochs, is enough for a model to converge to a narrow voice — one tone, one
length, one structure — that scores well on the training set and worse on
everything else. Held-out evaluation on examples from a different distribution is
the only defense, which is the same argument as
[generalization](/en/blog/supervised-learning-and-generalization).

**It amplifies what is in the data.** Whatever bias the responses carry — in
length, register, cultural assumptions, what counts as a good answer — is
memorized directly, because there is no other signal competing with it. SFT has no
notion of "this is the wrong answer"; it only has "here is the answer we want".

**It cannot express preferences between outputs.** The loss has room for exactly
one target per prompt. The signal that a longer, more careful answer is _better
than_ a shorter correct one cannot be expressed in a dataset of single targets,
because there is nowhere to put it. That is not a limitation of the data format
but of the objective, and it is what
[preference optimization](/en/blog/preference-optimization-rlhf-and-dpo) exists
to address — with its own costs, and without escaping the limits of the judgments
it is trained on. Ouyang et al. 2022
([arXiv:2203.02155](https://arxiv.org/abs/2203.02155)) added exactly that stage
to SFT for InstructGPT, and the comparison is continued in
[preference optimization](/en/blog/preference-optimization-rlhf-and-dpo).

## References

- Jason Wei, Maarten Bosma, Vincent Y. Zhao, Kelvin Guu, Adams Wei Yu, Brian Lester,
  Nan Du, Andrew M. Dai and Quoc V. Le, "Finetuned Language Models Are
  Zero-Shot Learners", ICLR 2022, arXiv:2109.01652 — the instruction-tuning
  mixture, and the origin of the pattern-matched task formatting described
  above.
- Long Ouyang, Jeffrey Wu, Xu Jiang, Diogo Almeida, Carroll L. Wainwright,
  Pamela Mishkin, Chong Zhang, Sandhini Agarwal, Katarina Slama, Alex Ray, John
  Schulman, Jacob Hilton, Fraser Kelton, Luke Miller, Maddie Simens, Amanda Askell,
  Peter Welinder, Paul Christiano, Jan Leike and Ryan Lowe, "Training language
  models to follow instructions with human feedback", NeurIPS 2022,
  arXiv:2203.02155 — the InstructGPT pipeline this lesson's SFT stage is the
  first stage of.
- Katherine Lee, Daphne Ippolito, Andrew Nystrom, Chiyuan Zhang, Douglas Eck,
  Chris Callison-Burch and Nicholas Carlini, "Deduplicating Training Data Makes
  Language Models Better", ACL 2022, arXiv:2107.06499 — the deduplication
  threshold this lesson recommends for instruction datasets.
