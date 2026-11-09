// Runner adapters: shape detection + where each runner keeps its sessions +
// how each stores subagent transcripts. Everything downstream of project()
// is runner-neutral. First recognizer wins (first-match adapter probing).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonl, blocksOf, argLine, pathsTouched, pathsNamedIn, codeRefsIn, toolOpOf, resultText } from './lib.mjs';
import { OPENCODE_ROOT, syncOpencodeProjections } from './opencode.mjs';

const home = os.homedir().replace(/\\/g, '/');

/** Probe a file's first records and pick the runner that recognises them. */
const qoder = {
  id: 'qoder',
  roots: [`${home}/.qoder/projects`],
  detect: (rec) => rec.some((r) => r.opencode !== true && (r.type === 'runtime-config' || r.type === 'active-leaf' || r.type === 'workspace-directories' || r.humanInput !== undefined)),
  /** Qoder keeps children in <sessionDir>/subagents/<name>.jsonl + a .meta.json carrying the explicit toolUseId. */
  branches(dir, mainTurns) {
    const subDir = path.join(dir, 'subagents');
    if (!fs.existsSync(subDir)) return [];
    return fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json')).map((f) => {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
      const file = path.join(subDir, f.replace(/\.meta\.json$/, '.jsonl'));
      const recs = fs.existsSync(file) ? readJsonl(file) : [];
      const owner = mainTurns.find((t) => t.toolCalls.some((c) => c.id === meta.toolUseId));
      // which files the child touched: what it asked for (weighted up) plus what
      // its tool results named — a Grep or wc -l output is how a code-level fact
      // usually gets discovered, and the args of that call never mention the file
      const tally = new Map();
      // a Grep's `path` arg is a DIRECTORY: a card that says "src" routes nowhere,
      // so keep only extension-bearing paths (writes excepted — a Dockerfile has none)
      const bump = (p, w) => { const k = String(p ?? '').replace(/\\/g, '/'); if (k && (w === 2 || /\.[\w]{1,6}$/.test(k))) tally.set(k, (tally.get(k) ?? 0) + w); };
      for (const r of recs) for (const b of blocksOf(r)) {
        if (b?.type === 'tool_use') {
          // what a branch OPENED is the route to the fact it established; its own
          // report is an output the parent already holds, so it ranks last
          const op = toolOpOf(b.name);
          const w = op === 'read' ? 4 : op === 'write' || op === 'edit' ? 2 : 3;
          for (const p of pathsTouched(b.name, b.input)) bump(p, w);
        } else if (b?.type === 'tool_result') for (const p of pathsNamedIn(resultText(b), 20)) bump(p, 1);
      }
      const files = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([p]) => p);
      return {
        agentFile: path.basename(file), description: meta.description ?? '', nativeCallId: meta.toolUseId ?? null,
        parentTurn: owner?.n ?? null, line: owner?.line ?? null,
        records: recs.length, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
        files,
        toolCalls: recs.reduce((a, r) => a + blocksOf(r).filter((b) => b?.type === 'tool_use').length, 0),
        textChars: recs.reduce((a, r) => a + blocksOf(r).filter((b) => b?.type === 'text').reduce((x, b) => x + (b.text ?? '').length, 0), 0),
        link: owner ? 'observed' : 'inferred',
      };
    });
  },
};

const claudeCode = {
  id: 'claude-code',
  roots: [`${home}/.claude/projects`],
  detect: (rec) => rec.some((r) => r.type === 'queue-operation' || r.userType !== undefined || r.entrypoint !== undefined),
  /** Claude Code writes children inline in the parent's JSONL, flagged isSidechain, with no call id link. */
  branches(dir, turns) {
    const groups = [];
    let cur = null;
    for (const t of turns) {
      if (t.sidechain) {
        if (!cur) { cur = { agentFile: 'inline', description: 'sidechain', nativeCallId: null, records: 0, bytes: 0, toolCalls: 0, textChars: 0, link: 'reconstructed', line: t.line, lineTo: t.line }; groups.push(cur); }
        cur.records++; cur.lineTo = t.line;
        cur.toolCalls += t.toolCalls.length;
        cur.textChars += t.humanText.length + t.assistantText.length;
        continue;
      }
      cur = null;
    }
    for (const g of groups) {
      const host = turns.slice().reverse().find((t) => t.line < g.line && t.toolCalls.some((c) => c.op === 'agent'));
      g.parentTurn = host?.n ?? null;
    }
    return groups;
  },
};

