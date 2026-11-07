import { describe, expect, it } from 'vitest';

import { SERIES_META } from '../app/blog/blog-series';
import { BLOG_PRODUCTION_ORIGIN } from '../app/blog/blog-origin';
import { isValidArticleDate } from '../app/blog/blog-date';
import { frontmatterList, parseFrontmatter } from './content-frontmatter';
import {
  CURRICULUM,
  CURRICULUM_SIZE,
  SERIES_CATALOG,
  publicationDate,
} from './curriculum-contract';

/**
 * Contract của curriculum — chạy trên **file thật** trong `content/en/blog/`.
 *
 * `content-contract.spec.ts` kiểm những bất biến áp cho *mọi* bài blog
 * (frontmatter đủ, slug unique, reference resolve...). Ở đây kiểm bất biến
 * riêng của **curriculum**: đúng 30 bài, đúng 6 series, đúng thứ tự học tập,
 * và mỗi bài khớp với entry trong `CURRICULUM`.
 *
 * Vì sao cần một spec riêng thay vì nhét số 30 vào `content-contract.spec.ts`:
 * số bài là **quyết định biên tập**, không phải thứ suy ra từ đếm file. Ở đây
 * `CURRICULUM` là nguồn sự thật khai *chủ ý* 30 mục; các test assert content
 * thật khớp với nó. Chiều ngược lại — `expect(số file).toBe(30)` — pass khi
 * có 29 bài thiếu mà bù lại bằng một file rác ở thư mục khác, và im lặng
 * sai ngày mai khi ai đó thêm bài 31 mà không cập nhật contract.
 */

