---
title: 'Tokenization: how text becomes model input'
description: 'Subword vocabularies, Unicode, the token-count implications of a tokenizer choice, and why tokenization is not neutral preprocessing.'
date: '2026-09-24'
author: 'John Martin'
tags:
  - language-modeling
  - ai
featured: false
cover: ../../../assets/cover-11-tokenization-text-to-model-input.svg
coverAlt: 'Abstract token blocks motif on a light background beside the lesson title'
articleId: tokenization-text-to-model-input
seriesId: language-modeling
seriesOrder: 1
contentType: theory
level: intermediate
prerequisites:
  - information-theory-and-cross-entropy
relatedArticleIds:
  - language-modeling-next-token-prediction
  - embeddings-learned-geometry
---

# Tokenization: how text becomes model input

A transformer never sees text. It sees a sequence of integers, each one an index into a fixed table of learned vectors. Something has to turn a sentence into a list like `[1412, 32901, 1438]` before any matrix is multiplied, and that something is a **tokenizer**: a fixed, invertible map from raw bytes to vocabulary ids.

The tokenizer is usually filed as uninteresting preprocessing. It is not. It sets the sequence length of every training example and every request, and sequence length governs context limits, memory, and bill. It also decides which strings are cheap to represent and which are expensive, a decision that is not neutral between languages. After this lesson you should be able to read a tokenizer's merge table, estimate how many tokens an input will cost, and explain why two models disagree about the length of the same sentence.

## Why words and characters both fail as units

The obvious unit is the word. It has one virtue and one flaw. The virtue: one token carries roughly one meaning, so capacity goes to structure rather than to reassembling letters. The flaw is the vocabulary. English has on the order of a hundred thousand distinct word forms, each needing a row in the embedding table and a column in the output projection that produces vocabulary logits, described in [embeddings](/en/blog/embeddings-learned-geometry). A word vocabulary is also **open**: anything it has not seen collapses to a single unknown token that the model cannot decompose.

Characters are the mirror image. A few hundred characters cover any script, so the vocabulary is tiny and there is never an unknown token. But sentences become ten to twenty times longer in tokens, and each token carries little meaning. This is not a rounding error. It changes the arithmetic of the whole system, because attention cost grows with the square of sequence length, as [attention from first principles](/en/blog/attention-from-first-principles) derives.

Subword units sit between the two extremes: common strings get one token, rare strings decompose into pieces that do appear. With $V$ the vocabulary size and $n$ the token count of a sequence, the design question is where to put the pressure between $V$ and $n$. Writing a sequence of tokens as $x_1, \ldots, x_n$, the decoder-only training objective sums one cross-entropy term per token:

$$
L = -\sum_{t=1}^{n} \log P_\theta(x_t \mid x_{<t})
$$

So the two knobs are coupled in the most direct way possible: a vocabulary that is 30% larger buys a 30% smaller $n$ on typical text, and the loss above is evaluated once per token of that shorter $n$. Every number in this lesson is a statement about where a given tokenizer sits on that curve.

## BPE learns merges from raw bytes

**Byte-pair encoding** (BPE) starts from the smallest possible alphabet and grows it by an explicit rule. Two design choices matter.

First, the base alphabet is the 256 byte values rather than characters. This is the **byte-level** variant, and it is why a modern tokenizer has no unknown token at all: every string on earth has a UTF-8 encoding, so every string is representable. The cost is that an unseen word no longer degrades gracefully into a single unknown symbol; it degrades into a short run of byte tokens, which is worse for the model but never fatal.

Second, training is greedy and frequency-driven. Begin with each word split into its bytes. Count every adjacent symbol pair across the corpus, weighted by word frequency, and merge the single most frequent pair. Add the merged symbol to the vocabulary. Repeat until the target size is reached. The output is an ordered list of merges, a **merge table**, and encoding is mechanical: start from bytes, repeatedly apply the lowest-numbered merge that applies, until none does.

The merge order carries the whole algorithm. Because encoding prefers the earliest-learned merge, the vocabulary encodes the statistics of its training corpus in the order those statistics were learned, and tokenization becomes deterministic.

## A worked BPE run, end to end

Here is the real mechanism in about fifty lines, with no tokenizer library, so that every number below is reproducible:

