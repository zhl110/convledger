// L1 structural ledger — the layer that only exists because someone computed
// it. Fan-out turns, tool counts, boundary accounting, the token-mass table:
// none of these are strings in the source log, so no summariser can "remember"
// them. One call must return all of them, or probes cost a read each.
import { tok, readJsonl, kb } from './lib.mjs';
import { normalizeRecords } from './project.mjs';

export function buildFacts({ runner, mainFile, sidecarDir, records, boundaries, branches, turns }, segments, opts = {}) {
  // 按片建账时由 window.mjs 递一片已 normalize 的记录进来；否则维持原来的整份重读。
  const raw = opts.rawRecords ?? normalizeRecords(runner, readJsonl(mainFile));
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const runtimeConfigs = raw.filter((r) => r.type === 'runtime-config' && r.model);
  const perRecordModels = raw.map((r) => r.__model).filter(Boolean);

  const meta = {
    runner,
    session: mainFile.replace(/\.jsonl$/, '').split('/').pop(),
    file: mainFile,
    sidecarDir,
    project: sidecarDir.split('/').slice(-2, -1)[0] ?? '',
    // Qoder states cwd once in a workspace-directories record; other runners only carry
    // it per record, so fall back to the first one that has it.
    cwd: raw.find((r) => r.type === 'workspace-directories')?.directories?.join(', ') ?? raw.find((r) => typeof r.cwd === 'string' && r.cwd)?.cwd ?? null,
    models: [...new Set([
      ...raw.filter((r) => r.type === 'runtime-config').map((r) => r.model),
      ...raw.map((r) => r.__model),
    ].filter(Boolean))],
    // 最后一条 runtime-config 就是当前在用的模型；老日志没有就留空，不猜。
    model: runtimeConfigs.length ? runtimeConfigs[runtimeConfigs.length - 1].model : (perRecordModels[perRecordModels.length - 1] ?? null),
    gitBranch: raw.find((r) => r.gitBranch)?.gitBranch ?? null,
    records,
    bytes: sum(raw, (r) => r.__bytes),
    lines: raw.length,
    span: [turns[0]?.ts, turns[turns.length - 1]?.ts].filter(Boolean),
    durationMin: turns.length ? Math.round((new Date(turns[turns.length - 1].ts) - new Date(turns[0].ts)) / 60000) : 0,
  };

  const byKind = turns.reduce((a, t) => ({ ...a, [t.kind]: (a[t.kind] ?? 0) + 1 }), {});
  const callsAll = turns.flatMap((t) => t.toolCalls);
  const byOp = callsAll.reduce((a, c) => ({ ...a, [c.op]: (a[c.op] ?? 0) + 1 }), {});
  const byName = Object.entries(callsAll.reduce((a, c) => ({ ...a, [c.name]: (a[c.name] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]);

  const fanouts = turns
    .map((t) => {
      const same = t.toolCalls.reduce((a, c) => ({ ...a, [c.name]: (a[c.name] ?? 0) + 1 }), {});
      const hit = Object.entries(same).filter(([, n]) => n >= 3).map(([name, count]) => ({ name, count }));
      return hit.length ? { turn: t.n, line: t.line, ts: t.ts, calls: hit, segment: segIdOf(segments, t.n) } : null;
    })
    .filter(Boolean);

  const written = {};
  for (const c of callsAll) if (c.paths.length && ['write', 'edit'].includes(c.op)) for (const p of c.paths) written[p] = (written[p] ?? 0) + 1;

  const mass = (uptoLine) => {
    const region = raw.filter((r) => !uptoLine || r.__line < uptoLine);
    const regionTurns = turns.filter((t) => !uptoLine || t.line < uptoLine);
    const calls = regionTurns.flatMap((t) => t.toolCalls);
    const chars = {
      dialogue: sum(regionTurns, (t) => t.humanText.length + t.assistantText.length),
      thinking: sum(regionTurns, (t) => t.thinkingChars),
      toolArgs: sum(calls, (c) => c.argChars),
      toolResults: sum(regionTurns, (t) => t.toolResultBytes),
      attachments: sum(region.filter((r) => r.type === 'attachment'), (r) => r.__bytes),
    };
    // args are counted at FULL length: what the model wrote (a Write payload) entered
    // the context whole — clipping here would understate the one category worth compressing.
    const t = {
      dialogue: tok(regionTurns.map((x) => x.humanText + x.assistantText).join('')),
      thinking: Math.round(chars.thinking / 4),
      toolArgs: Math.round(chars.toolArgs / 4),
      toolResults: Math.round(chars.toolResults / 4),
      toolRoundTrip: Math.round((chars.toolArgs + chars.toolResults) / 4),
      attachments: Math.round(chars.attachments / 4),
    };
    // second basis: the escaped bytes actually stored per record. The tokenizer
    // sees rendered text, the API bills serialised messages, and preTokens sits
    // between the two — so any single number here is a bracket, not a fact.
    const rawBasis = {
      dialogue: Math.round(sum(region.filter((r) => r.type === 'user' || r.type === 'assistant'), (r) => r.__bytes) / 4),
      attachments: Math.round(sum(region.filter((r) => r.type === 'attachment'), (r) => r.__bytes) / 4),
    };
    return { chars, tokens: t, rawBasis };
  };

  const boundaryLedger = boundaries.map((b, i) => {
    const prevBoundary = boundaries[i - 1];
    const from = prevBoundary ? prevBoundary.line + 1 : 1;
    const at = mass(b.line);
    const since = prevBoundary ? subMass(mass(b.line), mass(from)) : { tokens: at.tokens, rawBasis: at.rawBasis, chars: at.chars };
    // Context at a boundary is NOT the whole log before it: after the previous
    // compaction the model carried only its summary (postTokens) plus everything
    // added since. Measuring the full prefix would claim the log holds more than
    // the runner ever billed.
    const carried = prevBoundary?.postTokens ?? 0;
    const pre = b.preTokens ?? 0;
    const m = since.tokens;
    // Attachment records are NOT added: the log keeps every injection of the host's
    // task list, and between two compactions the same 95KB reminder appears dozens of
    // times — summed that exceeds the context the runner says it carried (measured it
    // was 1.2x preTokens at some boundaries). Only message content we can attribute
    // once stays in the content basis; attachment bytes are reported beside it.
    const measured = carried + m.dialogue + m.toolRoundTrip + m.thinking;
    const rawTotal = carried + since.rawBasis.dialogue + since.rawBasis.attachments;
    const unattributed = pre - measured;
    const share = (x) => (pre ? +((x ?? 0) / pre).toFixed(3) : null);
    return {
      line: b.line, trigger: b.trigger,
      preTokens: b.preTokens, postTokens: b.postTokens,
      messagesSummarized: b.messagesSummary, durationMs: b.durationMs,
      compactionRatio: pre && b.postTokens ? +(1 - b.postTokens / pre).toFixed(3) : null,
      tokensSaved: pre && b.postTokens ? pre - b.postTokens : null,
      region: `L${from}-${b.line}`,
      turnsBefore: turns.filter((t) => t.line < b.line && !t.sidechain).length,
      turnsInRegion: turns.filter((t) => t.line >= from && t.line < b.line && !t.sidechain).length,
      toolCallsBefore: turns.filter((t) => t.line < b.line).flatMap((t) => t.toolCalls).length,
      toolCallsInRegion: turns.filter((t) => t.line >= from && t.line < b.line).flatMap((t) => t.toolCalls).length,
      carriedFromPreviousBoundary: carried,
      massTokensInRegion: m,
      massCharsInRegion: since.chars,
      contextComposition: { carried, dialogue: m.dialogue, toolRoundTrip: m.toolRoundTrip, thinking: m.thinking, unattributed },
      attachmentRecords: { tokens: m.attachments, share: share(m.attachments) },
      shareOfRunnerReportedContext: {
        dialogue: share(m.dialogue), toolRoundTrip: share(m.toolRoundTrip), thinking: share(m.thinking),
        unattributed: share(unattributed), carried: share(carried),
      },
      reconciles: {
        preTokens: pre,
        measuredContentBasis: measured,
        rawRecordBasis: rawTotal,
        unattributed,
        unattributedShare: pre ? +(unattributed / pre).toFixed(3) : null,
        bracket: b.preTokens == null
          ? `content basis ${measured} (runner reported no token counts) <= raw record basis ${rawTotal}`
          : `content basis ${measured} <= runner ${pre} <= raw record basis ${rawTotal}`,
        note: 'categories are measured on rendered content added since the previous boundary (lower bound); the runner bills serialised records (upper bound); unattributed covers system prompt + tool definitions + per-message envelope, and goes negative when the runner truncated results the log kept whole; attachmentRecords is log bytes and is never added — repeated host injections would overstate the context',
      },
    };
  });

  const whole = mass(null);
  const wholeFileBytes = meta.bytes;

  return {
    session: meta,
    turns: {
      total: turns.length,
      ...byKind,
      zeroContent: turns.filter((t) => t.zeroContent).length,
      zeroContentRate: +(turns.filter((t) => t.zeroContent).length / turns.length).toFixed(3),
      sidechain: turns.filter((t) => t.sidechain).length,
      note: 'total counts every user-type record as a turn, including tool-result carriers; human = real user input',
    },
    toolCalls: {
      total: callsAll.length,
      byOp,
      topNames: Object.fromEntries(byName.slice(0, 12)),
      resultBytesTotal: callsAll.reduce((a, c) => a + c.resultBytes, 0),
      biggestResults: callsAll.map((c) => ({ name: c.name, bytes: c.resultBytes, line: c.line, turn: segTurnOf(turns, c.id), arg: c.arg.slice(0, 80) })).sort((a, b) => b.bytes - a.bytes).slice(0, 5),
      errors: callsAll.filter((c) => c.isError).map((c) => ({ name: c.name, line: c.line, head: c.resultHead.slice(0, 120) })),
    },
    fanouts,
    branches: {
      total: branches.length,
      bytesTotal: branches.reduce((a, b) => a + (b.bytes ?? 0), 0),
      linkBasis: [...new Set(branches.map((b) => b.link))],
      hosts: branches.reduce((a, b) => { const k = b.parentTurn ?? 'unlinked'; a[k] = a[k] ?? []; a[k].push(b.description); return a; }, {}),
    },
    artifacts: Object.entries(written).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([path, times]) => ({ path, times })),
    boundaries: boundaryLedger,
    wholeFile: {
      bytes: wholeFileBytes,
      bytesHuman: kb(wholeFileBytes),
      tokens: whole.tokens,
      // what reading the session would cost: attachment records repeat, so they are
      // not part of "the context a reader would have to re-read"
      contentTokens: whole.tokens.dialogue + whole.tokens.toolRoundTrip + whole.tokens.thinking,
      byRecordType: Object.entries(raw.reduce((a, r) => { a[r.type] = (a[r.type] ?? 0) + r.__bytes; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([type, bytes]) => ({ type, bytes, pctOfBytes: +(bytes / wholeFileBytes).toFixed(3) })),
      attachmentsBySubtype: Object.entries(raw.filter((r) => r.type === 'attachment').reduce((a, r) => { const k = r.attachment?.type ?? 'other'; a[k] = (a[k] ?? 0) + r.__bytes; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([subtype, bytes]) => ({ subtype, bytes })),
    },
    segments: {
      total: segments.length,
      byKind: segments.reduce((a, s) => ({ ...a, [s.kind]: (a[s.kind] ?? 0) + 1 }), {}),
      toolCallsBySegment: Object.fromEntries(segments.map((s) => [s.id, s.toolCalls])),
      toolCallsSumCheck: segments.reduce((a, s) => a + s.toolCalls, 0),
      dialogueTokens: segments.reduce((a, s) => a + s.tokens.dialogue, 0),
      toolTokens: segments.reduce((a, s) => a + s.tokens.toolRoundTrip, 0),
    },
  };
}

/** Region mass = prefix(before) minus prefix(before the region). The CJK-aware
 *  token estimate is additive enough at this granularity to subtract. */
const subMass = (a, b) => ({
  tokens: Object.fromEntries(Object.keys(a.tokens).map((k) => [k, (a.tokens[k] ?? 0) - (b.tokens[k] ?? 0)])),
  rawBasis: Object.fromEntries(Object.keys(a.rawBasis).map((k) => [k, (a.rawBasis[k] ?? 0) - (b.rawBasis[k] ?? 0)])),
  chars: Object.fromEntries(Object.keys(a.chars).map((k) => [k, (a.chars[k] ?? 0) - (b.chars[k] ?? 0)])),
});

const segIdOf = (segments, turnN) => segments.find((s) => turnN >= s.turnFrom && turnN <= s.turnTo)?.id ?? null;
const segTurnOf = (turns, callId) => turns.find((t) => t.toolCalls.some((c) => c.id === callId))?.n ?? null;
