// 文档标题清单：阶段说明里要回答「跟原 PRD/plan 的完成度、progress 文件到哪」，
// 但工具不能把整份 PRD 塞进素材（token 大、文档一改就全过期），也不许让模型编文件名。
// 做法：只扫标题，编成 D1..Dn 的临时把手；模型引用 D 编号，写入口解析成 {f,h} 落盘。
// D 编号只在一次取材里有效——文档增删会让后续编号移位，所以 durable 的是解析后的 {f,h}。
import fs from 'node:fs';
import path from 'node:path';
import { DOC_MAX_FILES, DOC_MAX_HEADS, DOC_MAX_DEPTH } from './cost.mjs';

const SKIP = new Set(['reference', 'node_modules', '.git', 'out', 'asset', 'dist', 'build', '.qoder', '.idea', '.vscode']);
const FENCE = /^\s*(```|~~~)/;

function headsOf(text) {
  const all = [];
  let fenced = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m && m[2]) all.push({ line: i + 1, lv: m[1].length, h: m[2].trim() });
  }
  // 章节目录只取一二级标题：三级以下多是字段/子步骤，四百多条塞进素材会把
  // 步表挤到看不见的地方。整份文档没有一二级标题时才退回全部等级。
  const top = all.filter((x) => x.lv <= 2);
  return (top.length ? top : all).slice(0, DOC_MAX_HEADS).map(({ line, h }) => ({ line, h }));
}

/** Scan markdown headings under `root`. Missing root is an empty scan, not an error:
 *  a ledger can be read on a machine where the workspace no longer exists. */
export function scanDocs(root) {
  const docs = { root: String(root || ''), files: [], list: [] };
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return docs;
  const paths = [];
  (function walk(dir, rel, depth) {
    if (paths.length >= DOC_MAX_FILES || depth > DOC_MAX_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (paths.length >= DOC_MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, r, depth + 1); continue; }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      paths.push({ f: r.replace(/\\/g, '/'), heads: headsOf(text) });
    }
  })(root, '', 0);
  docs.files = paths;
  let n = 0;
  for (const file of paths) {
    for (const h of file.heads) docs.list.push({ id: `D${++n}`, f: file.f, h: h.h, line: h.line });
  }
  return docs;
}

export function resolveRef(docs, id) {
  return (docs?.list || []).find((x) => x.id === String(id || '').trim().toUpperCase()) || null;
}

/** Every heading as one line `D7 file › heading`; this is the only citation vocabulary. */
export function docMaterial(docs) {
  const list = docs?.list || [];
  if (!list.length) return '（工作区里没有可引用的 .md 标题：plan/track 两格只能写 —）';
  return list.map((x) => `${x.id} ${x.f} › ${x.h}`).join('\n');
}

export function docFilesUsed(docs, refs) {
  const seen = new Set();
  for (const r of refs || []) if (r?.f) seen.add(r.f);
  return [...seen];
}