```python
import collections

CORPUS = ("the quick brown fox jumps over the lazy dog . "
          "the quick brown dog barks at the lazy fox . "
          "a quick fox is a brown fox . "
          "the fox and the dog are quick and brown . "
          "it is the best of times it is the worst of times .")


def train(corpus, n_merges):
    """Learn merges: the most frequent adjacent symbol pairs, most frequent first."""
    counts = collections.Counter(corpus.split())
    # one symbol per byte of the UTF-8 encoding; a symbol is a bytes object
    vocab = {tuple(bytes([b]) for b in w.encode("utf-8")): f for w, f in counts.items()}
    merges = []

    for _ in range(n_merges):
        pairs = collections.Counter()
        for symbols, freq in vocab.items():
            for i in range(len(symbols) - 1):
                pairs[(symbols[i], symbols[i + 1])] += freq
        if not pairs:
            break
        pair, freq = pairs.most_common(1)[0]
        if freq < 2:
            break
        a, b = pair
        merged = a + b

        rebuilt = {}
        for symbols, word_freq in vocab.items():
            out = []
            i = 0
            while i < len(symbols):
                if i < len(symbols) - 1 and symbols[i] == a and symbols[i + 1] == b:
                    out.append(merged)
                    i += 2
                else:
                    out.append(symbols[i])
                    i += 1
            key = tuple(out)
            rebuilt[key] = rebuilt.get(key, 0) + word_freq
        vocab = rebuilt
        merges.append(pair)

    return merges


def build_encoder(merges):
    """Byte tokens take ids 0..255; every learned merge takes the next id."""
    byte_id = {bytes([i]): i for i in range(256)}
    merge_of = {}
    merge_rank = {}
    next_id = 256

    for rank, (a, b) in enumerate(merges):
        merged = a + b
        merge_of[(byte_id[a], byte_id[b])] = next_id
        merge_rank[(byte_id[a], byte_id[b])] = rank
        byte_id[merged] = next_id
        next_id += 1

    def encode(text):
        """Start from bytes, repeatedly apply the highest-priority available merge."""
        ids = list(text.encode("utf-8"))
        while len(ids) > 1:
            best, at = None, -1
            for i in range(len(ids) - 1):
                rank = merge_rank.get((ids[i], ids[i + 1]))
                if rank is not None and (best is None or rank < best):
                    best, at = rank, i
            if at < 0:
                break
            ids[at:at + 2] = [merge_of[(ids[at], ids[at + 1])]]
        return ids

    return encode, next_id
```

Training on that toy corpus for twenty merges produces, in order:

| merge | pair         | becomes | learned at |
| ----- | ------------ | ------- | ---------- |
| 1     | `t` + `h`    | `th`    | step 1     |
| 2     | `th` + `e`   | `the`   | step 2     |
| 3     | `f` + `o`    | `fo`    | step 3     |
| 4     | `fo` + `x`   | `fox`   | step 4     |
| 7     | `qui` + `c`  | `quic`  | step 7     |
| 8     | `quic` + `k` | `quick` | step 8     |
| 12    | `brow` + `n` | `brown` | step 12    |
| 19    | `laz` + `y`  | `lazy`  | step 19    |

The vocabulary ends at 276 entries: 256 byte tokens plus 20 merges. Note the ladder in steps 1 to 8: the corpus contains no token `quick`, so BPE manufactures it one merge at a time, and by step 8 it holds together as a single unit.

Because this toy encoder operates on raw bytes with no pre-tokenizer, spaces are ordinary bytes that no merge ever covers, so each one costs a token. A production tokenizer folds the space into the following word instead, which is why real tokenizers are markedly cheaper on the same text.

```python
merges = train(CORPUS, 20)
encode, vocab_size = build_encoder(merges)

for text in ["the", "fox", "the fox", "the quick brown fox",
             "unbelievable antidisestablishmentarianism", "tokenization",
             "supercalifragilistic", "héllo", "日本語"]:
    print(f"{len(encode(text)):3d} tokens | {len(text.encode('utf-8')):3d} bytes | {text}")
```

Output, reproducible exactly:

```text
  1 tokens |   3 bytes | the
  1 tokens |   3 bytes | fox
  3 tokens |   7 bytes | the fox
  7 tokens |  19 bytes | the quick brown fox
 36 tokens |  41 bytes | unbelievable antidisestablishmentarianism
 12 tokens |  12 bytes | tokenization
 19 tokens |  20 bytes | supercalifragilistic
  6 tokens |   6 bytes | héllo
  9 tokens |   9 bytes | 日本語
```

Two things to read off this table. Words that occur in the corpus cost one token each, while `unbelievable antidisestablishmentarianism`, which does not, falls to 36 tokens for 41 bytes. And that is the hard floor: **no byte-level tokenizer can do worse than one token per byte**. The two strings that survive at exactly their byte count, `héllo` at 6 bytes and `日本語` at 9, show the fallback working as designed.

## Vocabulary size is a budget spent once

The parameter cost of a vocabulary is easy to state and easy to forget. The embedding table has $V \times d_{model}$ entries and the output projection another $V \times d_{model}$. For $V = 50257$ and $d_{model} = 768$, each matrix holds 38,597,376 parameters, so 77 million parameters exist only to map strings to vectors and back.

This term punishes small models hardest, and it is why a large vocabulary is not free. For a 12-layer decoder with $d_{model} = 768$ and $d_{ff} = 3072$, the arithmetic is:

