// Codex = 第五个来源。会话落在 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（深层嵌套），
// 记录是「信封套内容」（顶层 type=session_meta/response_item/event_msg…，真内容在 payload），
// 跟整条「JSONL + 行锚点 + message.content」的管线不一个形状。所以照 OpenCode 的路子：
// 递归扫 rollout → 拍平成 out/codex/<会话id>/<会话id>.jsonl（规范形状，带 codex:true 标记），
// 再走同一套派生。投影是可删可重建的派生缓存；锚点指向投影的行，不是宿主 rollout 的原始行。
//
// 实证边界（2026-11-12 本机 9 个 rollout 全扫过）：只有 session_meta + developer/user 的 message
// + turn/event 脚手架；没有助手消息、没有工具调用、没有压缩记录。所以
//   · 会话/用户/注入上下文：本机实测有；
//   · 助手消息 / 工具调用(function_call(_output)/local_shell_call) / reasoning / 压缩事件：按 Codex
//     rollout 格式写映射，标注「未实测」——本机没有样本，等真跑出这类记录再对拍。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 源根（宿主 rollout）与投影根都可被环境变量改写，隔离测试才关得住真机目录。
// 用惰性函数读（不是模块加载时定死）：测试在 import 之后再设环境变量也生效。
export function codexSrc() { return process.env.CONVLEDGER_CODEX_SRC || path.join(os.homedir(), '.codex/sessions'); }
export function codexRoot() { return process.env.CONVLEDGER_CODEX_OUT || path.join(TOOL, 'out', 'codex'); }

const clean = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p ?? null);
const contentText = (arr) => (Array.isArray(arr) ? arr : [])
  .map((b) => (typeof b === 'string' ? b : b?.text ?? b?.input_text ?? b?.output_text ?? '')).filter(Boolean).join('\n');
const isInjected = (t) => /^\s*<\s*(environment_context|user_instructions|system|developer)\b/i.test(t);

/** 一条 response_item 的 payload → 规范记录（0~1 条；没意义的脚手架返回 null）。 */
function mapResponseItem(o, cwd, out) {
  const p = o.payload || {};
  const ts = o.timestamp ?? null;
  const type = p.type;
  if (type === 'message') {
    const text = contentText(p.content);
    if (!text) return;
    if (p.role === 'assistant') { // 未实测：本机 rollout 无 assistant message
      out.push({ type: 'assistant', codex: true, uuid: p.id ?? null, timestamp: ts, cwd, message: { content: [{ type: 'text', text }] } });
      return;
    }
    if (p.role === 'developer' || isInjected(text)) {
      // 注入的规则/环境上下文：进来但不占「人说的话」，也不开回合
      out.push({ type: 'system', codex: true, subtype: 'injected', uuid: p.id ?? null, timestamp: ts, cwd, message: { content: [{ type: 'text', text }] } });
      return;
    }
    out.push({ type: 'user', codex: true, uuid: p.id ?? null, humanInput: true, timestamp: ts, cwd, message: { content: [{ type: 'text', text }] } });
    return;
  }
  if (type === 'reasoning') { // 未实测
    const think = contentText(p.summary ?? p.content ?? []) || (typeof p.text === 'string' ? p.text : '');
    if (think) out.push({ type: 'assistant', codex: true, uuid: p.id ?? null, timestamp: ts, cwd, message: { content: [{ type: 'thinking', thinking: think }] } });
    return;
  }
  if (type === 'function_call' || type === 'local_shell_call') { // 未实测
    const id = String(p.call_id ?? p.id ?? '');
    let input = p.arguments ?? p.input ?? {};
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { raw: input }; } }
    if (type === 'local_shell_call') input = input?.command ? input : { command: p.action?.command ?? p.command ?? '' };
    out.push({ type: 'assistant', codex: true, uuid: id || null, timestamp: ts, cwd, message: { content: [{ type: 'tool_use', id, name: p.name || (type === 'local_shell_call' ? 'shell' : 'tool'), input }] } });
    return;
  }
  if (type === 'function_call_output') { // 未实测
    const id = String(p.call_id ?? '');
    const text = typeof p.output === 'string' ? p.output : contentText(p.output ?? []);
    out.push({ type: 'user', codex: true, uuid: id ? `${id}#result` : null, timestamp: ts, cwd, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!p.is_error }] } });
    return;
  }
  // additional_tools / configuration_update / 其它 → 脚手架，跳过
}

