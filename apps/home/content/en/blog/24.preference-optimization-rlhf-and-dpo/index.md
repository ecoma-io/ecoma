---
title: 'Preference optimization: RLHF, reward models, and DPO'
description: 'Compare SFT, reward-model RLHF and DPO on the objective each one actually optimizes, and what none of them can express.'
date: '2026-10-07'
author: 'John Martin'
tags:
  - inference
  - ai
featured: false
cover: ../../../assets/cover-24-preference-optimization-rlhf-and-dpo.svg
coverAlt: 'Abstract preference branch motif on a light background beside the lesson title'
articleId: preference-optimization-rlhf-and-dpo
seriesId: inference
seriesOrder: 5
contentType: research-review
level: advanced
prerequisites:
  - supervised-fine-tuning-instructions
  - loss-functions-what-models-minimize
relatedArticleIds:
  - evaluating-language-models
  - reproducible-llm-experiments
---

# Preference optimization: RLHF, reward models, and DPO

Human feedback arrives as comparisons, not as targets: this answer is better than
that one. That shape of supervision is what this lesson is about, and the awkward
part is that comparing two answers requires choosing between them on every axis at
once — helpfulness, correctness, style, safety — with no way to say which axis
mattered. Three methods have become standard ways to consume that signal, and
they differ less in what they produce than in what they assume. After this lesson
you should be able to state what objective each of SFT, reward-model RLHF and DPO
actually optimizes, derive the DPO loss from the RLHF one, and predict the failure
mode of each from its assumptions.

