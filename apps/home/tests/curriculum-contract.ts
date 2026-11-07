/**
 * Contract của curriculum AI/ML/LLM — nguồn sự thật cho **thứ tự học tập** và
 * cho các test bắt content.
 *
 * Vì sao cần một module này thay vì để mỗi test tự đếm:
 *
 * - **Thứ tự học tập là dữ liệu biên tập, không phải thứ tự hệ thống file.**
 *   `seriesOrder` trong frontmatter đã mang thứ tự đó, nhưng thứ tự filesystem
 *   (`stem`) chỉ là tie-break khi hai bài trùng ngày. Một test tự đếm file sẽ
 *   khẳng định "có 30 file" — đúng hôm nay, và im lặng sai ngày mai khi ai
 *   đó thêm bài 31 mà quên cập nhật test. Contract ở đây nói rõ **30 bài, 6
 *   series, mỗi series bao nhiêu bài, và thứ tự của từng bài**; test assert vào
 *   đó, nên thêm bài mà không khai ở đây sẽ đỏ ngay.
 * - **Test assert trên *contract*, không assert trên *số đếm* của file thật.**
 *   Chiều ngược lại (`expect(files.length).toBe(30)`) pass khi có 29 bài thiếu
 *   mà trùng bùa với một file rác.
 *
 * Quan hệ với `SERIES_META` trong `app/blog/blog-series.ts`: đó là nguồn sự thật
 * **hiển thị** (title/description tiếng Anh cho UI và `<head>`), còn `CURRICULUM`
 * ở đây là nguồn sự thật **vị trí** (bài nào thuộc series nào, thứ tự mấy, cần
 * đọc trước cái gì). Hai danh mục phải khớp tập id — `curriculum-contract.spec.ts`
 * assert điều đó, nên thêm series vào một chỗ mà quên chỗ kia sẽ đỏ.
 *
 * Quy ước đặt tên và ký hiệu dùng chung cho cả 30 bài (xem `NOTATION` bên dưới):
 * các bài được viết song song nên phải có một bộ ký hiệu chung, nếu không cùng
 * một khái niệm sẽ mang hai ký hiệu khác nhau và bài sau phải dịch lại bài trước.
 */

/**
 * Quy ước ký hiệu và thuật ngữ xuyên suốt curriculum.
 *
 * Đây là **bất biến biên tập**, không phải gợi ý: mọi bài dùng đúng những ký
 * hiệu này để cùng một đại lượng không mang hai cách viết trong hai bài.
 *
 * ## Ký hiệu toán học
 *
 * - `n` — số mẫu / số token trong chuỗi; `d` — chiều của một vector; `k`, `v` —
 *   chiều key và value trong attention; `V` — kích thước **từ vựng** token
 *   (chữ `V` hoa, để không lẫn với value vector).
 * - `d_k`, `d_v`, `d_model`, `d_ff`, `h` — chiều key, value, model, feed-forward,
 *   số head. Chữ thường `h` là head count, **không** phải hidden size (hidden
 *   size dùng `d_model`).
 * - `p`, `q` — phân phối; `\hat{p}` — mô hảo (estimated); `\hat{y}` — dự đoán;
 *   `y` — nhãn thật.
 * - `L` — hàm mất mát (loss); `\theta` — tham số; `\nabla_\theta L` — gradient
 *   của loss theo tham số; `\eta` — learning rate; `\lambda` — hệ số
 *   regularization / weight decay.
 * - Chỉ số tensor: hàng `i`, cột `j`, batch `b`, chuỗi `t`, head `a`:
 *   `X[i, j]`, `Q[b, t, a]`. Dùng **một** ký hiệu cho một trục trong cả
 *   curriculum — `b` không đổi thành `n` giữa hai bài.
 * - Ma trận viết hoa (`X`, `W`, `Q`, `K`, `V`), vector viết thường đậm (`x`,
 *   `w`, `q`, `k`, `v`). Một "ma trận" cỡ `d x n` luôn nói theo **số hàng × số
 *   cột** (`rows × columns`), không phải "kích thước" vô định.
 *
 * ## Thuật ngữ
 *
 * - **token** — đơn vị đầu vào sau tokenization. Không dùng "từ" (word) cho
 *   token; bài 11 giải thích vì sao phân biệt đó quan trọng.
 * - **context length** — số token mô hình nhìn thấy trong một lần forward.
 * - **prefill** / **decode** — hai pha suy luận (bài 20), dùng đúng nghĩa này.
 * - **prompt** — chuỗi token đầu vào; **completion** — phần sinh ra.
 * - **loss** (mất mát) và **objective** (hàm tối ưu) là hai thứ khác nhau: loss là
 *   cái đo, objective là cái tối ưu. Bài 7 nói rõ ranh giới này.
 * - **grounding** — câu trả lời có bám được vào nguồn hay không (bài 29).
 * - **hallucination** — chỉ dùng cho sinh nội dung sai/không có cơ sở, không
 *   dùng chung cho mọi lỗi.
 * - Viết tiếng Anh, dùng `e` cho base của tự nhiên. Số đo luôn kèm **nguồn và
 *   điều kiện đo** — một con số không nêu điều kiện đo là marketing, không phải
 *   kết quả.
 *
 * ## Cấu trúc bài
 *
 * Mỗi bài mở bằng một đoạn nêu **vấn đề và điều gì người đọc sẽ làm được**, rồi
 * đi vào cơ chế, có ví dụ số học khi giúp hiểu, và kết bằng phần giới hạn.
 * Không lặp lại mẫu "Introduction / Conclusion" giống nhau ở cả 30 bài — tiêu đề
 * `##` phải nói đúng nội dung riêng của bài đó.
 */
