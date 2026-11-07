/**
 * Contracts/publish route — port từ upstream `src/routes/contracts.ts`
 * (ADAPT). `pact-broker publish` chỉ đi đường này khi index quảng cáo
 * `pb:publish-contracts` (publish_pacts.rb#call). Legacy fallback không ghi
 * branch được — nó warn rồi publish tiếp — nên thiếu endpoint này thì
 * `--branch` thành no-op im lặng. POST luôn 200 (không 201).
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import {
  HalBuilder,
  branchSchema,
  getBaseUrl,
  nameSchema,
  tagSchema,
  versionSchema,
} from '@ecoma-io/pact-broker-api-domain';
import { readJsonBodyWithLimit, validateParam } from '../middleware/validate';
import { PgPactRepo, PgVersionRepo } from '@ecoma-io/pact-broker-api-infrastructure';
import type { PactContent } from '@ecoma-io/pact-broker-api-infrastructure';

// Khớp per-pact cap của PUT /pacts/..., nhưng body contracts/publish hợp lệ
// mang nhiều pact cho một consumer nên trần cao hơn.
const CONTRACTS_PUBLISH_MAX_BYTES = 4 * 1024 * 1024;
const MAX_INTERACTIONS = 1000;
const MAX_CONTRACTS = 100;

interface ContractInput {
  consumerName?: unknown;
  providerName?: unknown;
  specification?: unknown;
  contentType?: unknown;
  content?: unknown;
}

interface PublishContractsRequest {
  pacticipantName?: unknown;
  pacticipantVersionNumber?: unknown;
  branch?: unknown;
  buildUrl?: unknown;
  tags?: unknown;
  contracts?: unknown;
}

/** Decode contract body base64 thành pact, hoặc null nếu không phải. */
function decodeContract(content: unknown): PactContent | null {
  if (typeof content !== 'string') return null;

  let json: string;
  try {
    json = atob(content);
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as PactContent;
    if (!parsed.consumer || !parsed.provider || !Array.isArray(parsed.interactions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function contractsRoutes(writeAuth: () => MiddlewareHandler<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/publish', writeAuth(), async (c) => {
    // Per-route cap — đếm byte TRÊN STREAM (readJsonBodyWithLimit), không tin
    // Content-Length: request chunked không có header đó và bỏ qua mọi check
    // dựa trên header.
    const bodyResult = await readJsonBodyWithLimit(c, CONTRACTS_PUBLISH_MAX_BYTES, 'Body');
    if (!bodyResult.ok) return bodyResult.errorResponse;
    if (bodyResult.value === undefined) {
      return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
    }
    const body = bodyResult.value as PublishContractsRequest;

    const nameResult = validateParam(
      c,
      nameSchema,
      typeof body.pacticipantName === 'string' ? body.pacticipantName : undefined,
      'pacticipantName',
    );
    if (!nameResult.valid) return nameResult.errorResponse;
    const pacticipantName = nameResult.value;

    const versionResult = validateParam(
      c,
      versionSchema,
      typeof body.pacticipantVersionNumber === 'string' ? body.pacticipantVersionNumber : undefined,
      'pacticipantVersionNumber',
    );
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    let branch: string | undefined;
    if (typeof body.branch === 'string' && body.branch !== '') {
      const branchResult = validateParam(c, branchSchema, body.branch, 'branch');
      if (!branchResult.valid) return branchResult.errorResponse;
      branch = branchResult.value;
    }

    const buildUrl =
      typeof body.buildUrl === 'string' && body.buildUrl !== '' ? body.buildUrl : undefined;

    const tags: string[] = [];
    if (Array.isArray(body.tags)) {
      for (const tag of body.tags) {
        const tagResult = validateParam(
          c,
          tagSchema,
          typeof tag === 'string' ? tag : undefined,
          'tag',
        );
        if (!tagResult.valid) return tagResult.errorResponse;
        tags.push(tagResult.value);
      }
    }

    if (!Array.isArray(body.contracts) || body.contracts.length === 0) {
      return c.json({ error: 'Bad Request', message: 'At least one contract is required' }, 400);
    }

    if (body.contracts.length > MAX_CONTRACTS) {
      return c.json(
        {
          error: 'Bad Request',
          message: `Request contains ${body.contracts.length} contracts; the maximum is ${MAX_CONTRACTS}`,
        },
        400,
      );
    }

    // Decode + validate HẾT trước khi ghi — contract dởm không được để lại
    // nửa version đã publish.
    const decoded: Array<{ providerName: string; content: PactContent }> = [];
    for (const raw of body.contracts as ContractInput[]) {
      const providerResult = validateParam(
        c,
        nameSchema,
        typeof raw.providerName === 'string' ? raw.providerName : undefined,
        'providerName',
      );
      if (!providerResult.valid) return providerResult.errorResponse;

      const content = decodeContract(raw.content);
      if (content === null) {
        return c.json(
          { error: 'Bad Request', message: 'contract content must be base64-encoded pact JSON' },
          400,
        );
      }

      if (content.interactions.length > MAX_INTERACTIONS) {
        return c.json(
          {
            error: 'Bad Request',
            message: `Pact contains ${content.interactions.length} interactions; the maximum is ${MAX_INTERACTIONS}`,
          },
          400,
        );
      }

      decoded.push({ providerName: providerResult.value, content });
    }

    const tenantId = currentTenantId(c);
    const pool = c.get('pool');
    const client = await pool.connect();
    const notices: Array<{ type: string; text: string }> = [];

    try {
      await client.query('BEGIN');
      const pactRepo = new PgPactRepo(client);
      const versionRepo = new PgVersionRepo(client);

      for (const { providerName, content } of decoded) {
        await pactRepo.publishPact(
          tenantId,
          pacticipantName,
          versionNumber,
          providerName,
          content,
          branch,
        );

        // Webhook outbound TẮT (SR-006) — không dispatch.

        notices.push({
          type: 'success',
          text: `Successfully published pact for ${pacticipantName} version ${versionNumber} and provider ${providerName}`,
        });
      }

      // publishPact chỉ backfill branch và không thấy build URL. Cả hai được
      // nêu tường minh đây, nên ghi thẳng lên version.
      if (branch !== undefined) {
        await versionRepo.recordVersionBranch(tenantId, pacticipantName, versionNumber, branch);
        notices.push({
          type: 'debug',
          text: `Version ${versionNumber} of ${pacticipantName} is on branch ${branch}`,
        });
      }
      if (buildUrl !== undefined) {
        await versionRepo.recordVersionBuildUrl(tenantId, pacticipantName, versionNumber, buildUrl);
      }

      for (const tag of tags) {
        await versionRepo.addTag(tenantId, pacticipantName, versionNumber, tag);
        notices.push({
          type: 'debug',
          text: `Tagged version ${versionNumber} of ${pacticipantName} as "${tag}"`,
        });
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw error;
    }
    client.release();

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        notices,
        _links: {
          'pb:pacticipant-version': hal.link(
            `/pacticipants/${encodeURIComponent(pacticipantName)}/versions/${encodeURIComponent(versionNumber)}`,
          ),
        },
      },
      200,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  return app;
}
