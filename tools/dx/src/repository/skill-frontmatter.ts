import { parse as parseYaml } from 'yaml';

/**
 * Metadata bắt buộc của một skill trong `.agents/skills/`.
 *
 * Khác với agent — được render lại theo từng đích — skill được mirror nguyên
 * văn, nên kết quả parse chỉ cần hai field mà loader của Claude Code đọc:
 * `name` và `description`. Body ở lại trong file nguồn và không bao giờ đi
 * qua đây.
 */
export interface SkillSource {
  readonly name: string;
  readonly description: string;
}

/**
 * Ràng buộc đặt tên của Agent Skills spec: các đoạn chữ-số-thường nối bằng
 * dấu gạch ngang.
 *
 * Xuất ra để nơi khác kiểm lại cùng một luật mà không phải chép lại pattern.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/** Giới hạn độ dài của Agent Skills spec cho `name`. */
const SKILL_NAME_MAX_LENGTH = 64;

/** Giới hạn độ dài của Agent Skills spec cho `description`. */
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** Tách frontmatter và body; frontmatter phải mở đầu file và có dòng đóng riêng. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse và validate frontmatter của một file `SKILL.md` nguồn.
 *
 * Skill được mirror nguyên văn nên lỗi metadata không thể sửa lúc sinh như với
 * agent: một `name` sai hoặc `description` rỗng sẽ thành một skill mà loader
 * bỏ qua im lặng. Vì vậy mọi vi phạm là lỗi chứ không phải cảnh báo, và thông
 * báo phải nêu đủ file và field để sửa mà không cần đọc lại code sinh.
 *
 * Các key ngoài `name`/`description` được chấp nhận nguyên trạng và không log:
 * spec Agent Skills cho phép key tuỳ chọn (`allowed-tools`, `license`,
 * `metadata`...) và cây skill vendored bên ngoài dùng những key đó — từ chối
 * sẽ làm hỏng cả lần đồng bộ vì một quy ước không thuộc contract bắt buộc.
 */
export function parseSkillSource(contents: string, label: string): SkillSource {
  const match = FRONTMATTER_PATTERN.exec(contents);

  if (match === null) {
    throw new Error(`${label}: missing YAML frontmatter`);
  }

  let frontmatter: unknown;

  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    // Lỗi YAML của thư viện không biết file đến từ đâu; bọc lại để thông báo
    // vẫn nêu đúng file gây lỗi cùng nguyên nhân gốc.
    throw new Error(`${label}: invalid YAML frontmatter: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!isPlainObject(frontmatter)) {
    throw new Error(`${label}: frontmatter must be a YAML mapping`);
  }

  const { name, description } = frontmatter;

  // undefined là thiếu key chứ không phải giá trị sai kiểu: thông báo
  // "non-empty" vốn mô tả đúng trường hợp này nên được giữ nguyên.
  if (name === undefined) {
    throw new Error(`${label}: frontmatter requires a non-empty "name"`);
  }

  // Giá trị không phải string (ví dụ `name: 42`) là lỗi kiểu, không phải lỗi
  // rỗng, nên thông báo phải nêu yêu cầu kiểu kèm kiểu nhận được.
  if (typeof name !== 'string') {
    throw new Error(`${label}: frontmatter "name" must be a string, got ${typeof name}`);
  }

  if (name.trim() === '') {
    throw new Error(`${label}: frontmatter requires a non-empty "name"`);
  }

  if (name.length > SKILL_NAME_MAX_LENGTH) {
    throw new Error(
      `${label}: "name" must be at most ${SKILL_NAME_MAX_LENGTH} characters, got ${name.length}`,
    );
  }

  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `${label}: "name" must match ${SKILL_NAME_PATTERN.source} (lowercase alphanumeric segments separated by hyphens), got "${name}"`,
    );
  }

  // "description" tách kiểu như "name", kể cả case undefined.
  if (description === undefined) {
    throw new Error(`${label}: frontmatter requires a non-empty "description"`);
  }

  if (typeof description !== 'string') {
    throw new Error(
      `${label}: frontmatter "description" must be a string, got ${typeof description}`,
    );
  }

  if (description.trim() === '') {
    throw new Error(`${label}: frontmatter requires a non-empty "description"`);
  }

  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `${label}: "description" must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters, got ${description.length}`,
    );
  }

  return { name, description };
}