/** Raw markdown của **mọi** bài blog EN — khoá là path từ `apps/home`. */
const ARTICLE_SOURCES = import.meta.glob<string>('../content/en/blog/*/index.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Raw SVG của **mọi** cover trong thư mục asset dùng chung. */
const ASSET_SOURCES = import.meta.glob<string>('../content/assets/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Raw markdown của **mọi** bài blog VI — phải rỗng ở inventory English-first này. */
const VIETAMESE_SOURCES = import.meta.glob<string>('../content/vi/blog/*/index.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** `{ dirName, raw }` suy ra từ glob key bài EN. */
const articles = Object.entries(ARTICLE_SOURCES).map(([key, raw]) => {
  const match = /content\/en\/blog\/([^/]+)\/index\.md$/u.exec(key);
  if (!match?.[1]) {
    throw new Error(`unexpected glob key: ${key}`);
  }
  return { dirName: match[1], raw, frontmatter: parseFrontmatter(raw) };
});

/** Tên file (không đuôi `.svg`) của mọi asset cover. */
const assetNames = new Set(
  Object.keys(ASSET_SOURCES).map(
    (path) =>
      path
        .split('/')
        .pop()
        ?.replace(/\.svg$/u, '') ?? '',
  ),
);

/** Slug URL — bỏ prefix số ordering của tên thư mục. */
function urlSlug(dirName: string): string {
  return dirName.replace(/^\d+\./u, '');
}

/** Tập `articleId` trong content thật — nguồn so khớp mọi reference. */
const contentIds = new Set(
  articles
    .map((article) => article.frontmatter.articleId)
    .filter((id): id is string => typeof id === 'string'),
);

/** Entry contract theo slug. */
const bySlug = new Map(CURRICULUM.map((article) => [article.slug, article]));

/** Số bài theo series trong contract — `[['series', n], ...]` đã sort. */
const contractShape = Object.keys(SERIES_CATALOG)
  .map((id) => [id, CURRICULUM.filter((article) => article.seriesId === id).length] as const)
  .toSorted((a, b) => a[0].localeCompare(b[0]));

describe('curriculum contract', () => {
  it('declares exactly 30 lessons and content has exactly 30 English articles', () => {
    // Hai con số phải bằng nhau: contract nói 30, và **content thật** phải có 30.
    // Không assert `CURRICULUM.length === 30` một mình — cái đó chỉ kiểm bản
    // khai của contract, không kiểm bài viết ra đã tồn tại.
    expect([CURRICULUM_SIZE, CURRICULUM.length]).toEqual([30, 30]);
    expect(articles.length).toBe(CURRICULUM_SIZE);
  });

  it('orders lessons 1 to 30 with no gap and no duplicate', () => {
    const orders = CURRICULUM.map((article) => article.order);
    expect(orders).toEqual(Array.from({ length: CURRICULUM_SIZE }, (_, i) => i + 1));
  });

  it('gives every lesson a unique slug, articleId and content directory', () => {
    const slugs = CURRICULUM.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const ids = CURRICULUM.map((article) => article.slug);
    expect(new Set(ids).size).toBe(ids.length);

    // Thư mục content phải là `<order>.<slug>`: tiền tố số là tie-break ổn định
    // của ordering listing, và khớp `order` trong contract là điều kiện để
    // "lesson 7" trong prose khớp với bài đang mở.
    for (const article of CURRICULUM) {
      const expected = `${String(article.order).padStart(2, '0')}.${article.slug}`;
      expect(
        articles.some((file) => file.dirName === expected),
        `content dir ${expected}`,
      ).toBe(true);
    }
    // Và không thư mục content nào nằm ngoài contract — một bài sót lại từ
    // inventory trước sẽ lọt qua mọi assert nếu ta chỉ kiểm chiều contract→content.
    const expectedDirs = new Set(
      CURRICULUM.map((a) => `${String(a.order).padStart(2, '0')}.${a.slug}`),
    );
    expect(
      articles.filter((file) => !expectedDirs.has(file.dirName)).map((f) => f.dirName),
    ).toEqual([]);
  });

  it('matches every content article to its contract entry on metadata', () => {
    const problems: string[] = [];
    for (const file of articles) {
      const slug = urlSlug(file.dirName);
      const expected = bySlug.get(slug);
      if (expected === undefined) {
        problems.push(`${file.dirName}: not in contract`);
        continue;
      }
      const fm = file.frontmatter;
      if (fm.title !== expected.title) problems.push(`${slug}: title`);
      if (fm.description !== expected.description) problems.push(`${slug}: description`);
      if (fm.articleId !== slug) problems.push(`${slug}: articleId ${String(fm.articleId)}`);
      if (fm.seriesId !== expected.seriesId) problems.push(`${slug}: seriesId`);
      if (fm.seriesOrder !== expected.seriesOrder) {
        problems.push(`${slug}: seriesOrder ${String(fm.seriesOrder)}`);
      }
      if (fm.contentType !== expected.contentType) problems.push(`${slug}: contentType`);
      if (fm.level !== expected.level) problems.push(`${slug}: level`);
      if (fm.date !== publicationDate(expected.order)) problems.push(`${slug}: date`);
      // Prerequisites/related phải khớp **thứ tự** contract khai: thứ tự là ý
      // nghĩa biên tập (bài nào đọc trước bài nào), và UI render đúng thứ tự đó.
      if (frontmatterList(fm, 'prerequisites').join(',') !== expected.prerequisites.join(',')) {
        problems.push(`${slug}: prerequisites`);
      }
      if (frontmatterList(fm, 'relatedArticleIds').join(',') !== expected.related.join(',')) {
        problems.push(`${slug}: related`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every lesson a valid publication date in curriculum order', () => {
    // Ngày tăng dần nghiêm ngặt theo `order`: curriculum xuất bản đúng lộ trình,
    // nên bài 1 cũ nhất và bài 30 mới nhất. Đây cũng là điều kiện để listing
    // sort theo ngày khớp đúng thứ tự học tập.
    const dates = CURRICULUM.map((article) => publicationDate(article.order));
    for (const date of dates) {
      expect([date, isValidArticleDate(date)]).toEqual([expect.any(String), true]);
    }
    expect([...dates].toSorted()).toEqual(dates);
    // Ngày không được tương lai so với thời điểm build — content là tuyên bố
    // lịch xuất bản, một bài "xuất bản năm sau" là dữ liệu sai.
    const today = new Date().toISOString().slice(0, 10);
    expect(dates.at(-1) <= today).toBe(true);
  });

  it('marks exactly one lesson featured so the landing hero is stable', () => {
    const featured = articles.filter((file) => file.frontmatter.featured === true);
    expect(featured.length).toBe(1);
    // Helper chọn hero quét danh sách **đã sort giảm dần theo ngày** rồi lấy
    // phần tử featured đầu tiên; bài featured duy nhất nên là bài 1 — cùng bài
    // luôn được chọn bất kể thứ tự ngày có đổi hay không.
    expect(urlSlug(featured.at(0)?.dirName ?? '')).toBe('vectors-matrices-and-tensors');
  });

  it('keeps the series catalog and the UI series metadata in the same set', () => {
    // `SERIES_META` là nguồn sự thật **hiển thị** (title/description cho UI và
    // `<head>`); `SERIES_CATALOG` là nguồn sự thật **vị trí**. Thêm series vào
    // một chỗ mà quên chỗ kia là lỗi âm thầm: series có bài nhưng không có
    // trang overview, hoặc có trang overview rỗng.
    expect(Object.keys(SERIES_CATALOG).toSorted()).toEqual(Object.keys(SERIES_META).toSorted());
    for (const id of Object.keys(SERIES_CATALOG)) {
      const meta = SERIES_META[id as keyof typeof SERIES_META];
      expect([id, meta?.title, meta?.description.length]).toEqual([
        expect.any(String),
        expect.any(String),
        expect.any(Number),
      ]);
    }
  });

  it('assigns each series a contiguous 1-based run of seriesOrder', () => {
    // `seriesOrder` là vị trí *trong series*; nav series sort theo nó. Một
    // series có khoảng trống (1,3) nghĩa là bài 2 không tồn tại hoặc thuộc
    // series khác — ở inventory này cả hai đều là lỗi biên tập.
    for (const id of Object.keys(SERIES_CATALOG)) {
      const orders = CURRICULUM.filter((article) => article.seriesId === id)
        .map((article) => article.seriesOrder ?? 0)
        .toSorted((a, b) => a - b);
      expect([id, orders]).toEqual([
        expect.any(String),
        Array.from({ length: orders.length }, (_, i) => i + 1),
      ]);
    }
  });

  it('describes the inventory shape: six series covering exactly 30 lessons', () => {
    // Hình dạng curriculum là quyết định biên tập, không phải hiện tượng. Khẳng
    // định nó tường minh để thêm series thứ 7 (bài 31+) là một thay đổi có chủ
    // ý, không phải tai nạn. Số bài mỗi series **không đều** theo chủ ý: các
    // series 4 và 6 dành nhiều chỗ hơn cho phần khó nhất (scaling, đánh giá và
    // RAG), và đó là lý do contract không dùng "5 bài mỗi series" làm giả định.
    expect(contractShape).toEqual([
      ['classical-machine-learning', 5],
      ['evaluation-and-rag', 6],
      ['inference', 5],
      ['language-modeling', 5],
      ['mathematical-foundations', 5],
      ['pretraining', 4],
    ]);
    expect(contractShape.reduce((sum, [, count]) => sum + count, 0)).toBe(CURRICULUM_SIZE);
  });

  it('never points a prerequisite at a later lesson', () => {
    // Prerequisite là "đã đọc rồi hãy đọc tiếp" — trỏ về sau là nghịch lý và
    // làm nav học tập vô nghĩa. Đây là bất biật biên tập, không phải thứ zod
    // enforce được (zod không nhìn thấy `order` của bài khác).
    const problems: string[] = [];
    for (const article of CURRICULUM) {
      for (const prereq of article.prerequisites) {
        const target = CURRICULUM.find((candidate) => candidate.slug === prereq);
        if (target === undefined) {
          problems.push(`${article.slug}: prereq ${prereq} not in curriculum`);
          continue;
        }
        if (target.order >= article.order) {
          problems.push(`${article.slug} (${article.order}) -> ${prereq} (${target.order})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('resolves every prerequisite and related reference to a real articleId', () => {
    // Reference trỏ tới ID không tồn tại sẽ biến mất khỏi UI im lặng — hợp lệ về
    // runtime nhưng gần như luôn là lỗi tách. Bắt ở đây trên cả hai chiều:
    // contract→content và content→contract.
    const problems: string[] = [];
    for (const article of CURRICULUM) {
      for (const field of ['prerequisites', 'related'] as const) {
        for (const ref of article[field]) {
          if (!CURRICULUM.some((candidate) => candidate.slug === ref)) {
            problems.push(`contract ${article.slug}.${field} -> ${ref}`);
          }
        }
      }
    }
    for (const file of articles) {
      for (const field of ['prerequisites', 'relatedArticleIds'] as const) {
        for (const ref of frontmatterList(file.frontmatter, field)) {
          if (!contentIds.has(ref)) {
            problems.push(`content ${file.dirName}.${field} -> ${ref}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('never lists a lesson in its own related articles', () => {
    // Tự tham chiếu là lỗi biên tập: UI render link tới chính trang đang mở,
    // và related-block mất một slot cho một bài thật.
    const problems = CURRICULUM.filter((article) => article.related.includes(article.slug)).map(
      (article) => article.slug,
    );
    expect(problems).toEqual([]);
  });

  it('gives every lesson a distinct SVG cover that exists, and no cover is orphaned', () => {
    // Chiều hai: content→asset (mọi bài có cover thật) và asset→content (không
    // cover mồ côi). Chiều thứ hai là thứ bắt asset sót lại từ inventory cũ —
    // và bắt cả **mapping nhầm**: hai bài cùng trỏ một cover, hoặc một cover
    // không bài nào trỏ tới.
    const missing: string[] = [];
    const claimed = new Set<string>();
    const duplicates: string[] = [];
    for (const file of articles) {
      const cover = file.frontmatter.cover;
      const alt = file.frontmatter.coverAlt;
      if (typeof cover !== 'string' || cover === '') {
        missing.push(`${file.dirName}: no cover`);
        continue;
      }
      if (typeof alt !== 'string' || alt.trim() === '') {
        missing.push(`${file.dirName}: no coverAlt`);
      }
      const name =
        cover
          .split('/')
          .pop()
          ?.replace(/\.svg$/u, '') ?? '';
      if (!assetNames.has(name)) {
        missing.push(`${file.dirName}: ${cover}`);
      }
      if (claimed.has(name)) {
        duplicates.push(name);
      }
      claimed.add(name);
    }
    expect(missing).toEqual([]);
    expect(duplicates).toEqual([]);
    expect(claimed.size).toBe(CURRICULUM_SIZE);
  });

  it('orphans no asset: every SVG is referenced as a cover or as inline body media', () => {
    // Asset không bài nào trỏ tới là mồ côi — sót từ inventory cũ, hoặc sinh
    // nhầm. Cả hai đều làm cây content không còn mô tả được, và file mồ côi
    // vẫn được phát ra production.
    //
    // "Được trỏ tới" gồm **hai** dạng: `cover` trong frontmatter (mỗi bài đúng
    // một cover) và ảnh inline trong thân bài (`![alt](../../../assets/x.svg)`).
    // Chỉ đếm cover sẽ kết án oan một sơ đồ minh hoạ trong bài, và biến lệnh
    // "vẽ thêm một diagram cho bài 15" thành một test đỏ.
    const claimed = new Set<string>();
    for (const article of CURRICULUM) {
      claimed.add((article.cover ?? '').replace(/\.svg$/u, ''));
    }
    const inlineReferenced = new Set<string>();
    for (const file of articles) {
      for (const match of file.raw.matchAll(/!\[[^\]]*\]\(\.\.\/\.\.\/\.\.\/assets\/([^)]+)\)/gu)) {
        inlineReferenced.add((match[1] ?? '').replace(/\.svg$/u, ''));
      }
    }
    const referenced = new Set([...claimed, ...inlineReferenced]);
    expect([...assetNames].filter((name) => !referenced.has(name)).toSorted()).toEqual([]);
  });

  it('names every cover after its own lesson', () => {
    // Quy ước đặt tên `<NN>-<slug>`: nhìn tên file là biết bài nào, và đổi slug
    // bắt buộc đổi cả tên cover (hai thứ phải di chuyển cùng nhau).
    for (const article of CURRICULUM) {
      expect([article.slug, article.cover]).toEqual([
        expect.any(String),
        `cover-${String(article.order).padStart(2, '0')}-${article.slug}.svg`,
      ]);
    }
  });

  it('renders every cover as a safe, self-contained SVG with a readable title', () => {
    // Validate **nội dung** file SVG thật, không chỉ tên file: cover là asset
    // tĩnh đi thẳng ra production, nên một `<script>`, một `href` ngoài hay
    // một entity sai chính là lỗ hổng / lỗi render.
    const problems: string[] = [];
    for (const [path, raw] of Object.entries(ASSET_SOURCES)) {
      const name = path.split('/').pop() ?? path;
      // Chỉ cover curriculum nằm trong asset dir này — nhưng vẫn kiểm mọi file
      // để một asset lạ lọt vào cũng bị soi.
      if (!/<svg[\s>]/u.test(raw)) problems.push(`${name}: not an svg root`);
      if (!/viewBox="0 0 1280 720"/u.test(raw)) problems.push(`${name}: viewBox`);
      if (!/<title[^>]*>[^<]{10,}<\/title>/u.test(raw)) problems.push(`${name}: title too short`);
      if (!/id="cover-desc"/u.test(raw)) problems.push(`${name}: no desc`);
      if (/<script/iu.test(raw)) problems.push(`${name}: script`);
      if (/<foreignObject/iu.test(raw)) problems.push(`${name}: foreignObject`);
      if (/\son[a-z]+\s*=/iu.test(raw)) problems.push(`${name}: event handler`);
      // Tài nguyên ngoài: `<image href>`, `xlink:href`, `@import`, url() ngoài
      // data:. Cover phải tự chứa — nó được phục vụ từ static assets.
      if (/<image[\s>]/iu.test(raw)) problems.push(`${name}: raster image`);
      if (/xlink:href/iu.test(raw)) problems.push(`${name}: xlink:href`);
      if (/@import/iu.test(raw)) problems.push(`${name}: @import`);
      if (/url\((?!['"]?data:)/iu.test(raw)) problems.push(`${name}: external url()`);
      // Chữ phải là `<text>` thật (ảnh của chữ thì không đọc được, không dịch
      // được, không co lại được), và font phải là system stack — không phụ thuộc
      // file font hay request mạng.
      if (!/<text/iu.test(raw)) problems.push(`${name}: no <text>`);
      if (/@font-face/iu.test(raw)) problems.push(`${name}: @font-face`);
      if (!/system-ui/iu.test(raw)) problems.push(`${name}: no system font stack`);
      // Không entity lạ: parser của chúng ta là parser đơn giản, entity không
      // nằm trong 5 entity XML chuẩn là bằng chứng escape sai.
      const entities = [...raw.matchAll(/&([a-zA-Z]+);/gu)].map((match) => match[1]);
      for (const entity of entities) {
        if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(entity ?? '')) {
          problems.push(`${name}: unknown entity &${entity};`);
        }
      }
    }
    expect(Object.keys(ASSET_SOURCES).length).toBe(CURRICULUM_SIZE);
    expect(problems).toEqual([]);
  });

  it('keeps every cover title legible: title block fits its box and clears the motif', () => {
    // SVG **không** có phép đo chữ lúc build (không `getBBox`), nên "tiêu đề vừa
    // khung" là một assert phải suy ra từ số. Khung tiêu đề rộng 640px từ x=88;
    // hộp motif bắt đầu ở x=812. Dùng hệ số bề rộng ký tự thận trọng cho
    // sans-serif ở weight 650.
    const CHAR_WIDTH_RATIO = 0.52;
    const problems: string[] = [];
    for (const article of CURRICULUM) {
      const raw = ASSET_SOURCES[`../content/assets/${article.cover}`] ?? '';
      // Các dòng tiêu đề là <text> font-size>=40 nằm trong khung x=88.
      const titleLines = [
        ...raw.matchAll(/<text x="88" y="[\d.]+" [^>]*font-size="(\d+)"[^>]*>([^<]+)<\/text>/gu),
      ];
      expect(titleLines.length, `${article.slug}: title lines`).toBeGreaterThan(0);
      let maxRight = 0;
      let maxBottom = 0;
      for (const [, size, text] of titleLines) {
        maxRight = Math.max(maxRight, 88 + (text?.length ?? 0) * CHAR_WIDTH_RATIO * Number(size));
        maxBottom = Math.max(maxBottom, Number(size));
      }
      if (maxRight > 88 + 640) problems.push(`${article.slug}: title overflows right edge`);
      // Chạm vùng motif là hỏng bố cục: tiêu đề đè lên hình.
      if (maxRight > 812 - 48) problems.push(`${article.slug}: title collides with motif`);
      // Khối tiêu đề phải nằm trên footer strip.
      if (maxBottom > 632) problems.push(`${article.slug}: title runs into footer`);
    }
    expect(problems).toEqual([]);
  });

  it('advertises no Vietnamese translation that does not exist', () => {
    // Inventory là English-first: `/vi/blog` không có bài. Đây là trạng thái
    // **có chủ ý**, và nó là điều kiện để landing VI fallback sang EN mà không
    // quảng bá `/vi/blog/<slug>` — link đó là 404. Test này ghim cái vắng mặt đó
    // để thêm một bản dịch nửa vời (bài rỗng, frontmatter copy-paste) sẽ đỏ,
    // thay vì lặng lẽ tạo link chết trên landing.
    expect(Object.keys(VIETAMESE_SOURCES)).toEqual([]);
  });

  it('roots the curriculum at lesson 1 and leaves no other lesson unmoored', () => {
    // Bất biận thật của một chuỗi học **liên tục**: đúng một bài gốc không cần
    // đọc trước (bài 1 — không có bài nào trước nó), và **mọi** bài còn lại đều
    // dẫn đường về ít nhất một bài đã đọc.
    //
    // Điều này khác với một curriculum chia đoạn, nơi bài mở đầu mỗi series sẽ
    // đứng một mình. Ở đây các series nối tiếp nhau trên cùng một lộ trình:
    // series 2 đứng trên nền của series 1, series 6 dùng cả ký ức và đánh giá
    // của series trước. Nếu sau này chọn thiết kế khác (mỗi series tự chứa),
    // phải đổi assertion này **cùng lúc** với việc bỏ prerequisite ở các bài mở
    // đầu series — và cả hai đổi phải là quyết định biên tập, không phải sựa
    // cho xanh.
    const rootless = CURRICULUM.filter((article) => article.prerequisites.length === 0);
    expect(rootless.map((article) => article.slug)).toEqual(['vectors-matrices-and-tensors']);
  });

  it('keeps every internal lesson link pointing at a real curriculum route', () => {
    // Link trong prose là `/en/blog/<slug>`. Link chết không bị build bắt (crawler
    // sẽ báo nhưng content-contract test thì không), nên bắt ở đây: mọi slug
    // được link phải là một bài curriculum thật.
    const problems: string[] = [];
    for (const file of articles) {
      const body = file.raw.replace(/^---[\s\S]*?---/u, '');
      for (const match of body.matchAll(/\]\(\/en\/blog\/([a-z0-9-]+)(?:#[^)]*)?\)/gu)) {
        const slug = match[1] ?? '';
        if (!bySlug.has(slug)) problems.push(`${file.dirName}: /en/blog/${slug}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('covers every lesson with substantive prose, not a stub', () => {
    // Bài học học thuật phải có thân thật: độ dài tối thiểu bắt được bài bị bỏ
    // trống sau khi scaffold. Ngưỡng 1200 từ là mức sàn của hướng dẫn biên tập,
    // **không** phải mục tiêu — bài ngắn hơn vẫn hợp lệ nếu nó thật sự giải
    // thích hết chủ đề, và đó là việc của biên tập đọc, không của assert.
    const problems: string[] = [];
    for (const file of articles) {
      const body = file.raw.replace(/^---[\s\S]*?---\s*/u, '');
      const words = body.split(/\s+/u).filter((word) => word !== '').length;
      if (words < 1200) problems.push(`${file.dirName}: ${words} words`);
      if (/TODO\(lesson\)/u.test(body)) problems.push(`${file.dirName}: TODO marker left`);
      if (!/^## /mu.test(body)) problems.push(`${file.dirName}: no ## heading`);
    }
    expect(problems).toEqual([]);
  });

  it('uses math notation that KaTeX can render, in both inline and display form', () => {
    // Không có bài nào được phép dùng `\(`/`\[` (MathJax style) — pipeline là
    // remark-math, nó chỉ hiểu `$` và `$$`. Và công thức display phải đứng
    // riêng dòng, nếu không remark-math không nhận ra.
    const problems: string[] = [];
    let displayBlocks = 0;
    let inlineMath = 0;
    for (const file of articles) {
      const body = file.raw.replace(/^---[\s\S]*?---\s*/u, '');
      if (/\\\(|\\\[/u.test(body)) problems.push(`${file.dirName}: MathJax delimiter`);
      const display = body.match(/^\$\$\n[\s\S]*?^\$\$$/gmu) ?? [];
      const open = (body.match(/^\$\$/gmu) ?? []).length;
      if (open !== display.length * 2) problems.push(`${file.dirName}: unbalanced $$`);
      displayBlocks += display.length;
      inlineMath += (body.match(/\$[^$\n]+\$/gu) ?? []).length;
    }
    // Curriculum này là toán học: cả hai dạng đều phải xuất hiện nhiều lần.
    expect([displayBlocks, inlineMath]).toEqual([expect.any(Number), expect.any(Number)]);
    expect(displayBlocks).toBeGreaterThan(CURRICULUM_SIZE);
    expect(inlineMath).toBeGreaterThan(CURRICULUM_SIZE);
  });

  it('cites primary sources by link in every research-typed lesson', () => {
    // `contentType` research-review/benchmark/experiment là lời hứa với người
    // đọc rằng bài đó dựa trên tài liệu có thể kiểm chứng. Schema zod không
    // enforce được (nó nhìn một file một lần), nên đây là nơi bắt nó.
    const scholarly = CURRICULUM.filter((article) =>
      ['research-review', 'benchmark', 'experiment'].includes(article.contentType),
    );
    expect(scholarly.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const article of scholarly) {
      const file = articles.find((candidate) => urlSlug(candidate.dirName) === article.slug);
      const body = (file?.raw ?? '').replace(/^---[\s\S]*?---\s*/u, '');
      const external = body.match(/\]\(https?:\/\/[^)]+\)/gu) ?? [];
      if (external.length === 0) problems.push(`${article.slug}: no external citation`);
    }
    expect(problems).toEqual([]);
  });

  it('does not emit any invented arXiv identifier', () => {
    // Một arXiv id sai không 404 lịch sự — nó trỏ tới một bài thật về chủ đề
    // khác, và người đọc kết luận trích dẫn là bịa. Danh sách dưới đây là các
    // id đã **kiểm tra tồn tại và đúng đề tài** trong lúc chuẩn bị curriculum.
    const VERIFIED_ARXIV = new Set([
      '1706.03762', // Attention Is All You Need
      '2001.08361', // Scaling Laws for Neural Language Models
      '2203.15556', // Training Compute-Optimal Large Language Models
      '2203.02155', // Training LMs to follow instructions with human feedback
      '2305.18290', // Direct Preference Optimization
      '2005.11401', // Retrieval-Augmented Generation for Knowledge-Intensive NLP
      '2309.06180', // Efficient Memory Management ... PagedAttention (vLLM)
      // Mỗi ID dưới đây đã được `tests/verify-citations.py` fetch trang abstract
      // thật và đối chiếu tên bài với nội dung bài học trích nó.
      '2109.01652', // Finetuned Language Models Are Zero-Shot Learners (FLAN)
      '1412.6980', // Adam: A Method for Stochastic Optimization
      '1711.05101', // Decoupled Weight Decay Regularization
      '1710.05941', // Searching for Activation Functions
      '1904.00962', // Large Batch Optimization for Deep Learning: Training BERT in 76 minutes
      '1512.03385', // Deep Residual Learning for Image Recognition
      '1810.04805', // BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding
      '1812.11118', // Reconciling modern machine-learning practice and the classical bias-variance trade-off
      '1912.02292', // Deep Double Descent: Where Bigger Models and More Data Hurt
      '1301.3781', // Efficient Estimation of Word Representations in Vector Space
      '1908.10084', // Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks
      '1702.08734', // Billion-scale similarity search with GPUs
      '1909.00512', // How Contextual are Contextualized Word Representations?
      '2107.06499', // Deduplicating Training Data Makes Language Models Better
      '2210.17323', // GPTQ: Accurate Post-Training Quantization for GPTs
      '2306.00978', // AWQ: Activation-aware Weight Quantization
      '2211.10438', // SmoothQuant: Accurate and Efficient PTQ for LLMs
      '2104.08663', // BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of IR Models
      '2210.07316', // MTEB: Massive Text Embedding Benchmark
      '2309.15217', // RAGAS: Automated Evaluation of Retrieval Augmented Generation
      '2004.12832', // ColBERT: Efficient and Effective Passage Search via Late Interaction
      '2004.04906', // Dense Passage Retrieval for Open-Domain Question Answering
    ]);
    const problems: string[] = [];
    for (const file of articles) {
      // Cả hai cách trích: URL đầy đủ và dạng `arXiv:2109.01652` trong văn bản.
      // Bỏ sót dạng thứ hai là lỗ hổng thật: một id sai viết dạng này không bao
      // giờ được kiểm tra, và nó xuất hiện trong chính lesson 08.
      const ids = [
        ...[...file.raw.matchAll(/https?:\/\/arxiv\.org\/abs\/([\w./]+)/gu)].map(
          (match) => match[1] ?? '',
        ),
        ...[...file.raw.matchAll(/\barXiv:(\d{4}\.\d{4,5})\b/gu)].map((match) => match[1] ?? ''),
      ];
      for (const id of ids) {
        if (!VERIFIED_ARXIV.has(id)) {
          problems.push(`${file.dirName}: unverified arXiv id ${id}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the production origin in one place for canonical URLs', () => {
    // Bảo hiểm nhỏ: nếu ai đó đổi origin canonical, bài này đỏ và buộc phải
    // cập nhật test theo, thay vì đổi âm thầm URL canonical của toàn site.
    expect(BLOG_PRODUCTION_ORIGIN).toBe('https://ecoma.io');
  });
});
