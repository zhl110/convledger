// Shared primitives: token estimate, hashing, JSONL reading, block access,
// truncation matrix. Zero dependencies, read-only toward source logs.
import fs from 'node:fs';
import crypto from 'node:crypto';

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g;
export const cjkCount = (s) => (s.match(CJK) || '').length;
/** ~1 token per CJK char, ~4 latin chars per token; calibrated against Qoder's own preTokens. */
export const tok = (s) => Math.round(cjkCount(s) + (s.length - cjkCount(s)) / 4);

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/** 显示宽度：汉字与全角标点算 1，其余（拉丁、数字、点）算 0.55。
 *  按码点数预算会把 "map.mjs" 切成 "map.mj"——那是 7 个窄字符却占了 3.5 格。 */
const WIDE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
export const wlen = (s) => [...String(s)].reduce((n, c) => n + (WIDE.test(c) ? 1 : 0.55), 0);

export const kb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B');
export const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function readJsonl(file) {
  const out = [];
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line) continue;
    try {
      out.push({ __line: i + 1, __bytes: Buffer.byteLength(line), ...JSON.parse(line) });
    } catch {
      out.push({ __line: i + 1, __bytes: Buffer.byteLength(line), type: 'unparseable' });
    }
  }
  return out;
}

export const blocksOf = (rec) => {
  const c = rec?.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
};
export const textOf = (rec) =>
  blocksOf(rec).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
export const thinkingOf = (rec) =>
  blocksOf(rec).filter((b) => b?.type === 'thinking').map((b) => b.thinking ?? b.text ?? '').join('\n');
/** A result's readable text. A block array carries its prose in the text blocks —
 *  dumping the envelope instead turns an image/url payload into a line that looks
 *  citable but never matches the source bytes it was read from. */
export function resultText(b) {
  const c = b?.content ?? b?.output;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string' || (x && typeof x.type === 'string')))
    return c.map((x) => (typeof x === 'string' ? x : x.type === 'text' ? String(x.text ?? '') : '')).filter(Boolean).join('\n');
  return JSON.stringify(c ?? '');
}

// Limits come from ./cost.mjs; clip() only knows how to apply one.
export const clip = (s, limit) =>
  s.length > limit ? { text: `${s.slice(0, limit)}\n…[truncated, ${s.length} chars total]`, truncated: true } : { text: s, truncated: false };

const TOOL_OPS = [
  [/^(Read|NotebookRead|read_file|view_image|ViewImage)$/i, 'read'],
  [/^(Write|write_file)$/i, 'write'],
  [/^(Edit|MultiEdit|NotebookEdit|apply_patch)$/i, 'edit'],
  [/^(Bash|BashOutput|PowerShell|Shell|exec_command|local_shell|write_stdin)$/i, 'run'],
  [/^(Grep|Glob|LS|Search|WebSearch|web_search|SearchWorkspace|SearchKnowledge)$/i, 'search'],
  [/^(WebFetch|Fetch)$/i, 'fetch'],
  [/^(Task|Agent)$/i, 'agent'],
];
export const toolOpOf = (name) => TOOL_OPS.find(([re]) => re.test(name))?.[1] ?? 'other';
export const ARTIFACT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'apply_patch', 'present_visualization', 'ImageGen', 'VideoGen']);
export const LOOK_TOOLS = new Set(['Read', 'Grep', 'Glob', 'SearchWorkspace', 'SearchKnowledge', 'WebFetch', 'NotebookRead', 'ViewImage']);
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** One-line summary of a call's argument, for route cards and find(). */
export function argLine(input) {
  const i = input ?? {};
  const s = i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.description ?? i.prompt ?? i.query ?? i.url ?? JSON.stringify(i);
  return String(s).replace(/\s+/g, ' ').trim();
}

const INJECTED_RE = /<(ide_opened_file|ide_selection|command-name|command-args|command-message|system-reminder|local-command-caveat|restored_files|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;

/** The runner's injected context, out — what is left is what was actually typed.
 *  Keeps line breaks, unlike cleanAsk, so a caller can still count sentences. */
export const stripInjected = (text) => String(text ?? '').replace(INJECTED_RE, ' ');

export function cleanAsk(text) {
  return stripInjected(text)
    .replace(/<\/?[\w-]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const pathsTouched = (name, input) => {
  const i = input ?? {};
  const p = i.file_path ?? i.path ?? i.notebook_path ?? i.cwd;
  if (typeof p === 'string' && p) return [p.replace(/\\/g, '/')];
  const cmd = typeof i.command === 'string' ? i.command : '';
  const found = cmd.match(/[A-Za-z]:\\\\?[\w\\\\.\-\/]+|(?<!\S)\/[\w\/.\-]{4,}|[\w\-./]+\.(?:md|json|ts|tsx|js|mjs|py|txt|yaml|yml)/g);
  return found ? [...new Set(found.map((x) => x.replace(/\\/g, '/')))].slice(0, 4) : [];
};

/**
 * Source files named INSIDE a tool result (a Grep hit list, a `wc -l` table, an
 * LS listing). Args only say what was asked for; the answer often names the file
 * that carries the fact — which is what a route card has to point at. Requiring a
 * slash keeps bare basenames ("README.md") out of the inventory.
 */
export function pathsNamedIn(text, cap = 40) {
  const found = String(text ?? '').match(/[\w.\-]+(?:\/[\w.\-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|ya?ml|go|rs|css|scss|html|vue|sh|sql)/g);
  if (!found) return [];
  const count = new Map();
  for (const raw of found) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([p]) => p);
}

// 前缀用单个 [\w.\-/]+：原写法 [\w.\-/]*[\w.\-]+ 两个重叠字符类连乘会指数回溯——
// 一段 1600 字的连续词字符实测 1.2s（长会话 build 被它拖慢的主因之一）。合并后同输入 3ms，提取结果不变。
const CODE_REF_RE = /[\w.\-\/]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|vue|css|scss|md|json|ya?ml)\s*:\s*\d{1,5}(?:\s*-\s*\d{1,5})?/g;

/**
 * `file.ts:46` / `file.ts:38-47` citations inside a message or a tool result.
 * These are the addresses the conversation itself established, so a card that
 * carries three of them lets a later reader skip the keyword search entirely —
 * the one back-fill cost experiment 1 measured at 26 reads.
 */
export function codeRefsIn(text, cap = 12) {
  const found = String(text ?? '').match(CODE_REF_RE);
  if (!found) return [];
  const out = [];
  const seen = new Set();
  for (const raw of found) {
    const norm = raw.replace(/\s*-\s*/g, '-').replace(/\s*:\s*/g, ':');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= cap) break;
  }
  return out;
}
