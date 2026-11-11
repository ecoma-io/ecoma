/**
 * GitHubPort: cổng GraphQL duy nhất của pipeline tới GitHub API, dùng plain
 * `fetch` (không dependency runtime mới). Endpoint: api.github.com/graphql.
 *
 * Retry engine: 502/503/429, rate-limit (theo `retry-after` / `x-ratelimit-reset`)
 * và network error được retry exponential backoff; lỗi 401/403/404 và GraphQL
 * error thường là vĩnh viễn, fail ngay. Dữ liệu malformed cũng được retry —
 * sau khi cạn retry, lần đọc đó fail → `discoverAll` trả `complete: false`
 * (fail-closed, pipeline không audit/apply trên inventory một phần).
 *
 * Mutation (add/remove item) được retry an toàn: addProjectV2ItemById là
 * idempotent với cùng content, removeProjectV2ItemById bỏ qua item vắng.
 */

import type { NormalizedIssue, ProjectItemContentType, ProjectItemRecord } from './types.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const RETRYABLE_STATUS = new Set<number>([502, 503, 429]);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Trần thời gian chờ theo rate-limit header để không treo job CI quá lâu. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const ISSUES_PAGE_SIZE = 100;
const ITEMS_PAGE_SIZE = 100;

/** Response fetch tối giản đủ dùng cho port và cho fake trong test. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface DiscoveryResult {
  issues: NormalizedIssue[];
  projectItems: ProjectItemRecord[];
  /**
   * false khi bất kỳ trang nào lỗi hoặc malformed sau retries — consumer phải
   * fail closed, không được audit/apply trên inventory một phần.
   */
  complete: boolean;
}

export interface GitHubPort {
  discoverAll(): Promise<DiscoveryResult>;
  /** Thêm issue vào Project, trả về itemId mới. */
  addItem(issueNodeId: string): Promise<string>;
  removeItem(itemId: string): Promise<void>;
  /** Đọc lại snapshot item của Project sau mutation — nguồn verify độc lập. */
  refetchProjectItems(): Promise<ProjectItemRecord[]>;
}

export interface GitHubPortOptions {
  token: string;
  owner: string;
  repo: string;
  projectNumber: number;
  fetchImpl?: FetchLike;
  /** Số lần thử tối đa cho mỗi request (mặc định 3). */
  maxRetries?: number;
  /** Chờ sleep — inject để test không chờ thật. */
  delayMs?: (ms: number) => Promise<void>;
  /** Đồng hồ — inject để test `x-ratelimit-reset` deterministic. */
  nowMs?: () => number;
}

/** Lỗi request GitHub. `retryable` chỉ ra lỗi có đáng retry hay không. */
export class GitHubPortError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'GitHubPortError';
    this.retryable = retryable;
  }
}

interface PageResult<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GraphQLDeps {
  fetchImpl: FetchLike;
  token: string;
  maxRetries: number;
  delayMs: (ms: number) => Promise<void>;
  nowMs: () => number;
}

const ISSUES_QUERY = `
query Issues($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: ${ISSUES_PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        title
        state
        author { login }
        parent { number }
        labels(first: 50) { nodes { name } }
        milestone { number }
      }
    }
  }
}
`;

const PROJECT_ITEMS_QUERY = `
query ProjectItems($org: String!, $number: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      items(first: ${ITEMS_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          type
          isArchived
          content {
            __typename
            ... on Issue { number }
            ... on PullRequest { number }
          }
        }
      }
    }
  }
}
`;

const ADD_ITEM_MUTATION = `
mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item { id }
  }
}
`;

const REMOVE_ITEM_MUTATION = `
mutation RemoveProjectItem($projectId: ID!, $itemId: ID!) {
  removeProjectV2ItemById(input: {projectId: $projectId, itemId: $itemId}) {
    removedItemId
  }
}
`;

// --- Narrowing helpers cho dữ liệu `unknown` từ GraphQL. ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readGraphQLErrors(body: unknown): unknown[] {
  const bodyRecord = asRecord(body);
  if (bodyRecord === null) {
    return [];
  }
  return asArray(bodyRecord['errors']) ?? [];
}

function isRateLimitedError(error: unknown): boolean {
  const record = asRecord(error);
  return record !== null && record['type'] === 'RATE_LIMITED';
}

