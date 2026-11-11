import { describe, expect, it } from 'vitest';

import { SKILL_NAME_PATTERN, parseSkillSource } from './skill-frontmatter.js';

/**
 * Test thuần cho parse + validate frontmatter của một `SKILL.md`; phần dính tới
 * hệ thống file và git (gitignore, symlink, mirror) nằm ở `sync-agent-config.spec.ts`.
 */

const LABEL = '.agents/skills/demo/SKILL.md';

function sourceWith(frontmatter: string, body = 'Body.'): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

const VALID = sourceWith('name: demo\ndescription: Demo skill');

describe('parseSkillSource', () => {
  it('returns the required metadata for a valid skill', () => {
    expect(parseSkillSource(VALID, LABEL)).toEqual({ name: 'demo', description: 'Demo skill' });
  });

  it('accepts a name of exactly 64 characters and a description of exactly 1024', () => {
    // Hai biên trên đúng giới hạn của Agent Skills spec phải đi qua, không chỉ
    // các giá trị cách xa giới hạn.
    const name = 'a'.repeat(64);
    const description = 'd'.repeat(1024);

    expect(
      parseSkillSource(sourceWith(`name: ${name}\ndescription: ${description}`), LABEL),
    ).toEqual({ name, description });
  });

  it('tolerates unknown extra frontmatter keys such as allowed-tools', () => {
    // Các key tuỳ chọn của Agent Skills spec (`allowed-tools`, `license`,
    // `metadata`...) phải được giữ nguyên trạng thái: cây skill vendored dùng
    // chúng, và validation chỉ canh contract bắt buộc.
    const contents = sourceWith(
      'name: demo\ndescription: Demo skill\nallowed-tools: Read(.*), Bash(lio/*)\nlicense: MIT',
    );

    expect(parseSkillSource(contents, LABEL)).toEqual({ name: 'demo', description: 'Demo skill' });
  });

  it('rejects missing frontmatter and names the file', () => {
    expect(() => parseSkillSource('# demo\n', LABEL)).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: missing YAML frontmatter$/u,
    );
  });

  it('rejects invalid YAML and names the file and the underlying cause', () => {
    const contents = sourceWith('name: [unclosed');

    const error = (() => {
      try {
        parseSkillSource(contents, LABEL);

        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error).not.toBeNull();
    expect(error?.message).toContain(`${LABEL}: invalid YAML frontmatter:`);
    expect(error?.cause).toBeInstanceOf(Error);
  });

  it('rejects frontmatter that is not a mapping', () => {
    expect(() => parseSkillSource(sourceWith('just a scalar'), LABEL)).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: frontmatter must be a YAML mapping$/u,
    );
  });

  it('rejects frontmatter that is a list', () => {
    expect(() => parseSkillSource(sourceWith('- demo'), LABEL)).toThrow(
      /frontmatter must be a YAML mapping/u,
    );
  });

  it('rejects a missing name', () => {
    expect(() => parseSkillSource(sourceWith('description: Demo skill'), LABEL)).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: frontmatter requires a non-empty "name"$/u,
    );
  });

  it('rejects an empty name', () => {
    expect(() => parseSkillSource(sourceWith('name: ""\ndescription: Demo skill'), LABEL)).toThrow(
      /requires a non-empty "name"/u,
    );
  });

  it('rejects a name with uppercase letters', () => {
    expect(() =>
      parseSkillSource(sourceWith('name: Demo\ndescription: Demo skill'), LABEL),
    ).toThrow(/"name" must match /u);
  });

  it('rejects a name with an underscore', () => {
    expect(() =>
      parseSkillSource(sourceWith('name: demo_skill\ndescription: Demo skill'), LABEL),
    ).toThrow(/"name" must match /u);
  });

  it('rejects a name with a leading hyphen', () => {
    expect(() =>
      parseSkillSource(sourceWith('name: "-demo"\ndescription: Demo skill'), LABEL),
    ).toThrow(/"name" must match /u);
  });

  it('rejects a name with a trailing hyphen', () => {
    expect(() =>
      parseSkillSource(sourceWith('name: demo-\ndescription: Demo skill'), LABEL),
    ).toThrow(/"name" must match /u);
  });

  it('rejects a name longer than 64 characters', () => {
    const name = 'a'.repeat(65);

    expect(() =>
      parseSkillSource(sourceWith(`name: ${name}\ndescription: Demo skill`), LABEL),
    ).toThrow(/^\.agents\/skills\/demo\/SKILL\.md: "name" must be at most 64 characters, got 65$/u);
  });

  it('rejects a name that is not a string', () => {
    expect(() => parseSkillSource(sourceWith('name: 42\ndescription: Demo skill'), LABEL)).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: frontmatter "name" must be a string, got number$/u,
    );
  });

  it('rejects an empty description', () => {
    expect(() => parseSkillSource(sourceWith('name: demo\ndescription: ""'), LABEL)).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: frontmatter requires a non-empty "description"$/u,
    );
  });

  it('rejects a description that is only whitespace', () => {
    expect(() => parseSkillSource(sourceWith('name: demo\ndescription: "   "'), LABEL)).toThrow(
      /requires a non-empty "description"/u,
    );
  });

  it('rejects a missing description', () => {
    expect(() => parseSkillSource(sourceWith('name: demo'), LABEL)).toThrow(
      /requires a non-empty "description"/u,
    );
  });

  it('rejects a description longer than 1024 characters', () => {
    const description = 'd'.repeat(1025);

    expect(() =>
      parseSkillSource(sourceWith(`name: demo\ndescription: ${description}`), LABEL),
    ).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: "description" must be at most 1024 characters, got 1025$/u,
    );
  });

  it('rejects a description that is not a string', () => {
    expect(() => parseSkillSource(sourceWith('name: demo\ndescription: 42'), LABEL)).toThrow(
      /^\.agents\/skills\/demo\/SKILL\.md: frontmatter "description" must be a string, got number$/u,
    );
  });

  it('exposes the Agent Skills naming pattern it enforces', () => {
    // Pattern xuất ra phải trùng với luật được test ở trên, để nơi khác dùng lại
    // không lệch với validation thật.
    expect(SKILL_NAME_PATTERN.test('demo')).toBe(true);
    expect(SKILL_NAME_PATTERN.test('demo-skill-2')).toBe(true);
    expect(SKILL_NAME_PATTERN.test('Demo')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('-demo')).toBe(false);
  });
});
