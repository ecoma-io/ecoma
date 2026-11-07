// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import type { BlogArticleSummary } from '~/blog/blog-articles';
import type { BlogUiStrings } from '~/blog/blog-ui-strings';
import { blogUiStrings } from '~/blog/blog-ui-strings';

/**
 * Render test cho các view component của blog — **trong jsdom**, qua
 * `@vue/test-utils` mount. Phạm vi: các nhánh render có điều kiện mà suite
 * static-output không với tới được, vì suite đó chỉ assert trên HTML của seed
 * hiện tại (blog không rỗng, cover luôn theo slug cụ thể):
 *
 * - landing **rỗng** vẫn có đúng một `<h1>` (không mất heading cấp một);
 * - landing có hero: đúng một `<h1>`, cover render với alt;
 * - card: có/không cover, link với aria-label, date theo locale prop;
 * - tag list: ẩn hẳn khi rỗng.
 *
 * Nuxt auto-import cung cấp `computed`/`NuxtLink`/`useRoute` như biến toàn
 * cục; ở đây chỉ có `@vitejs/plugin-vue`, nên: SFC import `computed` tường
 * minh (same pattern PublicShell của `app/layout`), `useRoute` stub qua
 * `vi.stubGlobal`, `NuxtLink` đăng ký stub qua mount option
 * `global.components`.
 */

/** Path mà `useRoute()` trả về — mount đọc giá trị hiện hành. */
const currentPath = '/en/blog';
vi.stubGlobal(
  'useRoute',
  () =>
    ({
      path: currentPath,
    }) as unknown as ReturnType<typeof useRoute>,
);

/**
 * Stub `NuxtLink` giữ đúng shape HTML prerender (`<a href>`): functional
 * component nhận prop `to` + slot default. Đăng ký qua mount option
 * `global.components` — component resolver, không phải biến toàn cục.
 */
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.());
  },
});

/** Options mount chung — NuxtLink resolve ở mọi tầng của cây. */
function mountOptions(props: Record<string, unknown>) {
  return {
    props,
    global: { components: { NuxtLink: NuxtLinkStub } },
  };
}

/** Landing props chuẩn — override theo từng test. */
function landingProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locale: 'en',
    featured: article({ path: '/en/blog/pick', featured: true }),
    secondaryLeads: [],
    rest: [],
    fallback: false,
    series: [],
    availableLocales: ['en'],
    ui: UI,
    ...overrides,
  };
}

/** Card props chuẩn — override theo từng test. */
function cardProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    article: article({ path: '/en/blog/a' }),
    locale: 'en',
    ui: UI,
    ...overrides,
  };
}

/** Fixture article — đủ field của `BlogArticleSummary`, override được. */
function article(overrides: Partial<BlogArticleSummary> & { path: string }): BlogArticleSummary {
  return {
    stem: `en/blog/${overrides.path.split('/').pop()}`,
    title: `Article at ${overrides.path}`,
    description: 'A short description',
    date: '2026-09-02',
    author: 'John Martin',
    tags: ['meta'],
    featured: false,
    ...overrides,
  };
}

const UI: BlogUiStrings = blogUiStrings('en');

let BlogLandingView: Component;
let BlogArticleCard: Component;
let BlogTagList: Component;
let BlogArticleToc: Component;
let BlogSeriesLandingView: Component;

beforeAll(async () => {
  // Dynamic import sau khi stub: import tĩnh bị ESM hoist lên trước `stubGlobal`.
  BlogLandingView = (
    (await import('~/components/blog/BlogLandingView.vue')) as {
      default: Component;
    }
  ).default;
  BlogArticleCard = (
    (await import('~/components/blog/BlogArticleCard.vue')) as {
      default: Component;
    }
  ).default;
  BlogTagList = (
    (await import('~/components/blog/BlogTagList.vue')) as {
      default: Component;
    }
  ).default;
  BlogArticleToc = (
    (await import('~/components/blog/BlogArticleToc.vue')) as {
      default: Component;
    }
  ).default;
  BlogSeriesLandingView = (
    (await import('~/components/blog/BlogSeriesLandingView.vue')) as {
      default: Component;
    }
  ).default;
});

