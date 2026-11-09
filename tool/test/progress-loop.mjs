#!/usr/bin/env node
// L3 增量闭环：prepare → put → status 的端到端夹具（隔离 store，不碰真实项目）。
// 只证明机械链：身份、冻结范围、版本、幂等、游标与「每份材料都要有处置」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectKey } from '../src/current.mjs';
import { prepareBatch } from '../src/sync.mjs';

const tools = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/').replace(/\/$/, '');
const CLI = `${tools}/bin/convledger.mjs`;
const RUN = `${tools}/out/test-runs/l3-${process.pid}-${Date.now().toString(36)}`;

const SID = 'aaaaaaaa-1111-0000-0000-000000000000';
const SID2 = 'bbbbbbbb-1111-0000-0000-000000000000';
const SID3 = 'bbbbbbbb-2222-0000-0000-000000000000';

let seq = 0;
function fixture() {
  const base = `${RUN}/case-${++seq}`;
  const proj = `${base}/proj`;
  const src = `${base}/src`;
  const store = `${base}/store`;
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  const rec = (o) => JSON.stringify(o);
  const session = (id, lines) => {
    const file = `${src}/${id}.jsonl`;
    fs.writeFileSync(file, [
      rec({ type: 'workspace-directories', directories: [proj] }),
      ...lines,
    ].join('\n') + '\n');
    return file;
  };
  const user = (n, text) => rec({ type: 'user', humanInput: true, uuid: `u${n}`, timestamp: `2026-10-28T00:0${n}:00.000Z`, message: { role: 'user', content: [{ type: 'text', text }] } });
  const asst = (n, text) => rec({ type: 'assistant', uuid: `a${n}`, timestamp: `2026-10-28T00:0${n}:30.000Z`, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const file = session(SID, [user(1, '把增量闭环接到 CLI'), asst(1, '先加 prepare，再加 put')]);
  return { base, proj, src, store, file, session, user, asst };
}

const runAt = (store, args, input) => spawnSync(process.execPath, [CLI, ...args, '--store', store], { cwd: tools, encoding: 'utf8', input });

test('L3：prepare→put→status 走通，游标推进、重放不重复、改写要拒绝', () => {
  const f = fixture();
  const key = projectKey(f.proj);
  const idx = runAt(f.store, ['index', f.file]);
  assert.equal(idx.status, 0, idx.stderr || idx.stdout);

  // 1) prepare：素材与批次身份，不写状态
  const p1 = runAt(f.store, ['sync', '--prepare', '--project', key, '--session', SID.slice(0, 8)]);
  assert.equal(p1.status, 0, p1.stderr || p1.stdout);
  const prep = JSON.parse(p1.stdout);
  assert.equal(prep.batchId.length, 24);
  assert.equal(prep.baseRevision, 0);
  assert.ok(prep.units.length >= 2, `素材应含用户与回复：${JSON.stringify(prep.units)}`);
  assert.ok(prep.used <= prep.budget);
  assert.ok(!fs.existsSync(`${f.base}/projects/${key}/progress-state.json`), 'prepare 不能写状态');

  // 2) put：建任务 + 事件 + 处置
  const payload = {
    batchId: prep.batchId, baseRevision: prep.baseRevision,
    taskChanges: [{
      localKey: 't1', short: '增量闭环', title: '把增量闭环接到 CLI', goal: 'prepare/put 可跑',
      status: 'active', scopeBasis: { kind: 'user-request', ref: '本会话要求' },
      acceptance: [{ id: 'A1', condition: 'prepare 与 put 都退出 0', required: true, kind: 'test', result: 'pending' }],
    }],
    events: [{ taskId: 't1', type: 'started', note: '开工' }],
    dispositions: prep.units.map((u) => ({ line: u.line, action: 'bound', task: 't1' })),
  };
  const put1 = runAt(f.store, ['sync', '--put', '-', '--project', key, '--session', SID.slice(0, 8)], JSON.stringify(payload));
  assert.equal(put1.status, 0, put1.stderr || put1.stdout);
  assert.match(put1.stdout, /已提交 · 版本 r1 · 新任务 1/);
  assert.match(put1.stdout, /记忆发布：无待发布/);

  const prog = runAt(f.store, ['progress', '--project', key]);
  assert.equal(prog.status, 0, prog.stderr);
  assert.match(prog.stdout, /PT001 \[进行中\] 增量闭环/);
  assert.match(prog.stdout, /已完成 0 \/ 纳入范围 1/);

  const progJson = JSON.parse(runAt(f.store, ['progress', '--project', key, '--json']).stdout);
  assert.equal(progJson.tasks.length, 1);
  assert.equal(progJson.revision, 1);

  // 3) 同批重放：不重复建任务
  const put2 = runAt(f.store, ['sync', '--put', '-', '--project', key, '--session', SID.slice(0, 8)], JSON.stringify(payload));
  assert.equal(put2.status, 0, put2.stderr);
  assert.match(put2.stdout, /同批重放/);
  assert.equal(JSON.parse(runAt(f.store, ['progress', '--project', key, '--json']).stdout).tasks.length, 1);

  // 4) 追加后 prepare：从上一批的 toByte 接着来
  const extra = f.user(2, '再加一条：状态要看得到欠项');
  fs.appendFileSync(f.file, `${extra}\n`);
  const p2 = JSON.parse(runAt(f.store, ['sync', '--prepare', '--project', key, '--session', SID.slice(0, 8)]).stdout);
  assert.equal(p2.range.fromByte, prep.range.toByte, '游标要接着上一批');
  assert.ok(p2.units.length >= 1);
  assert.notEqual(p2.batchId, prep.batchId);

  // 5) 已消费区间被改写：prepare 立即拒绝（exit 2），不静默跳过
  const buf = fs.readFileSync(f.file);
  buf[prep.range.fromByte + 20] ^= 0x01;
  fs.writeFileSync(f.file, buf);
  const p3 = runAt(f.store, ['sync', '--prepare', '--project', key, '--session', SID.slice(0, 8)]);
  assert.equal(p3.status, 2, p3.stdout);
  assert.match(p3.stdout, /检查点与当前源对不上/);

  // 6) status：只读，带检查点与批次
  const st = runAt(f.store, ['sync', '--status', '--project', key, '--json']);
  assert.equal(st.status, 0, st.stderr);
  const status = JSON.parse(st.stdout);
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].analyzedThrough, prep.range.toByte);
  assert.equal(status.batches.length, 1);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('L3：同一任务跨会话继续，歧义前缀拒绝写入', () => {
  const f = fixture();
  const key = projectKey(f.proj);
  runAt(f.store, ['index', f.file]);
  const file2 = f.session(SID2, [f.user(1, '接着做增量闭环，补上第二会话')]);
  runAt(f.store, ['index', file2]);

  const p1 = JSON.parse(runAt(f.store, ['sync', '--prepare', '--project', key, '--session', SID.slice(0, 8)]).stdout);
  const put1 = runAt(f.store, ['sync', '--put', '-', '--project', key, '--session', SID.slice(0, 8)], JSON.stringify({
    batchId: p1.batchId, baseRevision: p1.baseRevision,
    taskChanges: [{ localKey: 't1', short: '增量闭环', status: 'active', scopeBasis: { kind: 'user-request', ref: 'R' } }],
    dispositions: p1.units.map((u) => ({ line: u.line, action: 'bound', task: 't1' })),
  }));
  assert.equal(put1.status, 0, put1.stdout);

  const p2 = JSON.parse(runAt(f.store, ['sync', '--prepare', '--project', key, '--session', SID2.slice(0, 8)]).stdout);
  const put2 = runAt(f.store, ['sync', '--put', '-', '--project', key, '--session', SID2.slice(0, 8)], JSON.stringify({
    batchId: p2.batchId, baseRevision: p2.baseRevision,
    taskChanges: [{ id: 'PT001', patch: { status: 'awaiting-verification', result: '两段会话都接上了', sourceSessions: [SID, SID2] } }],
    events: [{ taskId: 'PT001', type: 'progressed', note: '第二会话继续' }],
    dispositions: p2.units.map((u) => ({ line: u.line, action: 'bound', task: 'PT001' })),
  }));
  assert.equal(put2.status, 0, put2.stdout);
  const view = JSON.parse(runAt(f.store, ['progress', '--project', key, '--json']).stdout);
  assert.equal(view.tasks.length, 1, '跨会话继续同一任务，不许长出新任务');
  assert.equal(view.tasks[0].status, 'awaiting-verification');
  assert.deepEqual(view.tasks[0].sourceSessions, [SID, SID2]);
  assert.equal(view.revision, 2);

  // 同前缀两段会话：写入口拒绝（exit 4），不取第一个
  const file3 = f.session(SID3, [f.user(1, '另一段同前缀会话')]);
  runAt(f.store, ['index', file3]);
  const amb = runAt(f.store, ['sync', '--prepare', '--project', key, '--session', 'bbbbbbbb']);
  assert.equal(amb.status, 4, amb.stdout);
  assert.match(amb.stdout, /命中 2 段会话/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('L3：素材超预算按记录切批，越界记录留到下一批', () => {
  const base = `${RUN}/budget`;
  const proj = `${base}/proj`;
  fs.mkdirSync(proj, { recursive: true });
  const lines = [JSON.stringify({ type: 'workspace-directories', directories: [proj] })];
  for (let i = 1; i <= 5; i++) {
    lines.push(JSON.stringify({ type: 'user', humanInput: true, uuid: `u${i}`, message: { role: 'user', content: [{ type: 'text', text: `第${i}条：${'长'.repeat(90)}` }] } }));
  }
  const file = `${base}/sess.jsonl`;
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const ledger = { sourceFile: file, runner: 'qoder' };
  const full = prepareBatch({ ledger, projectKey: 'p-b', sessionId: 's', fromByte: 0, baseRevision: 0 });
  const cut = prepareBatch({ ledger, projectKey: 'p-b', sessionId: 's', fromByte: 0, baseRevision: 0, budget: 60 });
  assert.ok(cut.frozen.toByte < full.frozen.toByte, '超预算时要按记录截批');
  assert.ok(cut.material.units.length >= 1);
  assert.ok(cut.material.omittedFrom > cut.material.units[cut.material.units.length - 1].line, '被留下的记录行号要报出来');
  assert.equal(cut.frozen.records.at(-1).line + 1, cut.material.omittedFrom, '批次覆盖到上一条完整记录');
  fs.rmSync(base, { recursive: true, force: true });
});
