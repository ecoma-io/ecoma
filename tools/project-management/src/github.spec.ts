import { createGitHubPort, GitHubPortError, type FetchLike, type ResponseLike } from './github.js';

type QueryKind = 'issues' | 'items' | 'add' | 'remove';

interface FakeCall {
  kind: QueryKind;
  attempt: number;
  variables: Record<string, unknown>;
}

type RouteFn = (call: FakeCall) => ResponseLike | Error;

function queryKind(query: string): QueryKind {
  if (query.includes('addProjectV2ItemById')) {
    return 'add';
  }
  if (query.includes('removeProjectV2ItemById')) {
    return 'remove';
  }
  if (query.includes('repository(')) {
    return 'issues';
  }
  return 'items';
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  const lowercased: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lowercased[name.toLowerCase()] = value;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowercased[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function statusResponse(status: number, headers: Record<string, string> = {}): ResponseLike {
  return jsonResponse(status, { message: 'status-only response' }, headers);
}

function issuesPayload(page: {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}): unknown {
  return {
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          nodes: page.nodes,
        },
      },
    },
  };
}

function itemsPayload(
  page: { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null },
  projectId = 'proj_13',
): unknown {
  return {
    data: {
      organization: {
        projectV2: {
          id: projectId,
          items: {
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
            nodes: page.nodes,
          },
        },
      },
    },
  };
}

function rawIssue(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `Issue_${String(number)}`,
    number,
    title: `Issue ${String(number)}`,
    state: 'OPEN',
    author: { login: 'johnitvn' },
    parent: null,
    labels: { nodes: [] },
    milestone: null,
    ...overrides,
  };
}

function rawItem(
  itemId: string,
  type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE',
  content: Record<string, unknown> | null,
): Record<string, unknown> {
  return { id: itemId, type, isArchived: false, content };
}

interface FakeFetchOptions {
  issues?: RouteFn;
  items?: RouteFn;
  add?: RouteFn;
  remove?: RouteFn;
}

function createFakeFetch(routes: FakeFetchOptions): { fetchImpl: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const attempts: Record<QueryKind, number> = { issues: 0, items: 0, add: 0, remove: 0 };
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const kind = queryKind(body.query);
    attempts[kind] += 1;
    const call: FakeCall = { kind, attempt: attempts[kind], variables: body.variables };
    calls.push(call);
    const route = routes[kind];
    if (route === undefined) {
      throw new Error(`fake fetch received an unexpected ${kind} query`);
    }
    const result = route(call);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { fetchImpl, calls };
}