describe('BlogLandingView', () => {
  it('renders exactly one h1 when the blog has a featured hero', async () => {
    const wrapper = mount(BlogLandingView, mountOptions(landingProps()));
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.find('h1').text()).toContain('Article at /en/blog/pick');
  });

  it('renders exactly one h1 with the surface name when the blog is empty', async () => {
    // Blog rỗng là landing hợp lệ — nhưng không được mất heading cấp một:
    // hierarchy cho screen reader và tín hiệu chủ đề cho SEO.
    const wrapper = mount(BlogLandingView, mountOptions(landingProps({ featured: undefined })));
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.find('h1').text()).toBe(UI.blog);
    expect(wrapper.text()).toContain(UI.latest);
  });

  it('renders one h1 per landing even when rest carries cards', async () => {
    const wrapper = mount(
      BlogLandingView,
      mountOptions(landingProps({ rest: [article({ path: '/en/blog/other' })] })),
    );
    expect(wrapper.findAll('h1')).toHaveLength(1);
  });

  it('labels the hero "Featured" only when the hero article is actually featured', async () => {
    // Fallback bài mới nhất không phải featured — gắn nhãn "Featured" cho bài
    // không featured là mô tả sai nội dung cho người đọc và screen reader.
    const fallbackHero = mount(
      BlogLandingView,
      mountOptions(
        landingProps({ featured: article({ path: '/en/blog/fallback', featured: false }) }),
      ),
    );
    expect(fallbackHero.text()).not.toContain(UI.featured);

    const featuredHero = mount(BlogLandingView, mountOptions(landingProps()));
    expect(featuredHero.text()).toContain(UI.featured);
  });

  it('renders the hero cover inside main with alt when present, no img when absent', async () => {
    const covered = article({
      path: '/en/blog/covered',
      featured: true,
      cover: { src: '/assets/cover-x.svg', alt: 'A real alt' },
    });
    const withCover = mount(BlogLandingView, mountOptions(landingProps({ featured: covered })));
    // `find('img')` đầu tiên là logo của header — cover của hero nằm trong
    // landmark `main`; giới hạn tìm kiếm vào đó.
    const img = withCover.find('main img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('/assets/cover-x.svg');
    expect(img.attributes('alt')).toBe('A real alt');

    const bare = mount(
      BlogLandingView,
      mountOptions(landingProps({ featured: article({ path: '/en/blog/bare', featured: true }) })),
    );
    expect(bare.find('main img').exists()).toBe(false);
  });

  it('recomputes the shell path when the locale prop changes', async () => {
    // Contract của PublicShell: chrome phản ứng khi path đổi — client-side
    // navigate /en/blog → /vi/blog tái dùng instance component, path phải
    // theo prop mới chứ không giữ snapshot lúc setup.
    const wrapper = mount(BlogLandingView, mountOptions(landingProps()));
    expect(wrapper.find('header a[href="/en/blog"]').exists()).toBe(true);
    await wrapper.setProps({ locale: 'vi', availableLocales: ['vi'] });
    expect(wrapper.find('header a[href="/vi/blog"]').exists()).toBe(true);
  });

  it('renders the fallback notice above the listing when fallback is true', async () => {
    // Fallback discovery: locale không có bài — thông báo tiếng địa phương phải
    // xuất hiện **trước** listing EN, để người đọc không hiểu bài tiếng Anh là
    // thiếu sót của locale họ.
    const wrapper = mount(BlogLandingView, mountOptions(landingProps({ fallback: true })));
    expect(wrapper.text()).toContain(UI.fallbackNotice);
  });

  it('renders no fallback notice on a normal landing', async () => {
    // Landing có bài thật không được mang thông báo fallback — hiển thị nó là
    // nói sai trạng thái content cho người đọc.
    const wrapper = mount(BlogLandingView, mountOptions(landingProps({ fallback: false })));
    expect(wrapper.text()).not.toContain(UI.fallbackNotice);
  });

  it('renders one series card per series with its overview link and article count', async () => {
    const wrapper = mount(
      BlogLandingView,
      mountOptions(
        landingProps({
          series: [
            {
              id: 'llm-foundations',
              meta: { title: 'LLM foundations', description: 'Foundations of LLMs.' },
              path: '/en/blog/series/llm-foundations',
              articleCount: 2,
            },
          ],
        }),
      ),
    );
    const link = wrapper.find('a[href="/en/blog/series/llm-foundations"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe('LLM foundations');
    expect(wrapper.text()).toContain(`2 ${UI.articlesUnit}`);
  });

  it('renders no series block when no series has published articles', async () => {
    // Series chưa có bài không được render khối rỗng — route đã lọc, component
    // khẳng định lại: vắng series là vắng cả section.
    const wrapper = mount(BlogLandingView, mountOptions(landingProps({ series: [] })));
    expect(wrapper.text()).not.toContain(UI.series);
  });
});

