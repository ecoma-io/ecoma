/**
 * Unit test của body builder `/v1/models` — port của 4 test Rust
 * `src/models.rs` (`#[cfg(test)] mod tests`): shape OpenAI-compatible, thứ tự
 * phần tử và escaping phải byte-tương-thích với runtime Rust.
 */
import { type Mock, describe, expect, it, vi } from 'vitest';

import { createBindingLimiters, OperationDeadlineError, withClient } from './connections';
import type { LlmApiEnv } from './env';
import {
  CatalogueError,
  jsonEscape,
  modelsListBody,
  servingCatalogue,
  type ServingModel,
} from './models';

function model(id: string, created: number, ownedBy: string): ServingModel {
  return { id, created, ownedBy };
}

describe('modelsListBody', () => {
  it('empty catalogue keeps the frozen empty list body', () => {
    expect(modelsListBody([])).toBe('{"object":"list","data":[]}');
  });

  it('one model renders the OpenAI compatible shape', () => {
    const body = modelsListBody([model('dronie-flash', 1_760_000_000, 'dronie')]);
    expect(body).toBe(
      '{"object":"list","data":[{"id":"dronie-flash","object":"model","created":1760000000,"owned_by":"dronie"}]}',
    );
  });

  it('models render in given order without separating comma issues', () => {
    const body = modelsListBody([model('model-a', 1, 'tenant-a'), model('model-b', 2, 'tenant-b')]);
    expect(body).toBe(
      '{"object":"list","data":[{"id":"model-a","object":"model","created":1,"owned_by":"tenant-a"},{"id":"model-b","object":"model","created":2,"owned_by":"tenant-b"}]}',
    );
  });
});

describe('jsonEscape', () => {
  it('neutralizes quotes and backslashes', () => {
    expect(jsonEscape('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

/**
 * Hai nhánh fail-closed của catalogue mà harness integration không với tới
 * được (database thật của harness luôn có dữ liệu hợp lệ và tenant đã ánh
 * xạ). `CatalogueError` là thứ route đổi thành 503 — nếu một hồi quy biến
 * hai nhánh này thành "bỏ qua offer / trả list rỗng" thì chúng phải đỏ ở
 * đây, không phải chờ 200 rỗng lệch hợp đồng ở tầng HTTP.
 */
vi.mock('./connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connections')>();
  return {
    ...actual,
    withClient: vi.fn<(...args: Parameters<typeof withClient>) => Promise<unknown>>(),
  };
});

const withClientMock = withClient as unknown as Mock;

function hyperdriveEnv(): LlmApiEnv {
  return {
    DB_LLM_GATEWAY: { connectionString: 'postgresql://gateway.invalid/db-llm-gateway' },
    DB_LLM_TENANT: { connectionString: 'postgresql://tenant.invalid/db-llm-tenant' },
    DB_LLM_MARKETPLACE: { connectionString: 'postgresql://marketplace.invalid/db-llm-marketplace' },
  };
}

describe('servingCatalogue fail-closed branches', () => {
  it('a failing catalogue query throws CatalogueError instead of an empty list', async () => {
    withClientMock.mockRejectedValueOnce(new Error('connection refused'));
    await expect(servingCatalogue(hyperdriveEnv(), createBindingLimiters())).rejects.toBeInstanceOf(
      CatalogueError,
    );
  });

  it('a catalogue query that misses its deadline throws CatalogueError (fail-closed)', async () => {
    // Deadline operation là một trong các lỗi fail-closed của catalogue —
    // review P1/P2 của PR #152: hết deadline (operation bị terminate) phải
    // cho đúng 503 path, không rò result muộn thành 200.
    withClientMock.mockRejectedValueOnce(new OperationDeadlineError());
    await expect(servingCatalogue(hyperdriveEnv(), createBindingLimiters())).rejects.toBeInstanceOf(
      CatalogueError,
    );
  });

  it('an unmapped seller tenant throws CatalogueError instead of an empty list', async () => {
    // Marketplace trả một offer hợp lệ; gateway trả tenant KHÔNG chứa
    // seller_tenant_id của offer — ánh xạ hụt là lỗi catalogue, không phải
    // lý do để lược bỏ model khỏi list.
    withClientMock
      .mockResolvedValueOnce({
        rows: [
          {
            normalized_model_id: 'model-a',
            created_at: '1760000000000',
            seller_tenant_id: 'tenant-x',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'tenant-a', name: 'Tenant A' }] });
    await expect(servingCatalogue(hyperdriveEnv(), createBindingLimiters())).rejects.toBeInstanceOf(
      CatalogueError,
    );
  });
});