export const NOTATION = {
  /** Kích thước tensor: quy ước "hàng × cột". */
  shape: 'rows × columns',
  /** Ngày xuất bản bài đầu tiên — mốc để sinh lịch publish tuần tự. */
  firstPublicationDate: '2026-09-14',
} as const;

/** Danh mục series — mirror của `SERIES_META` (id và số bài phải khớp). */
export const SERIES_CATALOG = {
  'mathematical-foundations': {
    order: 1,
    title: 'Mathematical foundations',
    description:
      'The linear algebra, calculus, probability and information theory that the rest of the curriculum assumes without restating.',
  },
  'classical-machine-learning': {
    order: 2,
    title: 'Classical machine learning and optimization',
    description:
      'Generalization, loss functions, gradient descent, the bias-variance trade-off, and the embeddings that bridge symbols to geometry.',
  },
  'language-modeling': {
    order: 3,
    title: 'Language modeling and transformers',
    description:
      'How text becomes tokens, why models predict the next token, where sequence order enters attention, and how a transformer block is assembled.',
  },
  pretraining: {
    order: 4,
    title: 'Pretraining and scaling',
    description:
      'The training loop end to end, the empirical scaling relationships, data curation, and the three axes of distributed training.',
  },
  inference: {
    order: 5,
    title: 'Inference and model adaptation',
    description:
      'Prefill and decode, the memory cost of long contexts, quantization, supervised fine-tuning, and preference optimization.',
  },
  'evaluation-and-rag': {
    order: 6,
    title: 'Evaluation and RAG',
    description:
      'Metrics, benchmarks, retrieval-augmented generation, embedding search, reranking, and reproducible experiments.',
  },
} as const;

/** Id series trong catalog. */
export type CurriculumSeriesId = keyof typeof SERIES_CATALOG;

/**
 * Một bài trong curriculum.
 *
 * `order` là **vị trí toàn cục** (1-30) — nó sinh ra cả `seriesOrder` lẫn tiền tố
 * số của thư mục content, nên hai thứ không thể lệch nhau. `slug` là URL
 * (tiền tố số bị `strip` khi dựng path), `articleId` là identity biên tập mà
 * `prerequisites`/`relatedArticleIds` trỏ tới.
 */
export type CurriculumArticle = {
  /** Vị trí toàn cục, 1-based, liên tục từ 1 đến 30. */
  readonly order: number;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly seriesId: CurriculumSeriesId;
  /** Phân loại nội dung — `research-review`/`benchmark`/`experiment` bị bắt buộc cite. */
  readonly contentType: 'theory' | 'research-review' | 'experiment' | 'benchmark';
  readonly level: 'foundational' | 'intermediate' | 'advanced';
  /** `articleId` phải đọc trọước — rỗng ở bài gốc của chuỗi. */
  readonly prerequisites: readonly string[];
  /** `articleId` liên quan — cầu nối chéo, không phải "bài cùng series". */
  readonly related: readonly string[];
  /**
   * Vị trí **trong series** — 1-based, theo thứ tự `order` trong series đó.
   *
   * Cần vì `order` là vị trí **toàn cục**: bài 16 là `seriesOrder: 1` của
   * series Pretraining, không phải 16. Suy ra ở đây (thay vì khai tay 30 lần)
   * để thứ tự học tập của một series không thể lệch khỏi thứ tự toàn cục —
   * hai bản khai tay là hai nguồn sự thật cho cùng một thứ tự.
   */
  readonly seriesOrder: number;
  /** Tên file cover trong `content/assets/`. */
  readonly cover: string;
  /** Khoá motif hình học của cover — xem `tests/curriculum-covers.spec.ts`. */
  readonly motif: string;
};