describe('BlogLandingView secondary leads', () => {
  it('renders each secondary lead title as an h2, keeping the single h1', async () => {
    // Ở `wide:`/`ultrawide:` hai lead phụ đứng cạnh hero, nhưng landing vẫn đúng
    // MỘT `<h1>` — tiêu đề bài featured. Hai bài phụ là nhánh ngang hàng, nên
    // `<h2>` chứ không phải `<h3>`.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(
        landingProps({
          secondaryLeads: [
            article({ path: '/en/blog/second' }),
            article({ path: '/en/blog/third' }),
          ],
        }),
      ),
    );
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.findAll('[data-secondary-leads] h2').map((heading) => heading.text())).toEqual([
      'Article at /en/blog/second',
      'Article at /en/blog/third',
    ]);
  });

  it('links each secondary lead once by title only, with no cover or meta', async () => {
    // Chỉ hiện tiêu đề: không cover (nếu render `<img>` thì mỗi bài thêm một
    // request ảnh cho một phần tử không mang thông tin), không mô tả, không
    // dòng ngày/tác giả. Fixture dùng description riêng cho lead phụ để phân
    // biệt với description của hero — cả hai đều dùng chung một giá trị mặc
    // định thì assertion "không mô tả" sẽ không kiểm được gì.
    const leads = [
      article({
        path: '/en/blog/second',
        description: 'Secondary description that must not render',
        cover: { src: '/assets/cover-y.svg', alt: 'Alt' },
      }),
      article({ path: '/en/blog/third', description: 'Another one not rendered' }),
    ];
    const wrapper = mount(BlogLandingView, mountOptions(landingProps({ secondaryLeads: leads })));
    for (const lead of leads) {
      const links = wrapper.findAll(`a[href="${lead.path}"]`);
      expect(links, `links to ${lead.path}`).toHaveLength(1);
      expect(links[0]?.attributes('aria-label')).toBe(`${lead.title} — ${UI.readMore}`);
    }
    // Cover chỉ của hero được render — không ảnh nào của lead phụ lọt vào DOM.
    const images = wrapper.findAll('main img').map((img) => img.attributes('src'));
    expect(images).not.toContain('/assets/cover-y.svg');
    // Cột phải chỉ có tiêu đề: không mô tả, không `<time>`, không tên tác giả.
    const column = wrapper.find('[data-secondary-leads]');
    expect(column.text()).not.toContain('Secondary description that must not render');
    expect(column.text()).not.toContain('Another one not rendered');
    expect(column.find('time').exists()).toBe(false);
  });

  it('keeps secondary leads visible below wide so no article drops off the landing', async () => {
    // Route đã cắt hai bài này ra khỏi `rest`, nên ẩn chúng ở ngưỡng hẹp
    // (`hidden wide:flex`) sẽ khiến chúng **không xuất hiện ở đâu cả** trên
    // landing dưới 1600px. Khối phải hiện ở mọi bề rộng; dưới `wide:` wrapper
    // không phải grid nên nó nằm ngay dưới hero.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(landingProps({ secondaryLeads: [article({ path: '/en/blog/second' })] })),
    );
    const column = wrapper.find('[data-secondary-leads]');
    expect(column.exists()).toBe(true);
    expect(column.classes()).not.toContain('hidden');
    // Link còn hiện ở ngưỡng hẹp — không chỉ nằm trong DOM cho crawler.
    expect(column.find('a[href="/en/blog/second"]').exists()).toBe(true);
  });

  it('renders no secondary column when the blog has nothing but the hero', async () => {
    // Blog chỉ có một bài: cột phải rỗng thì không render khối rỗng — vẫn là
    // landing hợp lệ, không có `<ul>`/`<div>` nào chờ nội dung.
    const wrapper = mount(BlogLandingView, mountOptions(landingProps()));
    expect(wrapper.find('[data-secondary-leads]').exists()).toBe(false);
  });
});