/**
 * WorkBuddy (tencent desktop agent): same family as Claude Code, different envelope.
 * Prose sits on the RECORD (`content`), not `message.content`; tool calls are their
 * own records; timestamps are epoch ms. So this adapter carries a `normalize()` —
 * without it `blocksOf()` reads nothing. Shapes are documented in PRD-workbuddy.md;
 * every number below was measured on the 90 logs on this machine (2026-10-28).
 */
const workbuddy = {
  id: 'workbuddy',
  roots: [`${home}/.workbuddy/projects`],
  detect: (rec) => rec.some((r) => r.type === 'session-meta' || r.type === 'function_call' || r.type === 'function_call_result' || r.type === 'ai-title' || r.type === 'resend-fork-notice'),
  // no sidechain markers anywhere in the corpus (0 hits for isSidechain/agentId, no Task/Agent tool)
  branches: () => [],
  /** Record -> canonical record. 1:1 with source lines: `__line` is the anchor, so
   *  a mapping must never move a turn to a different line. */
  normalize(recs) {
    return recs.map((r) => {
      const ts = typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : r.timestamp ?? null;
      const base = { __line: r.__line, __bytes: r.__bytes, uuid: r.id ?? null, parentUuid: r.parentId ?? null, timestamp: ts, cwd: r.cwd };
      if (r.type === 'message' && r.role === 'assistant') {
        const text = blocksText(r.content);
        // 155 of 5,888 assistant records in this machine's corpus carry the runner's own
        // status line in the assistant slot ("Interrupted by user", "429 …", "Tool X does
        // not exist"). They have no model and no prose, so they must not enter
        // assistantText — otherwise an error string becomes the segment's head and the
        // map shows it as if the assistant had said it.
        if (r.providerData?.error || r.providerData?.skipRun) {
          return { ...base, type: 'system', subtype: 'runner-status', message: { content: [{ type: 'text', text }] } };
        }
        return { ...base, type: 'assistant', __model: r.providerData?.model, message: { content: [{ type: 'text', text }] } };
      }
      if (r.type === 'message' && r.role === 'user') {
        const text = blocksText(r.content);
        const summary = /^<cb_summary>|^<conversation_history_summary>/.test(text);
        // the ask is the <user_query> body; the envelope around it is injected context
        // (one of them is 8,941 chars of SOUL.md — never the segment head)
        const ask = summary ? '' : (text.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? '').trim();
        return {
          ...base, type: 'user', isCompactSummary: summary || undefined,
          humanInput: !summary && !!ask || undefined,
          message: { content: [{ type: 'text', text: ask || text }] },
        };
      }
      if (r.type === 'reasoning') {
        const think = blocksText(r.rawContent);
        return { ...base, type: 'assistant', message: { content: [{ type: 'thinking', thinking: think }] } };
      }
      if (r.type === 'function_call') {
        return {
          ...base, type: 'assistant', __model: r.providerData?.model,
          message: { content: [{ type: 'tool_use', id: r.callId, name: r.name, input: parseArgs(r.arguments) }] },
        };
      }
      if (r.type === 'function_call_result') {
        const out = r.output ?? {};
        return {
          ...base, type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: r.callId, content: typeof out.text === 'string' ? out.text : '', is_error: r.status !== 'completed' }] },
        };
      }
      return { ...base, type: r.type };
    });
  },
  /** Compaction is a user record whose text is a <cb_summary>, and it carries no token
   *  counts. Emit the event with nulls rather than inventing numbers. */
  boundaries(recs) {
    return recs.filter((r) => r.type === 'user' && r.isCompactSummary)
      .map((r) => ({ line: r.__line, uuid: r.uuid ?? null, trigger: 'compact', preTokens: null, postTokens: null, messagesSummary: null, durationMs: null, raw: null }));
  },
};

const blocksText = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .map((b) => (typeof b === 'string' ? b : b?.text ?? b?.thinking ?? '')).filter(Boolean).join('\n');

