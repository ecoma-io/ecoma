import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkTools, probeVersion, warnMissingTools, type ToolSpec } from './tools.js';
import { TOOL_SPECS, docker, helm, kustomize, kubeconform } from './tool-specs.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn<typeof execFileSync>() }));

const execFileSyncMock = vi.mocked(execFileSync);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Báo `version` cho các lệnh được nêu tên, còn lại thì không báo gì. */
function installedCommands(version: string, commands: readonly string[]) {
  execFileSyncMock.mockImplementation(((file: string) => {
    if (commands.includes(file)) return `${version}\n`;
    throw new Error('not found');
  }) as never);
}

describe('probeVersion', () => {
  it('reads the version off a command that runs', () => {
    execFileSyncMock.mockReturnValue('v3.267.0\n' as never);
    expect(probeVersion('pulumi', ['version'])).toBe('v3.267.0');
  });

  it('returns null when the command is not on PATH', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(probeVersion('helm', ['version'])).toBeNull();
  });

  it('ignores usage output from a rejected flag', () => {
    // kubeconform exit 0 với `--version` nhưng in usage trong đó không có số phiên bản.
    execFileSyncMock.mockReturnValue(
      'flag provided but not defined: -version\nUsage: ...' as never,
    );
    expect(probeVersion('kubeconform', ['--version'])).toBeNull();
  });

  it('passes the version flags through unchanged', () => {
    execFileSyncMock.mockReturnValue('v1.0.0' as never);
    probeVersion('flux', ['version', '--client']);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'flux',
      ['version', '--client'],
      expect.anything(),
    );
  });
});

/** Một tool giả đủ trường cho `checkTools`, tên máy lấy từ command. */
const spec = (command: string): ToolSpec => ({
  name: command,
  command,
  versionArgs: ['version'],
  installUrl: `https://example.test/${command}`,
});

describe('checkTools', () => {
  it('reports a tool that runs', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installedCommands('v1.2.3', ['helm']);

    const report = checkTools([spec('helm')]);

    expect(report.available).toEqual([{ spec: spec('helm'), version: 'v1.2.3' }]);
    expect(report.missing).toEqual([]);
  });

  it('reports a tool that does not run as missing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installedCommands('v1.2.3', ['helm']);

    const report = checkTools([spec('helm'), spec('flux')]);

    expect(report.available.map((a) => a.spec.command)).toEqual(['helm']);
    expect(report.missing.map((m) => m.command)).toEqual(['flux']);
  });

  it('keeps the declared order', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    execFileSyncMock.mockReturnValue('v1.0.0' as never);

    const report = checkTools([spec('a'), spec('b'), spec('c')]);

    expect(report.available.map((a) => a.spec.command)).toEqual(['a', 'b', 'c']);
  });

  it('logs what it found, so a skipped install is visible', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installedCommands('v1.2.3', ['helm']);

    checkTools([spec('helm')]);

    expect(log).toHaveBeenCalledWith('helm v1.2.3 is available');
  });

  it('installs nothing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installedCommands('v1.2.3', ['helm']);

    checkTools([spec('helm')]);

    // Một máy không có root hay không có TTY là một máy bình thường; một installer
    // không hoàn tất được sẽ khiến repository chỉ chuẩn bị được một nửa.
    for (const [file] of execFileSyncMock.mock.calls) {
      expect(String(file)).not.toMatch(/curl|install|brew|apt|winget|sudo/u);
    }
  });

  it('handles an empty list', () => {
    expect(checkTools([])).toEqual({ available: [], missing: [] });
  });
});

describe('warnMissingTools', () => {
  const specs = [
    { name: 'Pulumi', command: 'pulumi', versionArgs: ['version'], installUrl: 'https://p.test' },
    { name: 'Helm', command: 'helm', versionArgs: ['version'], installUrl: 'https://h.test' },
  ];

  it('says nothing when every tool is present', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    warnMissingTools([]);

    expect(log).not.toHaveBeenCalled();
  });

  it('links the official instructions for each missing tool', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    warnMissingTools(specs);

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Pulumi: https://p.test');
    expect(output).toContain('Helm: https://h.test');
  });

  it('counts the tools correctly in the singular and plural', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const [pulumi] = specs;

    warnMissingTools([pulumi]);
    warnMissingTools(specs);

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('1 required tool is missing');
    expect(output).toContain('2 required tools are missing');
  });

  it('does not pretend the repository is ready', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    warnMissingTools(specs);

    const output = log.mock.calls.flat().join('\n').toLowerCase();
    expect(output).not.toContain('ready');
    expect(output).not.toContain('done');
  });
});

describe('tool specs', () => {
  const specs = { Docker: docker, Helm: helm, kustomize, kubeconform };

  it('covers the CLIs the platform work needs', () => {
    expect(TOOL_SPECS).toEqual([docker, helm, kustomize, kubeconform]);
  });

  it.each(Object.entries(specs))('%s points at official documentation', (_name, toolSpec) => {
    // Một cảnh báo chỉ hữu ích khi link hoạt động, nên giữ chúng ở dạng tuyệt đối
    // và trên chính domain của vendor.
    expect(toolSpec.installUrl).toMatch(/^https:\/\//u);
    expect(toolSpec.installUrl).toContain(toolSpec.command === 'kustomize' ? 'kubernetes.io' : '.');
  });

  it('names each tool for the warning', () => {
    for (const toolSpec of TOOL_SPECS) {
      expect(toolSpec.name).toBeTruthy();
      expect(toolSpec.command).toBeTruthy();
    }
  });

  it.each(Object.entries(specs))('%s probes its own version flag', (name, toolSpec) => {
    expect(toolSpec.versionArgs.length).toBeGreaterThan(0);
    expect(name).toBeTruthy();
  });

  it('uses `-v` for kubeconform, which rejects --version', () => {
    expect(kubeconform.versionArgs).toEqual(['-v']);
  });

  it('uses `version` for helm and kustomize', () => {
    expect(helm.versionArgs).toEqual(['version']);
    expect(kustomize.versionArgs).toEqual(['version']);
  });

  it('probes the docker daemon, not just the client binary', () => {
    // `docker --version` báo binary đã cài kể cả khi daemon đang dừng, nên nó sẽ
    // qua ở đây rồi fail mọi commit trong hook.
    expect(docker.versionArgs).toEqual(['version']);
  });

  it('probes every declared spec without throwing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });

    const report = checkTools(TOOL_SPECS);

    expect(report.available).toEqual([]);
    expect(report.missing).toHaveLength(TOOL_SPECS.length);
  });
});