const A = (
  order: number,
  slug: string,
  title: string,
  description: string,
  seriesId: CurriculumSeriesId,
  contentType: CurriculumArticle['contentType'],
  level: CurriculumArticle['level'],
  prerequisites: readonly string[],
  related: readonly string[],
  motif: string,
): CurriculumArticle => ({
  order,
  slug,
  title,
  description,
  seriesId,
  contentType,
  level,
  prerequisites,
  related,
  cover: `cover-${String(order).padStart(2, '0')}-${slug}.svg`,
  motif,
});

/** 30 bài, theo thứ tự học tập. Đây là contract, không phải inventory suy ra. */
const LESSON_DRAFTS: readonly Omit<CurriculumArticle, 'seriesOrder'>[] = [
  /* ── Series 1 — mathematical foundations ── */
  A(
    1,
    'vectors-matrices-and-tensors',
    'Vectors, matrices, and tensors: the language of machine learning',
    'The linear-algebra objects every layer is built from, and how to read the shapes that flow through a model.',
    'mathematical-foundations',
    'theory',
    'foundational',
    [],
    ['linear-algebra-projections-and-rank', 'probability-and-statistics-for-ml'],
    'grid-matrix',
  ),
  A(
    2,
    'linear-algebra-projections-and-rank',
    'Linear algebra for neural networks: projections, rank, and geometry',
    'Why a linear layer compresses or discards information, what rank actually measures, and how that constrains a network.',
    'mathematical-foundations',
    'theory',
    'foundational',
    ['vectors-matrices-and-tensors'],
    ['calculus-for-learning', 'embeddings-learned-geometry'],
    'projection',
  ),
  A(
    3,
    'calculus-for-learning',
    'Calculus for learning: derivatives, gradients, and the chain rule',
    'How a loss becomes a gradient, what backpropagation actually computes, and why the chain rule makes deep networks trainable.',
    'mathematical-foundations',
    'theory',
    'foundational',
    ['vectors-matrices-and-tensors'],
    ['gradient-descent-and-backpropagation', 'linear-algebra-projections-and-rank'],
    'tangent-curve',
  ),
  A(
    4,
    'probability-and-statistics-for-ml',
    'Probability and statistics for machine learning',
    'Random variables, distributions, expectation, conditional probability and Bayes rule — the language of uncertainty in a trained model.',
    'mathematical-foundations',
    'theory',
    'foundational',
    ['vectors-matrices-and-tensors'],
    ['information-theory-and-cross-entropy', 'supervised-learning-and-generalization'],
    'bell-curve',
  ),
  A(
    5,
    'information-theory-and-cross-entropy',
    'Information theory: entropy, cross-entropy, and KL divergence',
    'Derive entropy, cross-entropy and KL divergence, and see why language-model training minimizes exactly this quantity.',
    'mathematical-foundations',
    'theory',
    'foundational',
    ['probability-and-statistics-for-ml'],
    ['loss-functions-what-models-minimize', 'tokenization-text-to-model-input'],
    'stacked-bars',
  ),

  /* ── Series 2 — classical machine learning and optimization ── */
  A(
    6,
    'supervised-learning-and-generalization',
    'From data to models: supervised learning and generalization',
    'Splits, leakage, inductive bias, and the question every experiment answers: does this work on data we never saw?',
    'classical-machine-learning',
    'theory',
    'foundational',
    ['probability-and-statistics-for-ml', 'linear-algebra-projections-and-rank'],
    ['overfitting-regularization-bias-variance', 'embeddings-learned-geometry'],
    'scatter-split',
  ),
  A(
    7,
    'loss-functions-what-models-minimize',
    'Loss functions: what does a model actually learn to minimize?',
    'Squared error, cross-entropy and likelihood are different objectives, not interchangeable spellings of the same thing.',
    'classical-machine-learning',
    'theory',
    'intermediate',
    ['information-theory-and-cross-entropy', 'supervised-learning-and-generalization'],
    ['gradient-descent-and-backpropagation', 'preference-optimization-rlhf-and-dpo'],
    'crossing-curves',
  ),
  A(
    8,
    'gradient-descent-and-backpropagation',
    'Gradient descent and backpropagation: learning through optimization',
    'From loss to gradient to parameter update, and the practical failure modes of a misconfigured optimizer.',
    'classical-machine-learning',
    'theory',
    'intermediate',
    ['calculus-for-learning', 'loss-functions-what-models-minimize'],
    ['training-a-transformer', 'kv-cache-memory-of-long-contexts'],
    'contour-descent',
  ),
  A(
    9,
    'overfitting-regularization-bias-variance',
    'Overfitting, regularization, and the bias-variance trade-off',
    'Why a model that memorizes the training set can still be useless, and which regularizer to reach for.',
    'classical-machine-learning',
    'theory',
    'intermediate',
    ['supervised-learning-and-generalization', 'gradient-descent-and-backpropagation'],
    ['data-curation-quality-and-contamination', 'evaluating-language-models'],
    'fit-curves',
  ),
  A(
    10,
    'embeddings-learned-geometry',
    'Embeddings: turning discrete symbols into learned geometry',
    'Embedding tables, similarity functions, and what vector geometry can and cannot tell you.',
    'classical-machine-learning',
    'theory',
    'intermediate',
    ['linear-algebra-projections-and-rank', 'supervised-learning-and-generalization'],
    ['embedding-retrieval-similarity-and-ann', 'tokenization-text-to-model-input'],
    'point-cloud',
  ),

  /* ── Series 3 — language modeling and transformers ── */
  A(
    11,
    'tokenization-text-to-model-input',
    'Tokenization: how text becomes model input',
    'Subword vocabularies, Unicode, the token-count implications of a tokenizer choice, and why tokenization is not neutral preprocessing.',
    'language-modeling',
    'theory',
    'intermediate',
    ['information-theory-and-cross-entropy'],
    ['language-modeling-next-token-prediction', 'embeddings-learned-geometry'],
    'token-blocks',
  ),
  A(
    12,
    'language-modeling-next-token-prediction',
    'Language modeling: probability, likelihood, and next-token prediction',
    'The autoregressive factorization, teacher forcing, and what next-token prediction does and does not teach a model.',
    'language-modeling',
    'theory',
    'intermediate',
    ['tokenization-text-to-model-input', 'information-theory-and-cross-entropy'],
    ['attention-from-first-principles', 'evaluating-language-models'],
    'chain-probability',
  ),
  A(
    13,
    'positional-information-in-transformers',
    'Positional information: how transformers represent order',
    'Attention is permutation-invariant, so order has to enter somewhere. Compare learned, sinusoidal and rotary encodings.',
    'language-modeling',
    'theory',
    'intermediate',
    // Chủ ý **không** khai `attention-from-first-principles` làm prerequisite:
    // bài này đứng trước bài 14 trong lộ trình, nên phụ thuộc về sau là hỏng
    // nguyên tắc "prerequisite phải là bài đã đọc". Thay vào đó bài tự dựng đủ
    // công thức điểm số attention cần thiết (ngắn) và trỏ bài 14 ở `related` để
    // người đọc muốn phần suy luận đầy đủ thì đi tiếp.
    ['linear-algebra-projections-and-rank'],
    ['attention-from-first-principles', 'multi-head-attention-and-transformer-blocks'],
    'sine-wave',
  ),
  A(
    14,
    'attention-from-first-principles',
    'Attention from first principles: queries, keys, and values',
    'Derive scaled dot-product attention from three plain vectors and explain every symbol in the standard form.',
    'language-modeling',
    'theory',
    'intermediate',
    ['linear-algebra-projections-and-rank', 'information-theory-and-cross-entropy'],
    ['positional-information-in-transformers', 'multi-head-attention-and-transformer-blocks'],
    'attention-nodes',
  ),
  A(
    15,
    'multi-head-attention-and-transformer-blocks',
    'Multi-head attention and transformer blocks',
    'Residual connections, normalization placement, feed-forward layers, and the complete anatomy of one transformer block.',
    'language-modeling',
    'theory',
    'intermediate',
    ['attention-from-first-principles'],
    ['training-a-transformer', 'kv-cache-memory-of-long-contexts'],
    'layer-stack',
  ),

  /* ── Series 4 — pretraining and scaling ── */
  A(
    16,
    'training-a-transformer',
    'Training a transformer: from tokens to parameter updates',
    'The full training loop traced end to end: batches, forward pass, loss, backward pass, optimizer step, checkpointing.',
    'pretraining',
    'theory',
    'intermediate',
    ['multi-head-attention-and-transformer-blocks', 'gradient-descent-and-backpropagation'],
    ['distributed-training-parallelism', 'scaling-laws-parameters-and-data'],
    'cycle-loop',
  ),
  A(
    17,
    'scaling-laws-parameters-and-data',
    'Scaling laws: parameters, data, and compute',
    'What the empirical scaling relationships do and do not justify, and why the compute-optimal training budget keeps moving.',
    'pretraining',
    'research-review',
    'advanced',
    ['training-a-transformer'],
    ['data-curation-quality-and-contamination', 'distributed-training-parallelism'],
    'power-law',
  ),
  A(
    18,
    'data-curation-quality-and-contamination',
    'Data curation for language models: quality, deduplication, and contamination',
    'Sourcing, filtering, deduplication, benchmark contamination, diversity and privacy in pretraining corpora.',
    'pretraining',
    'research-review',
    'advanced',
    ['training-a-transformer'],
    ['scaling-laws-parameters-and-data', 'evaluating-language-models'],
    'curation-funnel',
  ),
  A(
    19,
    'distributed-training-parallelism',
    'Distributed training: data, tensor, and pipeline parallelism',
    'Why training runs on many devices, and how data, tensor and pipeline parallelism trade communication against memory.',
    'pretraining',
    'research-review',
    'advanced',
    ['training-a-transformer', 'linear-algebra-projections-and-rank'],
    ['kv-cache-memory-of-long-contexts', 'quantization-precision-and-efficiency'],
    'device-grid',
  ),

  /* ── Series 5 — inference and model adaptation ── */
  A(
    20,
    'llm-inference-prefill-and-decode',
    'LLM inference: prefill, decode, and autoregressive generation',
    'The two phases of generation, why they have opposite bottlenecks, and how batching trades latency against throughput.',
    'inference',
    'theory',
    'intermediate',
    ['multi-head-attention-and-transformer-blocks', 'language-modeling-next-token-prediction'],
    ['kv-cache-memory-of-long-contexts', 'quantization-precision-and-efficiency'],
    'prefill-timeline',
  ),
  A(
    21,
    'kv-cache-memory-of-long-contexts',
    'The KV cache: why long contexts consume so much memory',
    'Derive the memory a KV cache occupies, and see which of layers, heads, sequence length or precision dominates the bill.',
    'inference',
    'theory',
    'intermediate',
    ['llm-inference-prefill-and-decode', 'attention-from-first-principles'],
    ['quantization-precision-and-efficiency', 'distributed-training-parallelism'],
    'memory-bars',
  ),
  A(
    22,
    'quantization-precision-and-efficiency',
    'Quantization: trading numerical precision for efficiency',
    'Weight and activation quantization, calibration, measured quality loss, and why smaller weights do not automatically mean faster inference.',
    'inference',
    'theory',
    'intermediate',
    ['kv-cache-memory-of-long-contexts'],
    ['supervised-fine-tuning-instructions', 'llm-inference-prefill-and-decode'],
    'quantize-steps',
  ),
  A(
    23,
    'supervised-fine-tuning-instructions',
    'Supervised fine-tuning: teaching a pretrained model to follow instructions',
    'Data formatting, the training objective, what differs from pretraining, quality control, and the limits of instruction tuning.',
    'inference',
    'research-review',
    'intermediate',
    ['training-a-transformer', 'loss-functions-what-models-minimize'],
    ['preference-optimization-rlhf-and-dpo', 'quantization-precision-and-efficiency'],
    'instruction-transform',
  ),
  A(
    24,
    'preference-optimization-rlhf-and-dpo',
    'Preference optimization: RLHF, reward models, and DPO',
    'Compare SFT, reward-model RLHF and DPO on the objective each one actually optimizes, and what none of them can express.',
    'inference',
    'research-review',
    'advanced',
    ['supervised-fine-tuning-instructions', 'loss-functions-what-models-minimize'],
    ['evaluating-language-models', 'reproducible-llm-experiments'],
    'preference-branch',
  ),

  /* ── Series 6 — evaluation and RAG ── */
  A(
    25,
    'evaluating-language-models',
    'Evaluating language models: metrics, benchmarks, and experimental design',
    'Perplexity, task metrics, benchmark contamination, human evaluation and why one aggregate score cannot answer your question.',
    'evaluation-and-rag',
    'benchmark',
    'intermediate',
    ['language-modeling-next-token-prediction', 'data-curation-quality-and-contamination'],
    ['evaluating-rag-systems', 'reproducible-llm-experiments'],
    'bar-target',
  ),
  A(
    26,
    'rag-fundamentals',
    'RAG fundamentals: retrieval, context construction, and generation',
    'The retrieval-augmented generation pipeline, document preparation, chunking trade-offs, context construction and grounding limits.',
    'evaluation-and-rag',
    'research-review',
    'intermediate',
    ['embeddings-learned-geometry', 'llm-inference-prefill-and-decode'],
    ['embedding-retrieval-similarity-and-ann', 'evaluating-rag-systems'],
    'retrieve-context-generate',
  ),
  A(
    27,
    'embedding-retrieval-similarity-and-ann',
    'Embedding retrieval: similarity search, ANN, and recall',
    'Vector similarity, exact versus approximate search, the recall-latency trade-off, and how retrieval quality is actually measured.',
    'evaluation-and-rag',
    'research-review',
    'intermediate',
    ['embeddings-learned-geometry'],
    ['reranking-and-hybrid-search', 'rag-fundamentals'],
    'ann-rings',
  ),
  A(
    28,
    'reranking-and-hybrid-search',
    'Reranking and hybrid search: improving retrieval quality',
    'Lexical retrieval, dense retrieval, hybrid fusion, cross-encoder reranking, ranking metrics, and candidate recall versus ranking quality.',
    'evaluation-and-rag',
    'research-review',
    'intermediate',
    ['embedding-retrieval-similarity-and-ann'],
    ['evaluating-rag-systems', 'rag-fundamentals'],
    'rerank-ladder',
  ),
  A(
    29,
    'evaluating-rag-systems',
    'Evaluating RAG systems: retrieval quality, faithfulness, and answer relevance',
    'Separate retrieval evaluation from generation evaluation, and judge correctness, faithfulness and citation support independently.',
    'evaluation-and-rag',
    'benchmark',
    'advanced',
    ['rag-fundamentals', 'evaluating-language-models'],
    ['reproducible-llm-experiments', 'reranking-and-hybrid-search'],
    'claim-check',
  ),
  A(
    30,
    'reproducible-llm-experiments',
    'Reproducible LLM experiments: from hypothesis to reliable results',
    'Hypotheses, baselines, controlled variables, seeds, dataset and version tracking, statistical uncertainty, ablations and negative results.',
    'evaluation-and-rag',
    'experiment',
    'intermediate',
    ['evaluating-language-models', 'evaluating-rag-systems'],
    ['data-curation-quality-and-contamination', 'overfitting-regularization-bias-variance'],
    'error-bars',
  ),
];