describe('BlogArticleCard', () => {
  it('renders title link with the read-more accessible name and meta row', async () => {
    const wrapper = mount(BlogArticleCard, mountOptions(cardProps()));
    const link = wrapper.find('a');
    expect(link.attributes('href')).toBe('/en/blog/a');
    expect(link.attributes('aria-label')).toBe('Article at /en/blog/a — Read more');
    expect(wrapper.text()).toContain('John Martin');
  });

  it('formats the date in the locale prop, not a composable snapshot', async () => {
    const wrapper = mount(
      BlogArticleCard,
      mountOptions(cardProps({ locale: 'vi', ui: blogUiStrings('vi') })),
    );
    // Tháng tiếng Việt không phải "September" — card phải đi theo locale
    // được truyền xuống, nguồn duy nhất của trang.
    expect(wrapper.find('time').text()).not.toContain('September');
  });

  it('renders the cover img when present and no img when absent', async () => {
    const withCover = mount(
      BlogArticleCard,
      mountOptions(
        cardProps({
          article: article({ path: '/en/blog/a', cover: { src: '/assets/c.svg', alt: 'Alt' } }),
        }),
      ),
    );
    expect(withCover.find('img').exists()).toBe(true);

    const without = mount(BlogArticleCard, mountOptions(cardProps()));
    expect(without.find('img').exists()).toBe(false);
  });
});

describe('BlogTagList', () => {
  it('renders one list item per tag with a distinct accessible name', () => {
    const wrapper = mount(BlogTagList, { props: { tags: ['meta', 'design'], label: 'Tags' } });
    expect(wrapper.findAll('li')).toHaveLength(2);
    // Component một-root (`<ul>`): attribute nằm trên wrapper root element.
    expect(wrapper.find('ul').attributes('aria-label')).toBe('Tags');
  });

  it('renders nothing when the tag list is empty', () => {
    // Danh sách có nhãn nhưng rỗng khiến screen reader đọc nhãn rồi dừng ở
    // vùng trống — ẩn hẳn là đúng.
    const wrapper = mount(BlogTagList, { props: { tags: [], label: 'Tags' } });
    expect(wrapper.find('ul').exists()).toBe(false);
  });
});