| component                                | parameters  | share of model |
| ---------------------------------------- | ----------- | -------------- |
| 12 transformer blocks                    | 85,054,464  | 52.4%          |
| token embedding ($V \times d_{model}$)   | 38,597,376  | 23.8%          |
| output projection ($V \times d_{model}$) | 38,597,376  | 23.8%          |
| final layer norm                         | 1,536       | 0.0%           |
| total                                    | 162,250,752 | 100%           |

Nearly half the parameters sit in the two vocabulary-sized matrices rather than in the computation. Widen $d_{model}$ while holding $V$ fixed and that share falls, which is the trade-off explored in [embedding retrieval](/en/blog/embedding-retrieval-similarity-and-ann).

A second, subtler cost: every token produces a row of logits, and the loss is computed over all $V$ of them. Vocabulary size therefore multiplies training loss cost, not only parameter memory.

## Unicode is a byte-count problem before it is a language problem

English tokenizes cheaply and other languages do not, mostly because of arithmetic. UTF-8 encodes ASCII in one byte per character and everything else in more:

| script     | example                  | characters | UTF-8 bytes | bytes per character |
| ---------- | ------------------------ | ---------- | ----------- | ------------------- |
| English    | `tokenization`           | 12         | 12          | 1.00                |
| French     | `le renard brun rapide`  | 21         | 21          | 1.00                |
| Vietnamese | `con cáo nâu nhanh nhẹn` | 22         | 26          | 1.18                |
| Russian    | `токенизация`            | 11         | 22          | 2.00                |
| Arabic     | `ترميز`                  | 5          | 10          | 2.00                |
| Chinese    | `分词`                   | 2          | 6           | 3.00                |
| Japanese   | `トークン化`             | 5          | 15          | 3.00                |
| emoji      | `🙂🙂`                   | 2          | 8           | 4.00                |

Accented Latin barely pays a penalty, since the accents fall outside ASCII and cost two bytes each; Vietnamese at 1.18 bytes per character is close enough to English that byte fallback is not catastrophic. Chinese and Japanese at 3.00 are a different matter, and a tokenizer whose merges were learned mostly on English has few merged units to spend on those scripts, so their text falls back toward the byte floor far more often.

Two factors compound this and have nothing to do with UTF-8. **Word formation**: Turkish, Finnish, and Vietnamese build long words compositionally, so a word-level vocabulary explodes, which is the strongest argument for subword units. And **missing inter-word spaces**: Chinese and Japanese write without spaces, so a BPE implementation that assumes whitespace delimits words needs a different front end. SentencePiece, described by Kudo and Richardson at EMNLP 2018, addresses exactly this by treating input as a raw character or byte stream and representing the space as an explicit marker in the vocabulary.

The honest summary: byte-level fallback guarantees _representability_, not _efficiency_. It converts a hard failure into a quiet bill.

## Token counts set context and cost

Every quantity a serving system cares about is a function of $n$, and $n$ is a tokenizer output. A model with a 128k-token context does not read 128k characters; it reads 128k tokens, which is roughly 500k characters of English and perhaps 170k characters of Chinese. The same budget buys several times less text in one language than another.

Cost follows the same path. Inference billing is per token, so a tokenizer that splits a document into 30% more pieces charges 30% more for identical information. In training, longer sequences cost superlinearly because attention is quadratic in $n$, the derivation in [attention from first principles](/en/blog/attention-from-first-principles). Since a tokenizer is frozen for the life of a model, its cost curve cannot be renegotiated later.

This is also why a vocabulary built for one language distribution transfers badly to another. A tokenizer trained on English has no cheap units for Vietnamese diacritics, so the same content arrives as more tokens, more compute, and a representation the model saw rarely during training. If you deploy outside the tokenizer's training distribution, measure tokens per character on your own text before trusting any published figure.

## What tokenization cannot fix

Tokenization is a fixed, non-learned partition decided before the model sees anything, and several real failures follow from that.

It cannot make an unseen language efficient. Byte fallback keeps the model running while making every sentence more expensive, and no downstream training compensates for a representation the architecture was not designed around.

It cannot be changed later. The vocabulary is wired into the embedding matrix and the output projection, so adapting a tokenizer to a new domain means retraining the model, not editing a config file.

It is not aware of your domain. Whether `70531` is a postcode, a measurement, or an identifier depends on nothing the tokenizer can see, and BPE will merge it into whatever shape the training corpus suggests. Domain adaptation at the tokenizer level is a real technique and a separate project.

What it does guarantee is worth keeping: with a byte-level base vocabulary, no input can fail. Every string has an encoding, and the failure mode is expense and poor representation rather than a crash, which is a far easier failure to ship by accident.

## References

- Sennrich, Haddow and Birch, "Neural Machine Translation of Rare Words with Subword Units", ACL 2016.
- Kudo and Richardson, "SentencePiece: A simple and language independent subword tokenizer and detokenizer for Neural Text Processing", EMNLP 2018 demonstrations.
- HuggingFace, "Tokenization algorithms", Transformers documentation.