/**
 * Bài đã hoàn chỉnh, `seriesOrder` được suy ra từ `order`.
 *
 * `seriesOrder` **không** khai tay ở 30 entry: nó là hệ quả của thứ tự toàn
 * cục, và khai tay sẽ tạo ra hai nguồn sự thật cho cùng một thứ tự — loại lỗi
 * mà contract test ở đây chính là để bắt.
 */
export const CURRICULUM: readonly CurriculumArticle[] = LESSON_DRAFTS.map((lesson) => ({
  ...lesson,
  seriesOrder: LESSON_DRAFTS.filter(
    (candidate) => candidate.seriesId === lesson.seriesId && candidate.order <= lesson.order,
  ).length,
}));

/** Số bài curriculum — contract, không phải đếm file lúc test chạy. */
export const CURRICULUM_SIZE = 30;

/**
 * Ngày xuất bản của từng bài — bài thứ `i` (1-based) xuất bản ngày
 * `firstPublicationDate` cộng `i - 1` ngày.
 *
 * Ngày **tăng dần** theo thứ tự học tập là chủ ý: curriculum được xuất bản theo
 * đúng lộ trình, nên bài 1 là bài cũ nhất và bài 30 là bài mới nhất. Đây cũng là
 * lý do bài 1 khai `featured: true` — helper chọn hero quét danh sách **đã sort
 * giảm dần theo ngày** và lấy phần tử featured đầu tiên, nên bài featured duy
 * nhất được chọn bất kể nó đứng ở đâu trong thứ tự ngày.
 */
export function publicationDate(order: number): string {
  const start = new Date(`${NOTATION.firstPublicationDate}T00:00:00Z`);
  const published = new Date(start.getTime() + (order - 1) * 86_400_000);
  return published.toISOString().slice(0, 10);
}