The three-stage pipeline in Ouyang et al. 2022
([arXiv:2203.02155](https://arxiv.org/abs/2203.02155), "Training language models
to follow instructions with human feedback") is the reference point for the first
two; Rafailov et al. 2023
([arXiv:2305.18290](https://arxiv.org/abs/2305.18290), "Direct Preference
Optimization: Your Language Model is Secretly a Reward Model") collapses it to one.

## Stage one: supervised fine-tuning on demonstrations

The first stage is ordinary [SFT](/en/blog/supervised-fine-tuning-instructions):
collect prompts, have annotators write good responses, train next-token
cross-entropy on them. This produces the **policy** $\pi_\theta$ — and, as a
byproduct that matters enormously later, a frozen copy $\pi_{\text{ref}}$ of the
policy before any preference training. That reference checkpoint is not
incidental; both RLHF and DPO use it as the thing the new model is measured
against, and in DPO it is what makes the objective have a closed form.

SFT alone leaves a specific gap. Because each prompt has exactly one target, it
cannot express "this answer is right but terse; that one is right and clearer."
The annotator's single choice encodes an arbitrary point in a continuum, and
nothing in the objective rewards moving toward the better end of it.

## Stage two: a reward model over pairs

The second stage trains a separate model $r_\phi(x, y)$ to predict which of two
responses a human preferred. The training signal is again a classification
problem, but over preferences:

$$
\mathcal{L}_{RM} = -\mathbb{E}_{(x, y_w, y_l)} \left[ \log \sigma \left( r_\phi(x, y_w) - r_\phi(x, y_l) \right) \right]
$$

where $y_w$ is the chosen response and $y_l$ the rejected one. This is a
well-behaved supervised problem: no generation, no sampling, no instability. It is
also where the _judgment_ enters the system permanently, because $r_\phi$ is a
function of a finite number of human comparisons, and everything downstream
inherits its blind spots.

Note what the reward model is and is not. It is not a value function and not an
outcome predictor. It is a learned ranking of model outputs for prompts similar to
the ones it saw, which is a much narrower competence than its scalar output
suggests.

## Stage three: optimizing against the reward

The policy is then improved by reinforcement learning against $r_\phi$, with the
usual danger of a model that finds reward rather than quality. The fix is a KL
penalty keeping $\pi_\theta$ near $\pi_{\text{ref}}$, which gives the
InstructGPT objective:

$$
\max_{\pi_\theta} \ \mathbb{E}_{x, y \sim \pi_\theta} \left[ r_\phi(x, y) \right] - \beta \, \mathrm{KL}\left( \pi_\theta(\cdot \mid x) \,\|\, \pi_{\text{ref}}(\cdot \mid x) \right)
$$

This is PPO in practice, with a value model and a clipped surrogate objective on
top. Four systems now have to run in concert: the policy generating rollouts, the
reward model scoring them, the reference model providing the KL term, and the
value model estimating advantages. It works, and it produced the InstructGPT
results, and it is expensive to get right — the failures are silent, and the
hyperparameters (reward scale, KL coefficient, rollout batch size, number of
inner epochs per batch) interact in ways that are hard to reason about and easy to
get subtly wrong.

## DPO: the reward model is already in there

DPO's argument is that the RL objective above can be solved for the optimal policy
in closed form, and that the optimal policy is a simple reweighting of the
reference:

$$
\pi^*(y \mid x) = \frac{1}{Z(x)} \, \pi_{\text{ref}}(y \mid x) \, \exp\!\left( \frac{r_\phi(x, y)}{\beta} \right)
$$

Substituting that back into the KL penalty and rearranging puts $r_\phi$ in terms of
the two policies alone, which means an objective expressible directly as a loss on
the policy — no rollouts, no value model, no explicit reward model:

$$
z = \beta \left[ \log \frac{\pi_\theta(y_w \mid x)}{\pi_{\text{ref}}(y_w \mid x)} - \log \frac{\pi_\theta(y_l \mid x)}{\pi_{\text{ref}}(y_l \mid x)} \right]
$$

$$
\mathcal{L}_{DPO} = -\mathbb{E}_{(x, y_w, y_l)} \left[ \log \sigma(z) \right]
$$

This is the engineering statement of the method, and it is the part worth
remembering: **each preference pair is a binary classification example, and the
classifier's logit is the policy's preference margin, scaled by $\beta$.** RL
becomes logistic regression. The quantity that matters is not the absolute
log-probability of either response — which drifts as training proceeds and which
SFT cannot stabilize — but the _difference_ in how far the policy has moved each
one away from where the reference put it. Two responses that both became less
likely, but with the chosen one less likely by a smaller amount, have satisfied
the preference.

Here is the loss on four pairs, with all four log-probabilities given rather than
sampled from a model:

```python
"""The DPO loss on a single preference pair, evaluated at several temperatures.

log pi(y|x) is the log-probability the policy assigns to a completion, and
log pi_ref(y|x) is the same quantity under a frozen reference model (the SFT
checkpoint). Both are sums of per-token log-probabilities.
"""

import math

BETA = 0.1

# (label, policy chosen, ref chosen, policy rejected, ref rejected)
PAIRS = [
    ("chosen +2.0, rejected +0.5", -12.0, -14.0, -18.0, -18.5),
    ("chosen +5.0, rejected -1.0", -20.0, -25.0, -30.0, -29.0),
    ("chosen +1.0, rejected -0.5", -8.0, -9.0, -15.0, -14.5),
    ("chosen +0.5, rejected +2.0", -14.0, -14.5, -18.0, -20.0),
]


def dpo_term(policy_chosen, policy_rejected, ref_chosen, ref_rejected, beta):
    chosen_margin = policy_chosen - ref_chosen
    rejected_margin = policy_rejected - ref_rejected
    return beta * (chosen_margin - rejected_margin)


def dpo_loss(z):
    return -math.log(1.0 / (1.0 + math.exp(-z)))


def main():
    for label, policy_chosen, ref_chosen, policy_rejected, ref_rejected in PAIRS:
        z = dpo_term(policy_chosen, policy_rejected, ref_chosen, ref_rejected, BETA)
        implied = 1.0 / (1.0 + math.exp(-z))
        print(
            f"  {label:32s} z {z:+.3f}  loss {dpo_loss(z):.4f}"
            f"  implied preference {implied:.3f}"
        )

    print("\nbeta, holding the chosen margin 0.5 nats above the rejected one")
    for beta in (0.01, 0.05, 0.1, 0.5, 1.0):
        z = beta * 0.5
        print(f"  beta {beta:5.2f}: z {z:+.3f}  loss {dpo_loss(z):.4f}")

    print("\ngradient magnitude -sigmoid(-z) as z goes negative")
    for z in (2.0, 0.0, -2.0, -6.0):
        gradient = -(1.0 / (1.0 + math.exp(z)))
        print(f"  z {z:+5.1f}: loss {dpo_loss(z):7.4f}  grad {gradient:.4f}")


if __name__ == "__main__":
    main()
```

```text
chosen +2.0, rejected +0.5       z +0.150  loss 0.6210  implied preference 0.537
  chosen +5.0, rejected -1.0       z +0.600  loss 0.4375  implied preference 0.646
  chosen +1.0, rejected -0.5       z +0.150  loss 0.6210  implied preference 0.537
  chosen +0.5, rejected +2.0       z -0.150  loss 0.7710  implied preference 0.463

beta, holding the chosen margin 0.5 nats above the rejected one
  beta  0.01: z +0.005  loss 0.6907
  beta  0.05: z +0.025  loss 0.6807
  beta  0.10: z +0.050  loss 0.6685
  beta  0.50: z +0.250  loss 0.5759
  beta  1.00: z +0.500  loss 0.4741

gradient magnitude -sigmoid(-z) as z goes negative
  z  +2.0: loss  0.1269  grad -0.1192
  z  +0.0: loss  0.6931  grad -0.5000
  z  -2.0: loss  2.1269  grad -0.8808
  z  -6.0: loss  6.0025  grad -0.9975
```

The last pair is the case SFT cannot represent at all: the policy made both
responses more likely, but it made the _rejected_ one more likely, and DPO's
gradient pushes against that. The first pair is the subtle one — the policy
improved the chosen response substantially, and the loss barely moves, because the
rejected response improved nearly as much.

$\beta$ sets the scale the margins are measured on. Small $\beta$ is permissive:
the same preference gap produces a small logit and a small gradient, so the policy
moves slowly and stays near the reference. Large $\beta$ demands a bigger margin
for the same pair and pushes harder, at the cost of moving further from the SFT
checkpoint. It is the knob that trades fidelity to the reference against strength
of preference, and it interacts with the $\beta$ in the RLHF objective — they are
the same parameter, carrying the same meaning.

One asymmetry in the objective is worth naming. When $z$ is large the gradient
vanishes ($-0.119$ at $z = 2$), so pairs the policy already satisfies stop
contributing. When $z$ is very negative the gradient approaches $-1$ and does not
vanish, so pairs the policy actively dislikes pull hardest. Training is
self-limiting in the good case and unsaturating in the bad one. A run that gets
the easy pairs right stops pushing on them, but a run that keeps getting some
pair backwards keeps receiving nearly full-size gradient on it indefinitely.

## What each stage is actually optimizing

|                            | SFT                          | RLHF                                 | DPO                                      |
| -------------------------- | ---------------------------- | ------------------------------------ | ---------------------------------------- |
| Signal                     | one good response per prompt | scalar reward on sampled responses   | which of two responses a human preferred |
| Reference model            | not used                     | KL penalty toward it                 | subtracted inside the loss               |
| Reward model               | none                         | trained, then optimized against      | implicit, folded into the ratios         |
| Sampling at train time     | none                         | rollouts from the current policy     | none                                     |
| Extra models at train time | none                         | reward model, value model, reference | reference                                |
| Objective                  | match the demonstration      | raise reward, stay near reference    | separate chosen from rejected            |

The rows that decide adoption are the last two: three models become one, and the
training loop becomes a supervised one. That is a large operational win, and it is
the reason DPO has spread quickly from its 2023 paper into serving stacks. The
case against it
is that the closed form is exact only under assumptions that do not hold in full —
most importantly, that the preference data came from the reference policy's own
distribution, and that the target behaviour is representable by reweighting it.

## Reward hacking, and the two ways each method fails

The failure mode the RLHF objective is built around is **reward
overoptimization**: the policy finds outputs that score highly on $r_\phi$ without
being better, because $r_\phi$ is a proxy fitted to finite data and the policy is
now searching the space of things that proxy likes. The KL penalty is the
constraint that prevents it, and its strength is $\beta$. Too small a $\beta$ and
the model optimizes reward until human raters say it got worse; too large and it
barely moves. This is an empirical tension with no closed-form resolution, and the
InstructGPT paper reports exactly this pattern: reward scores keep climbing past a
point where human preference evaluations fall.

DPO has the same underlying exposure in a different shape. It has no reward model
to hack explicitly, but its objective is derived by _substituting_ a reward model
into the RL solution — and the derivation assumes there is one. So DPO optimizes an
implicit reward $r_{\text{implicit}}(x, y) = \beta \log \frac{\pi_\theta(y \mid x)}{\pi_{\text{ref}}(y \mid x)}$
whose quality is bounded by the preference data, and pushing the policy hard
enough on it produces the same pathology. Reported DPO failure modes include
reducing the likelihood of both responses while preserving the margin, and
degrading outputs that were outside the preference set's coverage.

Both of these are properties of the data, not of the algorithm, so choosing a
better optimizer does not address either:

- **The bias is inherited, not removed.** Every method here consumes the same
  kind of artifact: a finite set of comparisons between model outputs. The reward
  model adds a layer rather than removing one — trained on the same comparisons,
  so the same biases, plus whatever it extrapolates wrongly when asked to score an
  output nobody compared. Constitutional AI (Bai et al., 2022) attacks this by
  generating the feedback from a written set of principles rather than from
  people, which changes who is in the loop without removing the loop.
- **Offline is offline.** DPO never samples from the current policy during
  training, so it cannot discover what the model does when it is wrong about
  something the data never covers. Iterative or online preference methods address
  this by collecting fresh comparisons each round, at the cost of the operational
  simplicity that made DPO attractive. Whether the extra machinery earns its keep is
  an open empirical question, not a settled one.

## What none of this buys

The strongest honest claim available for any of these methods is that they change
_behavior_ — the distribution over outputs given a prompt. None of them reliably
installs new factual knowledge; that remains the job of continued pretraining, and
the
[retrieval-augmented generation](/en/blog/rag-fundamentals) route exists precisely
because putting the fact in the context is more reliable than putting it in the
weights. None of them can express a constraint with no gradient — "never mention
X" is not a preference between two outputs, and the closest available
approximation is heavy filtering of the preference data.

And the ceiling is the annotations. Every method here consumes a few thousand to a
few hundred thousand human comparisons, which is far too small a sample of the
space of behaviors to pin down what is good; what it _can_ do is move the policy a
measurable distance in the directions that data covers and nowhere else. Measuring
whether that distance is real, on data the tuning never saw, is the subject of
[evaluation](/en/blog/evaluating-language-models) and of
[reproducible experiments](/en/blog/reproducible-llm-experiments).

## References

- Long Ouyang, Jeffrey Wu, Xu Jiang, Diogo Almeida, Carroll L. Wainwright,
  Pamela Mishkin, Chong Zhang, Sandhini Agarwal, Katarina Slama, Alex Ray, John
  Schulman, Jacob Hilton, Fraser Kelton, Luke Miller, Maddie Simens, Amanda Askell,
  Peter Welinder, Paul Christiano, Jan Leike and Ryan Lowe, "Training language
  models to follow instructions with human feedback", NeurIPS 2022,
  arXiv:2203.02155 — the PPO reward-model pipeline and its reward
  overoptimization failure mode.
- Rafael Rafailov, Archit Sharma, Eric Mitchell, Steven H. Manning, Xiaojin Li,
  Kenneth A. Finn and Chelsea Finn, "Direct Preference Optimization: Your
  Language Model is Secretly a Reward Model", NeurIPS 2023, arXiv:2305.18290 —
  the closed-form optimal policy and the implicit-reward objective derived above.