describe('BlogLandingView fallback discovery', () => {
  /** Inventory English — dùng làm nguồn khám phá cho landing VI rỗng. */
  const englishHero = article({ path: '/en/blog/pick', featured: true, title: 'An English hero' });
  const englishRest = [
    article({ path: '/en/blog/second', title: 'Another English article' }),
    article({ path: '/en/blog/third', title: 'A third English article' }),
  ];

  const VI = blogUiStrings('vi');

  it('renders the English hero and cards on a landing with no articles of its own', async () => {
    // **Trạng thái English-first đích danh**: landing `/vi/blog` khi chưa có bài
    // tiếng Việt vẫn phải khám phá được các bài English. Trước đây route lấy
    // featured/listing từ danh sách rỗng nên trang rơi về trạng thái rỗng — phát
    // hiện ra fallback rồi không còn gì để hiển thị.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(
        landingProps({
          locale: 'vi',
          fallback: true,
          featured: englishHero,
          rest: englishRest,
          ui: VI,
        }),
      ),
    );
    expect(wrapper.find('h1').text()).toContain('An English hero');
    expect(wrapper.find('a[href="/en/blog/second"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/en/blog/third"]').exists()).toBe(true);
  });

  it('points every card at a real English path, never a Vietnamese one', async () => {
    // Link `/vi/blog/<slug>` tới bài chưa tồn tại là link 404 — nguy hiểm hơn
    // nhiều so với việc không có card.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(
        landingProps({
          locale: 'vi',
          fallback: true,
          featured: englishHero,
          rest: englishRest,
          ui: VI,
        }),
      ),
    );
    const hrefs = wrapper.findAll('a').map((link) => link.attributes('href'));
    expect(hrefs.filter((href) => href !== undefined && href.startsWith('/vi/blog/'))).toEqual([]);
  });

  it('keeps the fallback notice visible alongside the English cards', async () => {
    // Thông báo và listing phải cùng tồn tại: chỉ có thông báo thì trang rỗng,
    // chỉ có listing thì người đọc tưởng bài tiếng Anh là thiếu sót của locale
    // họ đang đọc.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(landingProps({ locale: 'vi', fallback: true, rest: englishRest, ui: VI })),
    );
    expect(wrapper.text()).toContain(VI.fallbackNotice);
    expect(wrapper.find('a[href="/en/blog/second"]').exists()).toBe(true);
  });

  it('links an English-only series to its English overview, not a Vietnamese 404', async () => {
    // Series chỉ có bài EN. Route resolve path theo locale **thật sự có bài**
    // (`seriesLandingEntries`), nên card trên landing `/vi` trỏ
    // `/en/blog/series/...`. `/vi/blog/series/...` sẽ 404 vì route series cần
    // ít nhất một bài published ở chính locale đó.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(
        landingProps({
          locale: 'vi',
          fallback: true,
          series: [
            {
              id: 'llm-foundations',
              meta: { title: 'LLM foundations', description: 'Foundations of LLMs.' },
              path: '/en/blog/series/llm-foundations',
              articleCount: 2,
            },
          ],
          ui: VI,
        }),
      ),
    );
    expect(wrapper.find('a[href="/en/blog/series/llm-foundations"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/vi/blog/series/llm-foundations"]').exists()).toBe(false);
  });

  it('offers the Vietnamese discovery landing in the switcher even with no Vietnamese articles', async () => {
    // Availability của switcher suy từ **route** (landing là route tĩnh của mount,
    // tồn tại ở mọi registry locale), không suy từ số bài: biến mất đúng lúc
    // landing là surface duy nhất còn lại thì vô lý.
    const wrapper = mount(
      BlogLandingView,
      mountOptions(
        landingProps({ locale: 'vi', fallback: true, availableLocales: ['en', 'vi'], ui: VI }),
      ),
    );
    expect(wrapper.find('header a[href="/vi/blog"]').exists()).toBe(true);
  });
});

describe('BlogSeriesLandingView', () => {
  it('renders the series title, description and its articles in learning order', async () => {
    const wrapper = mount(
      BlogSeriesLandingView,
      mountOptions({
        locale: 'en',
        seriesId: 'llm-foundations',
        meta: { title: 'LLM foundations', description: 'Foundations, article by article.' },
        articles: [
          article({ path: '/en/blog/one', title: 'First lesson' }),
          article({ path: '/en/blog/two', title: 'Second lesson' }),
        ],
        availableLocales: ['en'],
        ui: UI,
      }),
    );
    expect(wrapper.find('h1').text()).toContain('LLM foundations');
    expect(wrapper.text()).toContain('Foundations, article by article.');
    expect(wrapper.text()).toContain(UI.seriesContents);
    const links = wrapper.findAll('h3 a').map((link) => link.attributes('href'));
    expect(links).toEqual(['/en/blog/one', '/en/blog/two']);
  });
});

