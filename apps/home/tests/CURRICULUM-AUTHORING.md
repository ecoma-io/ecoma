# Authoring guide — Ecoma AI/ML/LLM curriculum

You are writing **one lesson** of a 30-lesson technical curriculum that lives at
`apps/home/content/en/blog/NN.<slug>/index.md`. Read this whole file before
writing.

This is a serious technical resource for software engineers who want to
understand the mechanisms behind modern models. It is not a marketing blog,
not a news digest, and not a list of tips.

## What you are editing

A scaffolded file. **Do not touch the frontmatter.** It is generated from
`apps/home/tests/curriculum-contract.ts`, which is the contract the test suite
asserts against (`seriesId`, `seriesOrder`, `date`, `cover`, `articleId`,
`prerequisites`, `relatedArticleIds`, `tags`, `author`, `featured`). If you
change it, tests go red for reasons that have nothing to do with your prose.

Replace **only the body**, i.e. everything from the `# Heading` line to the end
of file. Leave the H1 exactly as it is (the test asserts an H1 exists, and the
page must not render a second one). Remove the
`<!-- TODO(lesson): ... -->` marker when you are done.

## Length and shape

- **1200–2500 words** for most lessons. A focused lesson may be shorter if it
  genuinely covers its topic. Padding is a defect — a 2500-word lesson where
  900 words say something is worse than a tight 1400-word one.
- Start with the **problem and what the reader will be able to do afterwards**,
  in prose. Not "Introduction". Not "Overview".
- `##` headings must say what that section actually contains. Thirty lessons
  that all have "Background / Details / Summary" read as one article repeated.
- End with the real limits of the method — what it cannot do, when it fails,
  what is still open. A conclusion that restates the title is wasted space.

## Mathematics

Math is rendered by KaTeX at build time via `remark-math` + `rehype-katex`.
Two forms:

- inline: `$O(\sqrt{d_k})$`
- display: `$$` on its own lines, with the formula between them.

Write real derivations. Define every symbol **before** you rely on it. Do not
paste a formula with no explanation of where the terms come from.

**Verify your math numerically.** For any worked numerical example, actually
compute the answer (a shell one-liner, Python, node — whatever is available)
and use the computed value. A worked example with a wrong number teaches the
reader something false. This is the single most common way a lesson like this
goes wrong.

## Code

- Fence with a language tag so highlighting works: ` ```python `.
- Code must be **internally consistent**: variables defined before use, imports
  present, no undefined helpers.
- If you present something as runnable, it must actually run. Test it.
- If it is pseudocode or a sketch, say so in the surrounding prose. Never label
  pseudocode as executable.
- No new dependencies. Prefer `numpy` for math demonstrations.

## Citations — this matters

**Never fabricate** a paper, author, venue, date, arXiv id, DOI, benchmark
number, or quotation. A plausible-looking fake citation is worse than no
citation: a reader who follows it lands on unrelated physics.

- **Only cite sources you can state from memory with confidence.** Canonical
  works whose existence and gist you know well include: Vaswani et al. 2017
  "Attention Is All You Need"; Kaplan et al. 2020 "Scaling Laws for Neural
  Language Models"; Hoffmann et al. 2022 "Training Compute-Optimal Large
  Language Models"; Ouyang et al. 2022 "Training language models to follow
  instructions with human feedback"; Rafailov et al. 2023 "Direct Preference
  Optimization"; Lewis et al. 2020 "Retrieval-Augmented Generation for
  Knowledge-Intensive NLP Tasks"; Radford et al. 2018 GPT; Sutskever et al.
  2012; Mikolov et al. 2013 word2vec; Bengio et al. 2003; Cho et al. 2015;
  Ho et al. 2020 GPT-3; Shoeybi et al. 2020 Megatron-LM; Narayanan et al.
  2021; Rajbhandari et al. 2019 ZeRO; Huang et al. 2019 GPipe; Dai et al. 2021
  DeepSpeed; Kwon et al. 2023 vLLM; Li et al. 2023 SGLang; Dettmers et al. 2023
  LLM.int8(); Frantar et al. 2024 GPTQ; Johnson et al. 2017 "Billion-scale
  semantic search"; Karpukhin et al. 2020 dense passage retrieval; Robertson
  et al. on BM25/TREC; Malkov & Yashunin 2016 HNSW; Devlin et al. 2019 BERT;
  Liu et al. 2020 RoBERTa; Srivastava et al. 2014 dropout; Ioffe & Szegedy 2015
  BatchNorm; He et al. 2015/2016; Kingma & Ba 2015 Adam; Loshchilov & Hutter
  2019 AdamW; Hinton et al. 2015 RMSProp; Reddi et al. large-batch training;
  Kudo & Richardson 2018 SentencePiece; Sennrich et al. 2015 subword NMT;
  Lee et al. 2019 and Kandpal et al. 2022 on deduplication; Xie et al. on data
  contamination; Cohen et al. 2021 and others on statistical significance;
  Bowman et al. 2018 GLUE; Wang et al. 2019 SuperGLUE; Hendrycks et al. 2021
  MMLU; Manakul et al. 2023 SelfCheckGPT; Liu et al. 2023/2024 G-Eval; Es et
  al. 2023 RAGAS; Thakur et al. 2021 BEIR; Cameron et al. / Redd et al. on
  semantic uncertainty; Ethayarajh et al. 2019 on embedding intrinsic
  dimensionality; Reimers & Gurevych 2019 sentence embeddings; Luo et al.
  2019 on neural ranking; Nayak et al. on BM25 and dense hybrids; Bruch et al.
  2023 "An Analysis of In-Context Learning"; Olsson et al. 2022 on
  in-context learning; Wei et al. 2022 emergent abilities (and the critiques
  of that framing).
- **Never attach a URL you are not certain of.** Writing a paper title from
  memory is fine; guessing an arXiv identifier is not. A hallucinated arXiv id
  does not 404 politely — it resolves to a real paper on an unrelated subject,
  and a reader who follows it concludes the citation was fake. This has already
  happened while preparing this curriculum: several plausible-sounding
  identifiers that were checked turned out to be papers about neutrino spectra
  and jet physics.
  If you are unsure of an arXiv id, write the author's name, year and title in
  prose, and put the work in `## References` under its title and venue without a
  URL, or with a URL you actually verified. Flag it in your final report so a
  human can check it.