/** Hình dạng một trang giả cho route phân trang (issues hoặc project items). */
interface FakePage {
  after: string | null;
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Route đọc trang theo cursor: mỗi trang khai báo cursor `after` của nó. */
function pagedIssuesRoute(pages: FakePage[]): RouteFn {
  const byCursor = new Map(pages.map((page) => [page.after, page]));
  return ({ variables }) => {
    const cursor = variables['cursor'];
    const page = byCursor.get(typeof cursor === 'string' ? cursor : null);
    if (page === undefined) {
      throw new Error(`fake issues route received unknown cursor ${String(cursor)}`);
    }
    return jsonResponse(200, issuesPayload(page));
  };
}

function singleIssuePage(nodes: unknown[]): RouteFn {
  return pagedIssuesRoute([{ after: null, nodes, hasNextPage: false, endCursor: null }]);
}

function singleItemsPage(nodes: unknown[], projectId?: string): RouteFn {
  return ({ variables }) => {
    const cursor = variables['cursor'];
    if (cursor !== null && cursor !== undefined) {
      throw new Error(`fake items route received an unexpected cursor ${String(cursor)}`);
    }
    return jsonResponse(
      200,
      itemsPayload({ nodes, hasNextPage: false, endCursor: null }, projectId),
    );
  };
}

/** Route kịch bản tuần tự: entry thứ n cho lần gọi thứ n, entry cuối lặp lại. */
function sequentialRoute(entries: Array<ResponseLike | Error>): RouteFn {
  return ({ attempt }) => {
    const index = Math.min(attempt - 1, entries.length - 1);
    const entry = entries[index];
    if (entry === undefined) {
      throw new Error('sequential route has no entries');
    }
    return entry;
  };
}

function makePort(overrides: Partial<Parameters<typeof createGitHubPort>[0]> = {}) {
  const waits: number[] = [];
  const port = createGitHubPort({
    token: 'test-token',
    owner: 'ecoma-io',
    repo: 'ecoma-io/ecoma',
    projectNumber: 13,
    maxRetries: 3,
    delayMs: async (ms) => {
      waits.push(ms);
    },
    nowMs: () => 1_000_000,
    ...overrides,
  });
  return { port, waits };
}

it('paginates issues and project items across pages until hasNextPage is false', async () => {
  const issuePages: FakePage[] = Array.from({ length: 3 }, (_, pageIndex) => ({
    after: pageIndex === 0 ? null : `cursor-issues-${String(pageIndex)}`,
    nodes: Array.from({ length: 100 }, (_index, i) => rawIssue(pageIndex * 100 + i + 1)),
    // Cả ba trang đầy đều khai báo còn trang tiếp; trang cuối thật sự là trang
    // riêng push bên dưới — đúng hình dạng phân trang của GitHub GraphQL.
    hasNextPage: true,
    endCursor: `cursor-issues-${String(pageIndex + 1)}`,
  }));
  issuePages.push({
    after: 'cursor-issues-3',
    nodes: [rawIssue(301)],
    hasNextPage: false,
    endCursor: null,
  });
  const itemPages = [
    {
      after: null,
      nodes: [rawItem('item_1', 'ISSUE', { __typename: 'Issue', number: 1 })],
      hasNextPage: true,
      endCursor: 'cursor-items-1',
    },
    {
      after: 'cursor-items-1',
      nodes: [rawItem('item_2', 'PULL_REQUEST', { __typename: 'PullRequest', number: 42 })],
      hasNextPage: false,
      endCursor: null,
    },
  ];
  const { fetchImpl, calls } = createFakeFetch({
    issues: pagedIssuesRoute(issuePages),
    items: ({ variables }) => {
      const cursor = variables['cursor'];
      const page = cursor === null || cursor === undefined ? itemPages[0] : itemPages[1];
      if (page === undefined) {
        throw new Error(`fake items route received unknown cursor ${String(cursor)}`);
      }
      return jsonResponse(200, itemsPayload(page));
    },
  });
  const { port } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(true);
  expect(discovery.issues).toHaveLength(301);
  expect(discovery.issues[300]).toMatchObject({ number: 301, nodeId: 'Issue_301' });
  expect(discovery.projectItems).toEqual([
    { itemId: 'item_1', contentType: 'ISSUE', contentNumber: 1, isArchived: false },
    { itemId: 'item_2', contentType: 'PULL_REQUEST', contentNumber: 42, isArchived: false },
  ]);
  const issueCalls = calls.filter((call) => call.kind === 'issues');
  expect(issueCalls).toHaveLength(4);
  expect(issueCalls.map((call) => call.variables['cursor'])).toEqual([
    null,
    'cursor-issues-1',
    'cursor-issues-2',
    'cursor-issues-3',
  ]);
});

it('retries a 502 and succeeds on the next attempt', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    issues: sequentialRoute([
      statusResponse(502),
      jsonResponse(
        200,
        issuesPayload({ nodes: [rawIssue(1)], hasNextPage: false, endCursor: null }),
      ),
    ]),
    items: singleItemsPage([]),
  });
  const { port, waits } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(true);
  expect(discovery.issues).toHaveLength(1);
  const issueAttempts = calls.filter((call) => call.kind === 'issues').length;
  expect(issueAttempts).toBe(2);
  // Backoff exponential: lần 1 chờ 500ms trước lần thử thứ hai.
  expect(waits).toContain(500);
});

it('honors the retry-after header on a 429 response', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    issues: sequentialRoute([
      statusResponse(429, { 'Retry-After': '3' }),
      jsonResponse(
        200,
        issuesPayload({ nodes: [rawIssue(1)], hasNextPage: false, endCursor: null }),
      ),
    ]),
    items: singleItemsPage([]),
  });
  const { port, waits } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(true);
  expect(waits[0]).toBe(3000);
  const issueAttempts = calls.filter((call) => call.kind === 'issues').length;
  expect(issueAttempts).toBe(2);
});

it('honors the x-ratelimit-reset header relative to the injected clock', async () => {
  // nowMs trả 1_000_000ms; reset ở epoch giây 1004 = 1_004_000ms → chờ 4000ms.
  const { fetchImpl } = createFakeFetch({
    issues: sequentialRoute([
      statusResponse(429, { 'x-ratelimit-reset': '1004' }),
      jsonResponse(200, issuesPayload({ nodes: [], hasNextPage: false, endCursor: null })),
    ]),
    items: singleItemsPage([]),
  });
  const { port, waits } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(true);
  expect(waits[0]).toBe(4000);
});

it('gives up after max attempts and reports incomplete discovery without throwing', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    issues: sequentialRoute([statusResponse(502)]),
    items: sequentialRoute([statusResponse(502)]),
  });
  const { port } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(false);
  expect(discovery.issues).toEqual([]);
  expect(discovery.projectItems).toEqual([]);
  expect(calls.filter((call) => call.kind === 'issues')).toHaveLength(3);
  expect(calls.filter((call) => call.kind === 'items')).toHaveLength(3);
});

it('fails a read immediately on a non-retryable status without burning retries', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    issues: sequentialRoute([statusResponse(401)]),
    items: singleItemsPage([]),
  });
  const { port } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(false);
  expect(calls.filter((call) => call.kind === 'issues')).toHaveLength(1);
});

