import { parse as parseYaml } from 'yaml';

/**
 * Frontmatter của một định nghĩa agent trong `.agents/agents/`.
 *
 * Shape này là của Claude Code (`name`, `description`, `tools`, `model`) và là
 * định dạng duy nhất được phép ở nguồn, cộng thêm `mode` — key chỉ OpenCode
 * hiểu. Mỗi đích sinh ra một biến thể riêng: Claude nhận gần nguyên văn (không
 * có `mode`), OpenCode nhận `description` + `mode` + các `permissions` suy ra từ
 * `tools`.
 */
export interface AgentSource {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[] | undefined;
  readonly model: string | undefined;
  readonly mode: AgentMode | undefined;
  /** Phần sau frontmatter, giữ nguyên văn — đây là system prompt của agent. */
  readonly body: string;
}

/** Giá trị `mode` mà OpenCode chấp nhận cho một agent. */
export const AGENT_MODES = ['primary', 'subagent', 'all'] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

/** Key duy nhất được phép trong frontmatter nguồn. */
const ALLOWED_KEYS = new Set(['name', 'description', 'tools', 'model', 'mode']);

/**
 * Tool của Claude Code ánh xạ sang `action` trong `permissions` của OpenCode.
 *
 * Bảng là danh sách đóng có chủ đích: một tên tool không có ở đây là lỗi, không
 * phải thứ bị bỏ qua im lặng. Bỏ qua sẽ khiến một tool gõ sai tên trông như đã
 * được cấp quyền trong khi thực tế bị catch-all `deny` chặn — sai lệch chỉ lộ ra
 * lúc chạy agent.
 */
const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  Read: 'read',
  Grep: 'grep',
  Glob: 'glob',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Task: 'subagent',
  Agent: 'subagent',
  Skill: 'skill',
  AskUserQuestion: 'question',
};

/** Tách frontmatter và body; frontmatter phải mở đầu file và có dòng đóng riêng. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Đọc `tools` ở cả hai dạng mà Claude Code chấp nhận: chuỗi phân tách bằng dấu
 * phẩy, hoặc một YAML list.
 *
 * Danh sách rỗng bị từ chối thay vì được hiểu là "không có tool nào": OpenCode
 * không phân biệt được ý định đó với một lỗi gõ, còn Claude thì nhận `tools: ""`
 * như một giá trị rác. Agent không cần giới hạn tool phải bỏ hẳn key, và hai
 * trạng thái đó vì vậy chỉ còn đúng một cách biểu đạt.
 */
function parseTools(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value];

  const tools: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new Error(`${label}: tools must be a comma-separated string or a list of strings`);
    }

    const tool = item.trim();

    if (tool !== '') {
      tools.push(tool);
    }
  }

  if (tools.length === 0) {
    throw new Error(`${label}: "tools" names no tool; omit the key to keep the default tool set`);
  }

  return tools;
}

/**
 * Đọc `mode` — key chỉ ảnh hưởng tới file OpenCode.
 *
 * Chỉ **vắng mặt** mới được hiểu là `subagent`, đúng mặc định của renderer
 * OpenCode. Key có mặt nhưng để trống (`mode:` hay `mode: ""`) là lỗi, giống
 * `tools` và `model`: YAML đọc giá trị trống thành `null`, và một key rỗng là
 * lỗi gõ chứ không phải ý định bỏ key — coi nó là "vắng mặt" sẽ nuốt mất lỗi
 * đó. Mọi giá trị khác ba giá trị OpenCode hiểu cũng là lỗi, vì một `mode` gõ
 * sai khiến OpenCode âm thầm dùng mặc định, tức agent chạy sai vai.
 */