## Notation — follow it exactly

These symbols are used consistently across all 30 lessons. Do not invent a
second name for the same quantity.

| Symbol       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `n`          | number of samples, or tokens in a sequence                            |
| `d`          | dimension of a vector                                                 |
| `d_k`, `d_v` | key / value dimension in attention                                    |
| `d_model`    | model (hidden) dimension                                              |
| `d_ff`       | feed-forward inner dimension                                          |
| `h`          | number of attention heads (NOT hidden size)                           |
| `H`          | total heads across layers, when KV-cache sizing needs it              |
| `V`          | vocabulary size (uppercase, never the value vector)                   |
| `L`          | number of layers, or the loss function — disambiguate in prose        |
| `S`          | sequence length (current context)                                     |
| `b`          | batch index                                                           |
| `t`          | time / position index in a sequence                                   |
| `j`, `i`     | generic tensor indices                                                |
| `p`, `q`     | distributions; `\hat{p}` an estimate; `y` label, `\hat{y}` prediction |
| `\theta`     | parameters; `\nabla_\theta L` gradient; `\eta` learning rate          |
| `\lambda`    | regularization / weight-decay coefficient                             |

- Matrices uppercase (`X`, `W`, `Q`, `K`, `V`), vectors lowercase bold
  (`\mathbf{x}`, `\mathbf{q}`). A matrix of size `m × n` is **rows × columns**,
  always stated that way.
- Use `$...$` for symbols inside prose. Use `\mathbf{x}` for vectors.
- **token** ≠ word. Do not call a token a word.
- Use `e` as the base of natural logarithms in information-theoretic context.

## Structural requirements the tests enforce

These are hard requirements, not style suggestions:

1. The file must contain at least one `##` heading (the content contract
   requires headings, and TOC generation depends on them).
2. Somewhere in the file there must be at least one Markdown table (`| ... |`)
   and at least one bullet list (`- `). Across the corpus, code fences,
   blockquotes and `---` rules must also appear — but do not add elements that
   do not earn their place just to satisfy a test.
3. Code must be fenced.
4. No HTML. No raw `<script>`, no inline styles.

## Style

- English. Precise. Plain words where plain words work.
- Define an unfamiliar term the first time you use it.
- Distinguish what is established (a paper, a documented guarantee) from what
  is a useful intuition (a heuristic, a mental model) from what is open (an
  active research question). Say which is which.
- Explain trade-offs and failure modes, not just the happy path.
- Never present marketing claims ("dramatically improves", "state of the art",
  "unmatched performance") without a named, specific, verifiable source.
- No emoji. No "In this article we will". No "Let's dive in".
- Do not repeat the lesson's own title as its first sentence.
- Do not write a "Key takeaways" bullet list that just restates the headings.
- Be honest when something is contested or when your knowledge is uncertain —
  write it down in the prose rather than hiding it.

## Before you finish

Re-read your lesson end to end. Check:

- Does the H1 remain exactly as scaffolded?
- Is the frontmatter byte-identical to what you started with?
- Is every symbol defined before use?
- Did you compute the numerical examples, or estimate them?
- Does every external citation correspond to a real, verifiable source?
- Do all internal links point to real lessons (check the slug against
  `apps/home/tests/curriculum-contract.ts`)?
- Is the `TODO(lesson)` marker gone?
- Is there any placeholder text left ("as an AI", "TODO", "Lorem ipsum")?

Report back: the word count, any citation you are unsure about, and any
place where you had to simplify something to stay accurate.