it('treats malformed issue nodes as incomplete discovery after exhausting retries', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    // Node thiếu title/state — payload 200 hợp lệ về HTTP nhưng sai hình dạng.
    issues: sequentialRoute([
      jsonResponse(
        200,
        issuesPayload({
          nodes: [{ id: 'Issue_1', number: 1 }],
          hasNextPage: false,
          endCursor: null,
        }),
      ),
    ]),
    items: singleItemsPage([]),
  });
  const { port } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(false);
  expect(discovery.issues).toEqual([]);
  expect(calls.filter((call) => call.kind === 'issues')).toHaveLength(3);
});

it('rejects refetchProjectItems when the items read keeps failing', async () => {
  const { fetchImpl } = createFakeFetch({
    items: sequentialRoute([statusResponse(503)]),
  });
  const { port } = makePort({ fetchImpl });
  await expect(port.refetchProjectItems()).rejects.toBeInstanceOf(GitHubPortError);
});

it('returns a partial snapshot with complete=false when a later items page keeps failing', async () => {
  // Trang đầu đọc ok, trang hai 503 hết retries: refetch không throw nữa mà
  // trả phần đã đọc kèm complete: false — verify thấy inventory_incomplete
  // thay vì fail toàn bộ lần đọc.
  const { fetchImpl } = createFakeFetch({
    items: ({ variables, attempt }) => {
      const cursor = variables['cursor'];
      if (cursor === null || cursor === undefined) {
        return jsonResponse(
          200,
          itemsPayload({
            nodes: [rawItem('item_p1', 'ISSUE', { __typename: 'Issue', number: 1 })],
            hasNextPage: true,
            endCursor: 'c1',
          }),
        );
      }
      void attempt;
      return statusResponse(503);
    },
  });
  const { port } = makePort({ fetchImpl });
  const snapshot = await port.refetchProjectItems();
  expect(snapshot.complete).toBe(false);
  expect(snapshot.items.map((item) => item.itemId)).toEqual(['item_p1']);
  expect(snapshot.error).toContain('503');
});

it('returns a complete snapshot when every items page reads through', async () => {
  const { fetchImpl } = createFakeFetch({
    items: ({ variables }) => {
      const cursor = variables['cursor'];
      if (cursor === null || cursor === undefined) {
        return jsonResponse(
          200,
          itemsPayload({
            nodes: [rawItem('item_p1', 'ISSUE', { __typename: 'Issue', number: 1 })],
            hasNextPage: true,
            endCursor: 'c1',
          }),
        );
      }
      return jsonResponse(
        200,
        itemsPayload({
          nodes: [rawItem('item_p2', 'ISSUE', { __typename: 'Issue', number: 2 })],
          hasNextPage: false,
          endCursor: null,
        }),
      );
    },
  });
  const { port } = makePort({ fetchImpl });
  const snapshot = await port.refetchProjectItems();
  expect(snapshot.complete).toBe(true);
  expect(snapshot.error).toBeNull();
  expect(snapshot.items).toHaveLength(2);
});

it('adds and removes items through mutations using the discovered project id', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    issues: singleIssuePage([rawIssue(5)]),
    items: singleItemsPage(
      [rawItem('item_seed', 'ISSUE', { __typename: 'Issue', number: 1 })],
      'proj_13',
    ),
    add: () => jsonResponse(200, { data: { addProjectV2ItemById: { item: { id: 'PVTI_new' } } } }),
    remove: () =>
      jsonResponse(200, { data: { removeProjectV2ItemById: { removedItemId: 'item_seed' } } }),
  });
  const { port } = makePort({ fetchImpl });
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(true);
  await expect(port.addItem('Issue_5')).resolves.toBe('PVTI_new');
  await expect(port.removeItem('item_seed')).resolves.toBeUndefined();
  const addCall = calls.find((call) => call.kind === 'add');
  expect(addCall).toMatchObject({ variables: { projectId: 'proj_13', contentId: 'Issue_5' } });
  const removeCall = calls.find((call) => call.kind === 'remove');
  expect(removeCall).toMatchObject({ variables: { projectId: 'proj_13', itemId: 'item_seed' } });
});

it('refuses mutations before discovery has captured the project id', async () => {
  const { port } = makePort({ fetchImpl: () => Promise.resolve(statusResponse(401)) });
  // discoverAll không ném (fail-closed qua complete=false) nhưng không bắt được
  // project id → mutation phải từ chối rõ ràng thay vì gọi API mù.
  const discovery = await port.discoverAll();
  expect(discovery.complete).toBe(false);
  await expect(port.addItem('Issue_5')).rejects.toThrow('project id is unknown');
  await expect(port.removeItem('item_1')).rejects.toThrow('project id is unknown');
});