/** `arguments` is a JSON string, and 5 of the 10,393 calls in this machine's corpus are
 *  truncated mid-string by the runner's own log cap. A call with unreadable args still
 *  happened, so fall back to the keys we care about, then to the raw prefix. */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw ?? '');
  try { return JSON.parse(s); } catch { /* truncated by the runner */ }
  const out = {};
  for (const k of ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'description', 'prompt', 'subject']) {
    const m = s.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m) { try { out[k] = JSON.parse(`"${m[1]}"`); } catch { out[k] = m[1]; } }
  }
  if (!Object.keys(out).length) out.raw = s.slice(0, 400);
  return out;
}

/** 第四个来源：OpenCode 的 SQLite 先投影成 append-only JSONL（见 opencode.mjs），
 *  这里只负责认它、并把 compaction part 认成边界。投影行已是规范形状，normalize 原样返回。 */
const opencode = {
  id: 'opencode',
  roots: [OPENCODE_ROOT],
  detect: (rec) => rec.some((r) => r.opencode === true),
  normalize: (recs) => recs,
  boundaries(recs) {
    return recs.filter((r) => r.type === 'user' && r.isCompactSummary)
      .map((r) => ({ line: r.__line, uuid: r.uuid ?? null, trigger: 'compact', preTokens: null, postTokens: null, messagesSummary: null, durationMs: null, raw: null }));
  },
};

export const ADAPTERS = [opencode, qoder, claudeCode, workbuddy];

export function detectAdapter(records) {
  const sample = records.slice(0, 40);
  return ADAPTERS.find((a) => a.detect(sample)) ?? null;
}

/** The raw log -> the shape everything downstream understands. Runners whose prose is
 *  not in `message.content` must supply `normalize`; the four other modules that re-read
 *  the source (facts, body, find, claims) all come through here, so there is one mapping. */
export function normalizeRecords(runner, records) {
  const adapter = ADAPTERS.find((a) => a.id === runner);
  return adapter?.normalize ? adapter.normalize(records) : records;
}

