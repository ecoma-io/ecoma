import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec unit của guard DATABASE_URL trong `drizzle.config.ts` (#496): lệnh kit
 * chạm database thật phải fail-fast với message tường minh khi biến thiếu
 * hoặc rỗng; các lệnh offline (`generate`, `check`) giữ hành vi load với URL
 * rỗng — đường CI `db-generate`/`db-check` không secret vẫn chạy.
 *
 * Guard đọc `process.argv`/`process.env` ngay lúc module được evaluate, nên
 * mỗi nhánh cần một lần import mới (`vi.resetModules`) sau khi đặt argv/env;
 * giá trị thật của process được save/restore trong `afterEach` để không rò
 * sang spec khác.
 */
describe('drizzle.config DATABASE_URL guard', () => {
  const argvBefore = process.argv;
  const urlBefore = process.env.DATABASE_URL;

  afterEach(() => {
    process.argv = argvBefore;
    if (urlBefore === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = urlBefore;
  });

  /** Import lại config sau khi đặt `argv[2]` — guard chạy lúc evaluate. */
  async function loadConfig(command: string): Promise<{ dbCredentials: { url: string } }> {
    process.argv = [argvBefore[0] ?? 'node', argvBefore[1] ?? 'vitest', command];
    vi.resetModules();
    return (await import('./drizzle.config.ts')).default as unknown as {
      dbCredentials: { url: string };
    };
  }

  it('fails fast naming the variable and the command when a database-touching command has no URL', async () => {
    delete process.env.DATABASE_URL;
    await expect(loadConfig('migrate')).rejects.toThrow(
      'DATABASE_URL is required for "drizzle-kit migrate"',
    );
  });

  it('treats an empty URL like a missing one', async () => {
    process.env.DATABASE_URL = '';
    await expect(loadConfig('push')).rejects.toThrow(
      'DATABASE_URL is required for "drizzle-kit push"',
    );
  });

  it('keeps offline commands loadable without the variable', async () => {
    delete process.env.DATABASE_URL;
    expect((await loadConfig('generate')).dbCredentials.url).toBe('');
    expect((await loadConfig('check')).dbCredentials.url).toBe('');
  });

  it('passes the configured URL through when a database-touching command has it', async () => {
    process.env.DATABASE_URL = 'postgresql://migrator:pw@localhost:5432/db-remote-cache';
    expect((await loadConfig('migrate')).dbCredentials.url).toBe(
      'postgresql://migrator:pw@localhost:5432/db-remote-cache',
    );
  });
});