function readData(body: unknown): Record<string, unknown> | null {
  const bodyRecord = asRecord(body);
  if (bodyRecord === null) {
    return null;
  }
  return asRecord(bodyRecord['data']);
}

async function backoffSleep(deps: GraphQLDeps, attempt: number): Promise<void> {
  const waitMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  await deps.delayMs(waitMs);
}

/** Chờ theo rate-limit header nếu có, ngược lại dùng exponential backoff. */
async function rateLimitSleep(
  deps: GraphQLDeps,
  headers: ResponseLike['headers'],
  attempt: number,
): Promise<void> {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      await deps.delayMs(Math.min(seconds * 1000, MAX_RATE_LIMIT_WAIT_MS));
      return;
    }
  }
  const resetEpochSeconds = headers.get('x-ratelimit-reset');
  if (resetEpochSeconds !== null) {
    const resetEpochMs = Number(resetEpochSeconds) * 1000;
    if (Number.isFinite(resetEpochMs)) {
      const waitMs = Math.max(0, resetEpochMs - deps.nowMs());
      await deps.delayMs(Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS));
      return;
    }
  }
  await backoffSleep(deps, attempt);
}

/**
 * Thực thi một GraphQL document với toàn bộ retry policy, rồi đọc hình dạng
 * dữ liệu qua `readShape`. `readShape` ném GitHubPortError retryable khi dữ
 * liệu malformed — lỗi này được retry như lỗi vận chuyển.
 */
async function executeGraphQl<T>(
  deps: GraphQLDeps,
  query: string,
  variables: Record<string, unknown>,
  readShape: (data: Record<string, unknown>) => T,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const isLastAttempt = attempt >= deps.maxRetries;
    let response: ResponseLike;
    try {
      response = await deps.fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ecoma-io-project-management',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      const error = new GitHubPortError(
        `network error talking to GitHub GraphQL: ${errorMessage(cause)}`,
        true,
      );
      if (isLastAttempt) {
        throw error;
      }
      await backoffSleep(deps, attempt);
      continue;
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      const error = new GitHubPortError(
        `GitHub GraphQL responded HTTP ${String(response.status)}`,
        true,
      );
      if (isLastAttempt) {
        throw error;
      }
      await rateLimitSleep(deps, response.headers, attempt);
      continue;
    }
    if (!response.ok) {
      throw new GitHubPortError(
        `GitHub GraphQL responded HTTP ${String(response.status)} (non-retryable)`,
        false,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      const error = new GitHubPortError(
        `GitHub GraphQL returned a non-JSON body: ${errorMessage(cause)}`,
        true,
      );
      if (isLastAttempt) {
        throw error;
      }
      await backoffSleep(deps, attempt);
      continue;
    }
    const errors = readGraphQLErrors(body);
    if (errors.length > 0) {
      if (errors.some((error) => isRateLimitedError(error))) {
        const rateLimitError = new GitHubPortError('GitHub GraphQL rate-limited the request', true);
        if (isLastAttempt) {
          throw rateLimitError;
        }
        await rateLimitSleep(deps, response.headers, attempt);
        continue;
      }
      const firstMessage =
        errors
          .map((error) => asRecord(error))
          .map((record) => (record === null ? null : asString(record['message'])))
          .find((message) => message !== null) ?? 'unknown GraphQL error';
      throw new GitHubPortError(`GitHub GraphQL returned errors: ${firstMessage}`, false);
    }
    const data = readData(body);
    if (data === null) {
      const error = new GitHubPortError('GitHub GraphQL response carries no data', true);
      if (isLastAttempt) {
        throw error;
      }
      await backoffSleep(deps, attempt);
      continue;
    }
    try {
      return readShape(data);
    } catch (cause) {
      if (cause instanceof GitHubPortError && !cause.retryable) {
        throw cause;
      }
      if (isLastAttempt) {
        throw cause;
      }
      await backoffSleep(deps, attempt);
      continue;
    }
  }
}

function malformed(detail: string): GitHubPortError {
  return new GitHubPortError(`GitHub GraphQL page is malformed: ${detail}`, true);
}