export function listSessions(adapters = ADAPTERS) {
  // OpenCode 的账本源自 SQLite：列会话前先把它的投影同步到 out/opencode/。
  // 失败只影响这一个来源（缺库、老 Node），其他 runner 照常。
  if (adapters.some((a) => a.id === 'opencode')) {
    try { syncOpencodeProjections(); } catch { /* 由 opencode 模块自己记错 */ }
  }
  const out = [];
  // The runner is whatever adapter owns the directory, so a third runner is one
  // more ADAPTERS entry — this loop never has to learn its path shape.
  for (const adapter of adapters) for (const root of adapter.roots) {
    if (!fs.existsSync(root)) continue;
    for (const projectDir of fs.readdirSync(root)) {
      const abs = path.join(root, projectDir);
      if (!fs.statSync(abs).isDirectory()) continue;
      for (const f of fs.readdirSync(abs)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(abs, f);
        const st = fs.statSync(file);
        out.push({
          runner: adapter.id,
          project: projectDir, sessionId: f.replace(/\.jsonl$/, ''),
          file: file.replace(/\\/g, '/'), dir: path.join(abs, f.replace(/\.jsonl$/, '')).replace(/\\/g, '/'),
          bytes: st.size, mtime: st.mtime.toISOString(),
        });
      }
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * Project one runner session file into turns + branches + boundary events.
 * Turn numbering follows "one user-type record opens a turn", which is what
 * the experiments measured against; `zeroContent` marks the records that carry
 * nothing (35% of them in the calibration session).
 */
export function project(mainFile) {
  const raw = readJsonl(mainFile);
  const adapter = detectAdapter(raw);
  const records = adapter?.normalize ? adapter.normalize(raw) : raw;
  const dir = path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'));

  // tool_use -> tool_result pairing over the whole file (results often land outside the turn that called)
  const calls = new Map();
  const results = new Map();
  for (const r of records) {
    for (const b of blocksOf(r)) {
      if (b?.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input ?? {}, line: r.__line, uuid: r.uuid });
      else if (b?.type === 'tool_result') {
        const s = resultText(b);
        const caller = calls.get(b.tool_use_id);
        // a look-type result names the files that carry the facts; a write result
        // only echoes back its own path, so harvesting from it is noise
        const look = !caller || ['read', 'search', 'run', 'fetch'].includes(toolOpOf(caller.name));
        results.set(b.tool_use_id, { bytes: Buffer.byteLength(s), chars: s.length, head: s.replace(/\s+/g, ' ').slice(0, 240), isError: !!b.is_error, files: look ? pathsNamedIn(s, 10) : [], refs: look ? codeRefsIn(s, 8) : [] });
      }
    }
  }

  const turns = [];
  const boundaries = [];
  let open = null;
  for (const r of records) {
    if (r.type === 'system' && (r.subtype === 'compact_boundary' || r.compactMetadata)) {
      boundaries.push({
        line: r.__line, uuid: r.uuid ?? null,
        trigger: r.compactMetadata?.trigger ?? null,
        preTokens: r.compactMetadata?.preTokens ?? null,
        postTokens: r.compactMetadata?.postTokens ?? null,
        messagesSummary: r.compactMetadata?.messagesSummarized ?? r.compactMetadata?.messagesReplaced ?? null,
        durationMs: r.compactMetadata?.durationMs ?? null,
        raw: r.compactMetadata ?? null,
      });
      continue;
    }
    if (r.type === 'user') {
      const isSummary = !!r.isCompactSummary;
      const blocks = blocksOf(r);
      const onlyToolResult = blocks.length > 0 && blocks.every((b) => b?.type === 'tool_result');
      open = {
        n: turns.length + 1, line: r.__line, uuid: r.uuid ?? null, parentUuid: r.parentUuid ?? null,
        ts: r.timestamp ?? null, sidechain: !!r.isSidechain,
        kind: isSummary ? 'compact-summary' : r.humanInput ? 'human' : (r.origin?.kind ?? (onlyToolResult ? 'tool-result' : r.promptId ? 'auto' : 'auto')),
        humanText: isSummary ? '' : textJoin(blocks),
        compactSummaryText: isSummary ? textJoin(blocks) : '',
        assistantText: '', thinkingChars: 0, toolCalls: [], toolResultBytes: 0, toolNames: {},
        onlyToolResult,
      };
      turns.push(open);
      continue;
    }
    if (r.type === 'assistant' && open) {
      const blocks = blocksOf(r);
      open.assistantText += blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
      open.thinkingChars += blocks.filter((b) => b?.type === 'thinking').reduce((a, b) => a + (b.thinking ?? b.text ?? '').length, 0);
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue;
        const res = results.get(b.id);
        const inp = b.input ?? {};
        const full = typeof inp.command === 'string' ? inp.command : JSON.stringify(inp);
        open.toolCalls.push({
          id: b.id, name: b.name, op: toolOpOf(b.name), line: r.__line,
          arg: argLine(b.input).slice(0, 240), argChars: full.length,
          paths: pathsTouched(b.name, b.input),
          resultBytes: res?.bytes ?? 0, resultChars: res?.chars ?? 0, resultHead: res?.isError ? res.head : res?.head ?? '', isError: res?.isError ?? false,
          resultFiles: res?.files ?? [], resultRefs: res?.refs ?? [],
        });
        open.toolNames[b.name] = (open.toolNames[b.name] ?? 0) + 1;
        open.toolResultBytes += res?.bytes ?? 0;
      }
      continue;
    }
    // system/attachment/other records: keep them addressable as lines, not as turns
  }
  for (const t of turns) {
    t.zeroContent = !t.humanText.trim() && !t.assistantText.trim() && !t.compactSummaryText && t.toolCalls.length === 0;
  }
  // a runner that records compaction as a message (WorkBuddy) contributes its own
  // events; the system-record path above stays the only one for Qoder/Claude.
  boundaries.push(...(adapter?.boundaries?.(records) ?? []));
  boundaries.sort((a, b) => a.line - b.line);
  const branches = adapter?.branches ? adapter.branches(dir, turns) : [];
  return {
    runner: adapter?.id ?? 'unknown',
    adapterId: adapter?.id ?? null,
    mainFile: mainFile.replace(/\\/g, '/'), sidecarDir: dir.replace(/\\/g, '/'),
    records: records.length, lines: records.length,
    boundaries, branches, turns,
  };
}

const textJoin = (blocks) => blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