/** 一段 rollout（整份文本）→ 规范记录数组（首行是 codex-session 元信息）。 */
function projectRollout(text) {
  const out = [];
  let meta = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session_meta') {
      meta = o.payload || {};
      const sid = meta.session_id || meta.id || null;
      out.push({ type: 'system', subtype: 'codex-session', codex: true, uuid: sid, sessionId: sid, timestamp: o.timestamp ?? meta.timestamp ?? null, cwd: clean(meta.cwd), model: meta.model ?? null });
      continue;
    }
    if (o.type === 'response_item') { mapResponseItem(o, clean(meta?.cwd), out); continue; }
    if (o.type === 'event_msg') { // 未实测：压缩事件名按 Codex rollout 习惯认 compact
      const p = o.payload || {};
      if (/compact/i.test(String(p.type ?? ''))) {
        out.push({ type: 'user', codex: true, uuid: `${p.turn_id ?? ''}#compact`, isCompactSummary: true, timestamp: o.timestamp ?? null, cwd: clean(meta?.cwd), message: { content: [{ type: 'text', text: '（Codex 压缩点）' }] } });
      }
      continue;
    }
    // turn_context / world_state / 其它：脚手架，跳过
  }
  const sid = meta?.session_id || meta?.id || null;
  return { sessionId: sid, cwd: clean(meta?.cwd), lines: out };
}

/** 递归找 rollout-*.jsonl（Codex 按 年/月/日 嵌套）。 */
function findRollouts(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findRollouts(p, acc);
    else if (e.name.endsWith('.jsonl') && /rollout-/.test(e.name)) acc.push(p);
  }
  return acc;
}

let memo = null;

/** 增量同步：按每个 rollout 的 mtime+size 判有没有变，变了整段重投影（原子写）；没变一次 IO 都不做。
 *  memo 只在「用默认根」时生效——显式传 srcDir/outDir（如测试）一律真算，免得跨目录串味。 */
export function syncCodexProjections(opts = {}) {
  const srcDir = opts.srcDir || codexSrc();
  const outDir = opts.outDir || codexRoot();
  const force = !!opts.force;
  const useMemo = !opts.srcDir && !opts.outDir;
  if (!force && useMemo && memo) return memo;
  if (!fs.existsSync(srcDir)) { memo = useMemo ? { ok: true, error: 'no-codex-dir', sessions: 0, written: 0, srcDir } : memo; return { ok: true, error: 'no-codex-dir', sessions: 0, written: 0, srcDir }; }
  try {
    const files = findRollouts(srcDir);
    const marker = path.join(outDir, '.sync.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* 首次或坏了都重写 */ }
    const sig = JSON.stringify(files.map((f) => { try { const s = fs.statSync(f); return [f, s.mtimeMs, s.size]; } catch { return [f, 0, 0]; } }));
    if (!force && prev && prev.sig === sig) { const m = { ok: true, sessions: files.length, written: 0, srcDir }; if (useMemo) memo = m; return m; }
    fs.mkdirSync(outDir, { recursive: true });
    let written = 0, sessions = 0;
    for (const f of files) {
      let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const { sessionId, lines } = projectRollout(text);
      if (!sessionId || !lines.length) continue;
      sessions++;
      const dir = path.join(outDir, sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      const body = lines.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      try { const st = fs.statSync(f); fs.utimesSync(file, st.atime, st.mtime); } catch { /* 时间戳只用于判新 */ }
      written++;
    }
    fs.writeFileSync(marker, JSON.stringify({ sig, at: new Date().toISOString() }));
    const m = { ok: true, sessions, written, srcDir };
    if (useMemo) memo = m;
    return m;
  } catch (e) {
    const m = { ok: false, error: String(e?.message ?? e).split('\n')[0], sessions: 0, written: 0, srcDir };
    if (useMemo) memo = m;
    return m;
  }
}

/** 只同步一段会话（hub 重建前用）：按其 rollout 找投影；找不到就整体同步一次。 */
export function syncCodexSession(sessionId, { srcDir, outDir } = {}) {
  memo = null;   // 单会话同步作废全局去重，next listSessions 会重新比一遍
  return syncCodexProjections({ srcDir, outDir });
}

export function resetCodexMemo() { memo = null; }