function readPageInfo(connection: Record<string, unknown>): {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const pageInfo = asRecord(connection['pageInfo']);
  const nodes = asArray(connection['nodes']);
  if (pageInfo === null || nodes === null) {
    throw malformed('pageInfo or nodes is missing');
  }
  const hasNextPage = asBoolean(pageInfo['hasNextPage']);
  if (hasNextPage === null) {
    throw malformed('pageInfo.hasNextPage is not a boolean');
  }
  if (!hasNextPage) {
    return { nodes, hasNextPage, endCursor: null };
  }
  const endCursor = asString(pageInfo['endCursor']);
  if (endCursor === null) {
    throw malformed('pageInfo.endCursor is missing on a paginated page');
  }
  return { nodes, hasNextPage, endCursor };
}

/** Đọc một trang issues; mọi node sai hình dạng đều là lỗi malformed (retryable). */
function readIssuesPage(data: Record<string, unknown>): PageResult<NormalizedIssue> {
  const repository = asRecord(data['repository']);
  const connection = repository === null ? null : asRecord(repository['issues']);
  if (connection === null) {
    throw malformed('repository.issues is missing (wrong owner/repo?)');
  }
  const page = readPageInfo(connection);
  const issues: NormalizedIssue[] = page.nodes.map((raw): NormalizedIssue => {
    const node = asRecord(raw);
    if (node === null) {
      throw malformed('issue node is not an object');
    }
    const nodeId = asString(node['id']);
    const number = asNumber(node['number']);
    const title = asString(node['title']);
    const state = node['state'];
    if (
      nodeId === null ||
      number === null ||
      title === null ||
      (state !== 'OPEN' && state !== 'CLOSED')
    ) {
      throw malformed('issue node has an invalid id, number, title or state');
    }
    const author = asRecord(node['author']);
    const authorLogin = author === null ? '' : (asString(author['login']) ?? '');
    const parent = asRecord(node['parent']);
    let parentNumber: number | null = null;
    if (parent !== null) {
      parentNumber = asNumber(parent['number']);
      if (parentNumber === null) {
        throw malformed('issue parent has no number');
      }
    }
    const labelsConnection = asRecord(node['labels']);
    const labelNodes = labelsConnection === null ? null : asArray(labelsConnection['nodes']);
    if (labelNodes === null) {
      throw malformed('issue labels connection is missing');
    }
    const labels = labelNodes.map((rawLabel): string => {
      const label = asRecord(rawLabel);
      const name = label === null ? null : asString(label['name']);
      if (name === null) {
        throw malformed('issue label has no name');
      }
      return name;
    });
    const milestone = asRecord(node['milestone']);
    let milestoneNumber: number | null = null;
    if (milestone !== null) {
      milestoneNumber = asNumber(milestone['number']);
      if (milestoneNumber === null) {
        throw malformed('issue milestone has no number');
      }
    }
    return {
      number,
      nodeId,
      title,
      state,
      authorLogin,
      isPullRequest: false,
      parentNumber,
      // Port thật không query sub-issues (xem README hạn chế đã biết).
      subIssueNumbers: [],
      labels,
      milestoneNumber,
    };
  });
  return { nodes: issues, hasNextPage: page.hasNextPage, endCursor: page.endCursor };
}

function readProjectItemsPage(
  data: Record<string, unknown>,
  onProjectId: (projectId: string) => void,
): PageResult<ProjectItemRecord> {
  const organization = asRecord(data['organization']);
  const project = organization === null ? null : asRecord(organization['projectV2']);
  if (project === null) {
    throw malformed('organization.projectV2 is missing (wrong org or project number?)');
  }
  const projectId = asString(project['id']);
  if (projectId === null) {
    throw malformed('projectV2.id is missing');
  }
  onProjectId(projectId);
  const items = asRecord(project['items']);
  if (items === null) {
    throw malformed('projectV2.items is missing');
  }
  const page = readPageInfo(items);
  const records: ProjectItemRecord[] = page.nodes.map((raw): ProjectItemRecord => {
    const node = asRecord(raw);
    if (node === null) {
      throw malformed('project item node is not an object');
    }
    const itemId = asString(node['id']);
    const contentTypeValue = node['type'];
    const isArchived = asBoolean(node['isArchived']);
    if (itemId === null || isArchived === null) {
      throw malformed('project item has an invalid id or isArchived');
    }
    if (
      contentTypeValue !== 'ISSUE' &&
      contentTypeValue !== 'PULL_REQUEST' &&
      contentTypeValue !== 'DRAFT_ISSUE'
    ) {
      throw malformed(`project item has an unknown type "${String(contentTypeValue)}"`);
    }
    const contentType: ProjectItemContentType = contentTypeValue;
    let contentNumber: number | null = null;
    const content = asRecord(node['content']);
    if (content !== null) {
      const rawNumber = asNumber(content['number']);
      if (rawNumber !== null) {
        contentNumber = rawNumber;
      } else if (contentType !== 'DRAFT_ISSUE') {
        throw malformed(`project item of type ${contentType} has content without a number`);
      }
    }
    return { itemId, contentType, contentNumber, isArchived };
  });
  return { nodes: records, hasNextPage: page.hasNextPage, endCursor: page.endCursor };
}

