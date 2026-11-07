import { describe, expect, it, vi } from 'vitest';

import repoPrepare from './repo-prepare.js';
import type { ToolSpec } from './tools.js';

vi.mock('../utils.js', () => ({
  runCommand: vi.fn<typeof import('../utils.js').runCommand>(),
  ROOT_DIR: '/repo',
}));

vi.mock('./sync-agent-config.js', () => ({
  syncAgentConfig: vi.fn<typeof import('./sync-agent-config.js').syncAgentConfig>(),
}));

const { checkTools, warnMissingTools } = await import('./tools.js');

vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>();
  return {
    ...actual,
    checkTools: vi.fn<typeof import('./tools.js').checkTools>(() => ({
      available: [],
      missing: [],
    })),
    warnMissingTools: vi.fn<typeof import('./tools.js').warnMissingTools>(),
  };
});

const { runCommand } = await import('../utils.js');
const { syncAgentConfig } = await import('./sync-agent-config.js');
const { TOOL_SPECS } = await import('./tool-specs.js');

const run = async () => {
  vi.clearAllMocks();
  await (repoPrepare.run as unknown as (ctx: unknown) => Promise<void>)({});
};

describe('repo-prepare', () => {
  it('installs the git hooks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run();

    expect(runCommand).toHaveBeenCalledWith('pnpm exec lefthook install');
  });

  it('checks every required tool', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run();

    expect(checkTools).toHaveBeenCalledWith(TOOL_SPECS);
  });

  it('reports only the tools that are missing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const kubeconform = TOOL_SPECS.find((spec) => spec.command === 'kubeconform');
    const missing: ToolSpec[] = kubeconform ? [kubeconform] : [];
    vi.mocked(checkTools).mockReturnValue({ available: [], missing });

    await run();

    expect(warnMissingTools).toHaveBeenCalledWith(missing);
  });

  it('installs nothing itself', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // `runCommand` là shell duy nhất command này tự sở hữu, nên canh chừng nó bao
    // trọn mọi thứ repo-prepare sẽ spawn ngoài lệnh dò đã bị mock.
    await run();

    // Không bao giờ chạy package manager, curl hay sudo: một tool bị thiếu là
    // thông tin cho developer, không phải việc để installer lo.
    for (const call of vi.mocked(runCommand).mock.calls) {
      expect(call.join(' ')).not.toMatch(/curl|brew|apt|choco|winget|sudo|helm|flux|pulumi/u);
    }
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('syncs agent configuration after the checks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run();

    expect(syncAgentConfig).toHaveBeenCalled();
    const order = log.mock.calls.flat();
    expect(order.indexOf('Installing git hooks')).toBeLessThan(
      order.indexOf('Checking required tools'),
    );
    expect(order.indexOf('Checking required tools')).toBeLessThan(
      order.indexOf('Sync agent configuration'),
    );
  });

  it('completes even when tools are missing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(checkTools).mockReturnValue({
      available: [],
      missing: TOOL_SPECS as ToolSpec[],
    });

    // Một tool bị thiếu là thông tin cho developer, không phải lý do để
    // repository chỉ chuẩn bị được một nửa.
    await expect(run()).resolves.toBeUndefined();
    expect(warnMissingTools).toHaveBeenCalledWith(TOOL_SPECS);
  });

  it('surfaces a failing agent configuration sync instead of hanging', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(syncAgentConfig).mockRejectedValueOnce(new Error('EACCES'));

    await expect(run()).rejects.toThrow('EACCES');
  });

  it('waits for the agent configuration sync to finish', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let finished = false;
    vi.mocked(syncAgentConfig).mockImplementationOnce(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      finished = true;
    });

    await run();

    expect(finished).toBe(true);
  });

  it('is safe to run twice', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBeUndefined();
  });
});