function parseMode(value: unknown, label: string): AgentMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}: "mode" must be one of ${AGENT_MODES.join(', ')}`);
  }

  const mode = value.trim();

  if (!(AGENT_MODES as readonly string[]).includes(mode)) {
    throw new Error(`${label}: "mode" must be one of ${AGENT_MODES.join(', ')}, got "${mode}"`);
  }

  return mode as AgentMode;
}

/**
 * Parse và validate một file agent nguồn.
 *
 * Mọi lỗi nêu rõ file và key sai: file nguồn do người viết tạo, nên thông báo
 * phải đủ để sửa mà không cần đọc lại code sinh.
 */
export function parseAgentSource(contents: string, label: string): AgentSource {
  const match = FRONTMATTER_PATTERN.exec(contents);

  if (match === null) {
    throw new Error(`${label}: missing YAML frontmatter`);
  }

  const frontmatter = parseYaml(match[1]) as unknown;

  if (!isPlainObject(frontmatter)) {
    throw new Error(`${label}: frontmatter must be a YAML mapping`);
  }

  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `${label}: unsupported frontmatter key "${key}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`,
      );
    }
  }

  const { name, description, tools, model, mode } = frontmatter;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${label}: frontmatter requires a non-empty "name"`);
  }

  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`${label}: frontmatter requires a non-empty "description"`);
  }

  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error(`${label}: "model" must be a non-empty string`);
  }

  const parsedTools = parseTools(tools, label);
  const parsedMode = parseMode(mode, label);

  for (const tool of parsedTools ?? []) {
    if (!Object.hasOwn(TOOL_ACTIONS, tool)) {
      throw new Error(
        `${label}: unknown tool "${tool}" (known: ${Object.keys(TOOL_ACTIONS).join(', ')})`,
      );
    }
  }

  return {
    name,
    description,
    tools: parsedTools,
    model: typeof model === 'string' ? model.trim() : undefined,
    mode: parsedMode,
    body: contents.slice(match[0].length),
  };
}

/** Chuỗi JSON là một YAML double-quoted scalar hợp lệ, nên dùng luôn để escape. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Sinh file agent cho Claude Code.
 *
 * Giữ nguyên các key của nguồn, chỉ chuẩn hoá `tools` về dạng chuỗi phân tách
 * bằng dấu phẩy để hai lần chạy cho ra cùng byte. `mode` không được ghi ra:
 * Claude Code không có field này trong frontmatter agent.
 */
export function renderClaudeAgent(agent: AgentSource): string {
  const lines = ['---', `name: ${quote(agent.name)}`, `description: ${quote(agent.description)}`];

  if (agent.tools !== undefined) {
    lines.push(`tools: ${quote(agent.tools.join(', '))}`);
  }

  if (agent.model !== undefined) {
    lines.push(`model: ${quote(agent.model)}`);
  }

  lines.push('---');

  return `${lines.join('\n')}\n${agent.body}`;
}

export interface OpencodeAgent {
  readonly contents: string;
  readonly warnings: readonly string[];
}

/**
 * Sinh file agent cho OpenCode.
 *
 * OpenCode khai báo tool access bằng `permissions` chứ không có field `tools`, và
 * mặc định `mode: primary` cho agent tuỳ biến — thiếu `mode: subagent` thì một
 * subagent sẽ chiếm chỗ của agent chính. Vì vậy `mode` của nguồn được ghi ra, và
 * nguồn không khai báo thì mặc định là `subagent`. Rule khai báo sau thắng rule
 * khai báo trước, nên catch-all `deny` phải đứng đầu để các `allow` phía sau mới
 * có tác dụng giới hạn.
 *
 * `model` chỉ được truyền khi có dạng `provider/model`: Claude chấp nhận alias
 * như `sonnet`, OpenCode thì không. Bỏ alias kèm cảnh báo trung thực hơn là sinh
 * một file OpenCode từ chối hoặc âm thầm trỏ sai model.
 */
export function renderOpencodeAgent(agent: AgentSource): OpencodeAgent {
  const warnings: string[] = [];
  const lines = [
    '---',
    `description: ${quote(agent.description)}`,
    `mode: ${agent.mode ?? 'subagent'}`,
  ];

  if (agent.model !== undefined) {
    if (agent.model.includes('/')) {
      lines.push(`model: ${quote(agent.model)}`);
    } else {
      warnings.push(
        `model "${agent.model}" is not in OpenCode's provider/model form; omitting it so OpenCode uses its default model`,
      );
    }
  }

  if (agent.tools !== undefined) {
    const actions: string[] = [];

    for (const tool of agent.tools) {
      const action = TOOL_ACTIONS[tool];

      if (!actions.includes(action)) {
        actions.push(action);
      }
    }

    lines.push('permissions:', '  - action: "*"', '    resource: "*"', '    effect: deny');

    for (const action of actions) {
      lines.push(`  - action: ${quote(action)}`, '    resource: "*"', '    effect: allow');
    }
  }

  lines.push('---');

  return { contents: `${lines.join('\n')}\n${agent.body}`, warnings };
}