function readAddedItemId(data: Record<string, unknown>): string {
  const mutation = asRecord(data['addProjectV2ItemById']);
  const item = mutation === null ? null : asRecord(mutation['item']);
  const itemId = item === null ? null : asString(item['id']);
  if (itemId === null) {
    throw new GitHubPortError('addProjectV2ItemById returned no item id', true);
  }
  return itemId;
}

function readRemovedItemId(data: Record<string, unknown>): void {
  const mutation = asRecord(data['removeProjectV2ItemById']);
  if (mutation === null) {
    throw new GitHubPortError('removeProjectV2ItemById returned no payload', true);
  }
  const removedItemId = mutation['removedItemId'];
  if (removedItemId !== null && removedItemId !== undefined && asString(removedItemId) === null) {
    throw new GitHubPortError('removeProjectV2ItemById returned a malformed removedItemId', true);
  }
}

async function readAllPages<T>(
  readPage: (cursor: string | null) => Promise<PageResult<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = await readPage(cursor);
    all.push(...page.nodes);
    if (!page.hasNextPage) {
      return all;
    }
    cursor = page.endCursor;
  }
}

/**
 * Dựng port thật. `projectId` được bắt trong lần đọc trang item đầu tiên
 * (query khai báo `projectV2 { id }`), vì mutation cần node id của project
 * chứ không nhận số project.
 */
export function createGitHubPort(options: GitHubPortOptions): GitHubPort {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const deps: GraphQLDeps = {
    fetchImpl,
    token: options.token,
    maxRetries: options.maxRetries ?? 3,
    delayMs: options.delayMs ?? defaultDelay,
    nowMs: options.nowMs ?? (() => Date.now()),
  };
  const { owner, repo, projectNumber } = options;
  let projectId: string | null = null;

  const captureProjectId = (id: string): void => {
    projectId = id;
  };

  const readIssuePage = (cursor: string | null): Promise<PageResult<NormalizedIssue>> =>
    executeGraphQl(deps, ISSUES_QUERY, { owner, repo, cursor }, readIssuesPage);

  const readItemPage = (cursor: string | null): Promise<PageResult<ProjectItemRecord>> =>
    executeGraphQl(
      deps,
      PROJECT_ITEMS_QUERY,
      { org: owner, number: projectNumber, cursor },
      (data) => readProjectItemsPage(data, captureProjectId),
    );

  return {
    async discoverAll(): Promise<DiscoveryResult> {
      // Chạy song song nhưng KHÔNG để một phía lỗi che mất phía còn lại:
      // allSettled giữ cả hai kết quả để report thấy được inventory một phần.
      const [issues, items] = await Promise.allSettled([
        readAllPages(readIssuePage),
        readAllPages(readItemPage),
      ]);
      return {
        issues: issues.status === 'fulfilled' ? issues.value : [],
        projectItems: items.status === 'fulfilled' ? items.value : [],
        complete: issues.status === 'fulfilled' && items.status === 'fulfilled',
      };
    },

    async addItem(issueNodeId: string): Promise<string> {
      if (projectId === null) {
        throw new GitHubPortError(
          'project id is unknown; run discoverAll() before addItem()',
          false,
        );
      }
      return executeGraphQl(
        deps,
        ADD_ITEM_MUTATION,
        { projectId, contentId: issueNodeId },
        readAddedItemId,
      );
    },

    async removeItem(itemId: string): Promise<void> {
      if (projectId === null) {
        throw new GitHubPortError(
          'project id is unknown; run discoverAll() before removeItem()',
          false,
        );
      }
      await executeGraphQl(deps, REMOVE_ITEM_MUTATION, { projectId, itemId }, readRemovedItemId);
    },

    async refetchProjectItems(): Promise<ProjectItemRecord[]> {
      return readAllPages(readItemPage);
    },
  };
}