/** TOC shape của `@nuxt/content` — chỉ `links` là thứ component đọc. */
function toc(headings: readonly { id: string; text: string }[]) {
  return {
    id: '',
    depth: 1,
    links: headings.map((heading) => ({ ...heading, depth: 2, children: [] })),
  };
}

describe('BlogArticleToc', () => {
  it('renders nothing for an article below the heading threshold', async () => {
    // Ngưỡng của component là 3 h2. Bài ngắn hơn thì TOC chỉ lặp lại cấu trúc
    // của chính bài đọc — và khối rỗng là xấu. Fixture **tự dựng** nên assert
    // này đúng bất biến của component, không phụ thuộc bài nào đang tồn tại
    // trong content thật.
    const wrapper = mount(
      BlogArticleToc,
      mountOptions({
        toc: toc([
          { id: 'first', text: 'First heading' },
          { id: 'second', text: 'Second heading' },
        ]),
        label: UI.tableOfContents,
      }),
    );
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.html()).toBe('<!--v-if-->');
  });

  it('renders the table of contents at exactly the heading threshold', async () => {
    const wrapper = mount(
      BlogArticleToc,
      mountOptions({
        toc: toc([
          { id: 'first', text: 'First heading' },
          { id: 'second', text: 'Second heading' },
          { id: 'third', text: 'Third heading' },
        ]),
        label: UI.tableOfContents,
      }),
    );
    expect(wrapper.find('details').exists()).toBe(true);
    expect(wrapper.findAll('a')).toHaveLength(3);
    expect(wrapper.find('summary').text()).toBe(UI.tableOfContents);
  });

  it('ignores headings deeper than level two', async () => {
    // Component chỉ lấy h2: TOC gọn cho cột đọc hẹp. Ba h3 không đủ ngưỡng.
    const deep = {
      id: '',
      depth: 1,
      links: [
        { id: 'a', text: 'A', depth: 3, children: [] },
        { id: 'b', text: 'B', depth: 3, children: [] },
        { id: 'c', text: 'C', depth: 3, children: [] },
      ],
    };
    const wrapper = mount(BlogArticleToc, mountOptions({ toc: deep, label: UI.tableOfContents }));
    expect(wrapper.find('details').exists()).toBe(false);
  });

  it('renders no table of contents at all when the article has none', async () => {
    // `page.body.toc` là `undefined` khi bài không có heading nào đủ để sinh
    // TOC — component không được crash và không được render khung rỗng.
    const wrapper = mount(
      BlogArticleToc,
      mountOptions({ toc: undefined, label: UI.tableOfContents }),
    );
    expect(wrapper.find('details').exists()).toBe(false);
  });

  it('points every table-of-contents link at a real heading id in the article body', async () => {
    // Anchor chết trong TOC là lỗi điều hướng thật: người đọc bấm xong không
    // đến đâu. Assert theo đúng cơ chế renderer gắn id lên heading.
    const headings = [
      { id: 'compression', text: 'The compression idea' },
      { id: 'why-it-matters', text: 'Why this matters downstream' },
      { id: 'summary', text: 'Summary' },
    ];
    const tocWrapper = mount(
      BlogArticleToc,
      mountOptions({ toc: toc(headings), label: UI.tableOfContents }),
    );
    const renderedIds = tocWrapper
      .findAll('a')
      .map((link) => (link.attributes('href') ?? '').replace(/^#/u, ''));
    expect(renderedIds).toEqual(headings.map((heading) => heading.id));
  });

  it('gives the TOC nav an accessible name distinct from the other navs on the page', async () => {
    // Trang article có nhiều `<nav>` (global, pager, prerequisites, series).
    // TOC cần tên riêng, nếu không screen reader đọc chung là "navigation".
    const wrapper = mount(
      BlogArticleToc,
      mountOptions({
        toc: toc([
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
          { id: 'c', text: 'C' },
        ]),
        label: UI.tableOfContents,
      }),
    );
    expect(wrapper.find('nav').attributes('aria-label')).toBe(UI.tableOfContents);
  });
});
