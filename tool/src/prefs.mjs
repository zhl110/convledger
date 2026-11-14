// 补账/收尾档位：什么时候让当前会话的 agent 把综述、收尾、画像补上。
//
// 三层覆盖（从高到低，逐字段解析）：
//   ① 会话级   store/<sid>/session-prefs.json   —— 每一段对话可各自不同
//   ② Agent 级 prefs.json 的 hosts.<runner>     —— 每一家宿主可各自不同（看板卡片里调）
//   ③ 机器级   prefs.json 顶层                  —— 这台机器的兜底
//
// 不再有内置宿主默认：WorkBuddy 也不再被写死「压缩时」，要压缩时由用户自己设。
//
//   each     每轮：Stop 时只要有一块已收口缺综述 / 有收尾欠项就拦一次
//   every5   综述：攒到 5 块缺综述再拦；收尾：攒到 5 个真人回合再拦
//   compact  压缩时：Stop 不拦，只在压缩边界（PostCompact / SessionStart(source=compact)）提一次
// 综述与收尾各有一份档位（summaryCadence / closeoutCadence），互不代替。
// 工具只读档位并写进提示；综述/收尾仍由 agent 写、工具验，闸门不放宽。
import fs from 'node:fs';
import path from 'node:path';

export const SUMMARY_CADENCES = ['each', 'every5', 'compact'];
export const CLOSEOUT_CADENCES = ['each', 'every5', 'compact'];
export const PROFILE_CADENCES = ['auto', 'off'];
export const PROFILE_LABELS = { auto: '自动', off: '关' };
// 同一个 every5 在两层含义不同：综述数块，收尾数真人回合。界面上也要分开写。
export const CADENCE_LABELS = { each: '每轮', every5: '缺 5 块', compact: '压缩时' };
export const CLOSEOUT_LABELS = { each: '每轮', every5: '每 5 轮', compact: '压缩时' };
// 自动建账档位（PRD-load）：新机器接入不许把历史全跑一遍——默认一个都不后台建，
// 只在你打开某段会话时建那一段（PRD-load §2.4）。想要全量或活跃集，显式改档位。
//   off     完全不后台建，只靠打开某段会话时建那一段——默认
//   active  只建活跃集（当前在看 ∪ 源 15 分钟内还在写）里的未建账会话
//   all     旧行为：所有未建账会话都建（机器强、想要全量时才用）
export const AUTO_BUILD_MODES = ['off', 'active', 'all'];
export const AUTO_BUILD_LABELS = { off: '关', active: '只建活跃', all: '全部' };

// 不再给单个宿主写死档位：所有宿主默认落到机器级，用户在看板设置里按 Agent 自己改。
// （2026-11-14 用户口径：WorkBuddy 也不再固定「压缩时」，需要时自己设。）
export const HOST_DEFAULTS = Object.freeze({});

const FILE = 'prefs.json';
const SESSION_FILE = 'session-prefs.json';
const SCHEMA = 'convledger-prefs/1';
const SESSION_SCHEMA = 'convledger-session-prefs/1';
const DEFAULTS = Object.freeze({ schema: SCHEMA, summaryCadence: 'each', closeoutCadence: 'each', profileCadence: 'auto', autoBuild: 'off', hosts: {}, updatedAt: null });

const pickCadence = (v, def) => (SUMMARY_CADENCES.includes(v) ? v : def);
const pickCloseout = (v, def) => (CLOSEOUT_CADENCES.includes(v) ? v : def);
const pickProfile = (v, def) => (PROFILE_CADENCES.includes(v) ? v : def);
const pickAutoBuild = (v, def) => (AUTO_BUILD_MODES.includes(v) ? v : def);
// 旧文件只有 summaryCadence；若它曾是 compact，就把收尾也迁成 compact，保持旧行为。
const migrateCloseout = (summary, closeout) => pickCloseout(closeout, summary === 'compact' ? 'compact' : 'each');

/** 机器级 prefs（含 Agent 级覆盖表 hosts）。 */
export function readPrefs(storeRoot) {
  const f = path.join(storeRoot, FILE);
  if (!fs.existsSync(f)) return { ...DEFAULTS, hosts: {} };
  try {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const hosts = {};
    if (p && typeof p.hosts === 'object' && p.hosts) {
      for (const [k, v] of Object.entries(p.hosts)) {
        if (!v || typeof v !== 'object') continue;
        const one = {};
        if (v.summaryCadence !== undefined) one.summaryCadence = pickCadence(v.summaryCadence, undefined);
        if (v.closeoutCadence !== undefined) one.closeoutCadence = pickCloseout(v.closeoutCadence, undefined);
        if (v.profileCadence !== undefined) one.profileCadence = pickProfile(v.profileCadence, undefined);
        if (one.summaryCadence === undefined) delete one.summaryCadence;
        if (one.closeoutCadence === undefined) delete one.closeoutCadence;
        if (one.profileCadence === undefined) delete one.profileCadence;
        if (Object.keys(one).length) hosts[k] = one;
      }
    }
    const summaryCadence = pickCadence(p?.summaryCadence, DEFAULTS.summaryCadence);
    return {
      schema: SCHEMA,
      summaryCadence,
      closeoutCadence: migrateCloseout(summaryCadence, p?.closeoutCadence),
      profileCadence: pickProfile(p?.profileCadence, DEFAULTS.profileCadence),
      autoBuild: pickAutoBuild(p?.autoBuild, DEFAULTS.autoBuild),
      hosts,
      updatedAt: p?.updatedAt ?? null,
    };
  } catch {
    // 坏文件按默认口径读，但把 corrupt 带回去，写入口会覆盖成合法 JSON。
    return { ...DEFAULTS, hosts: {}, corrupt: true };
  }
}

/** 只改调用方真的给了的键；未给就保留现值。返回新表，调用方负责展示。 */
export function writePrefs(storeRoot, patch) {
  const cur = readPrefs(storeRoot);
  const next = {
    schema: SCHEMA,
    summaryCadence: cur.summaryCadence,
    closeoutCadence: cur.closeoutCadence,
    profileCadence: cur.profileCadence,
    autoBuild: cur.autoBuild,
    hosts: { ...(cur.hosts ?? {}) },
    updatedAt: null,
  };
  if (patch?.summaryCadence !== undefined) {
    const v = String(patch.summaryCadence);
    if (!SUMMARY_CADENCES.includes(v)) throw new Error(`summaryCadence 要是 ${SUMMARY_CADENCES.join(' / ')}，收到「${v}」`);
    next.summaryCadence = v;
  }
  if (patch?.closeoutCadence !== undefined) {
    const v = String(patch.closeoutCadence);
    if (!CLOSEOUT_CADENCES.includes(v)) throw new Error(`closeoutCadence 要是 ${CLOSEOUT_CADENCES.join(' / ')}，收到「${v}」`);
    next.closeoutCadence = v;
  }
  if (patch?.profileCadence !== undefined) {
    const v = String(patch.profileCadence);
    if (!PROFILE_CADENCES.includes(v)) throw new Error(`profileCadence 要是 ${PROFILE_CADENCES.join(' / ')}，收到「${v}」`);
    next.profileCadence = v;
  }
  if (patch?.autoBuild !== undefined) {
    const v = String(patch.autoBuild);
    if (!AUTO_BUILD_MODES.includes(v)) throw new Error(`autoBuild 要是 ${AUTO_BUILD_MODES.join(' / ')}，收到「${v}」`);
    next.autoBuild = v;
  }
  // Agent 级：patch.host = { <runner>: {summaryCadence?, profileCadence} }，逐字段覆盖；null 值＝删该级。
  if (patch?.host !== undefined || patch?.hosts !== undefined) {
    const incoming = patch.host ?? patch.hosts;
    for (const [runner, v] of Object.entries(incoming || {})) {
      if (v === null) { delete next.hosts[runner]; continue; }
      if (!v || typeof v !== 'object') continue;
      const one = { ...(next.hosts[runner] ?? {}) };
      if (v.summaryCadence !== undefined) one.summaryCadence = v.summaryCadence === null ? undefined : pickCadence(v.summaryCadence, one.summaryCadence);
      if (v.closeoutCadence !== undefined) one.closeoutCadence = v.closeoutCadence === null ? undefined : pickCloseout(v.closeoutCadence, one.closeoutCadence);
      if (v.profileCadence !== undefined) one.profileCadence = v.profileCadence === null ? undefined : pickProfile(v.profileCadence, one.profileCadence);
      if (one.summaryCadence === undefined) delete one.summaryCadence;
      if (one.closeoutCadence === undefined) delete one.closeoutCadence;
      if (one.profileCadence === undefined) delete one.profileCadence;
      if (Object.keys(one).length) next.hosts[runner] = one; else delete next.hosts[runner];
    }
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(storeRoot, { recursive: true });
  const f = path.join(storeRoot, FILE);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, f);
  return next;
}

function sessionFile(storeRoot, sessionId) {
  return path.join(storeRoot, String(sessionId), SESSION_FILE);
}

/** 会话级覆盖（可只写一个键）；没有或坏文件返回 null。 */
export function readSessionPrefs(storeRoot, sessionId) {
  if (!sessionId) return null;
  try {
    const p = JSON.parse(fs.readFileSync(sessionFile(storeRoot, sessionId), 'utf8'));
    const one = {};
    if (p?.summaryCadence !== undefined) one.summaryCadence = pickCadence(p.summaryCadence, undefined);
    if (p?.closeoutCadence !== undefined) one.closeoutCadence = pickCloseout(p.closeoutCadence, undefined);
    if (p?.profileCadence !== undefined) one.profileCadence = pickProfile(p.profileCadence, undefined);
    if (one.summaryCadence === undefined) delete one.summaryCadence;
    if (one.closeoutCadence === undefined) delete one.closeoutCadence;
    if (one.profileCadence === undefined) delete one.profileCadence;
    return Object.keys(one).length ? one : null;
  } catch { return null; }
}

/** 写会话级覆盖；键传 null 表示删掉这一级、回到上层。 */
export function writeSessionPrefs(storeRoot, sessionId, patch) {
  const dir = path.join(storeRoot, String(sessionId));
  const f = sessionFile(storeRoot, sessionId);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { cur = {}; }
  const next = { schema: SESSION_SCHEMA, updatedAt: new Date().toISOString() };
  for (const k of ['summaryCadence', 'closeoutCadence', 'profileCadence']) {
    if (cur[k] !== undefined) next[k] = cur[k];
  }
  if (patch?.summaryCadence !== undefined) {
    if (patch.summaryCadence === null) delete next.summaryCadence;
    else {
      const v = String(patch.summaryCadence);
      if (!SUMMARY_CADENCES.includes(v)) throw new Error(`summaryCadence 要是 ${SUMMARY_CADENCES.join(' / ')}，收到「${v}」`);
      next.summaryCadence = v;
    }
  }
  if (patch?.closeoutCadence !== undefined) {
    if (patch.closeoutCadence === null) delete next.closeoutCadence;
    else {
      const v = String(patch.closeoutCadence);
      if (!CLOSEOUT_CADENCES.includes(v)) throw new Error(`closeoutCadence 要是 ${CLOSEOUT_CADENCES.join(' / ')}，收到「${v}」`);
      next.closeoutCadence = v;
    }
  }
  if (patch?.profileCadence !== undefined) {
    if (patch.profileCadence === null) delete next.profileCadence;
    else {
      const v = String(patch.profileCadence);
      if (!PROFILE_CADENCES.includes(v)) throw new Error(`profileCadence 要是 ${PROFILE_CADENCES.join(' / ')}，收到「${v}」`);
      next.profileCadence = v;
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, f);
  return next;
}

/**
 * 解析某段会话的实际档位：会话级 > Agent 级(prefs.hosts) > 内置宿主默认 > 机器级。
 * runner/sessionId 缺失时自动跳过对应层。autoBuild 是机器级（后台建账与单段对话无关），原样透传。
 */
export function resolvePrefs(storeRoot, { runner = null, sessionId = null } = {}) {
  const m = readPrefs(storeRoot);
  const host = (runner && m.hosts?.[runner]) || {};
  const builtin = (runner && HOST_DEFAULTS[runner]) || {};
  const sess = readSessionPrefs(storeRoot, sessionId) || {};
  const pick = (k) => sess[k] ?? host[k] ?? builtin[k] ?? m[k];
  const source = (k) => sess[k] !== undefined ? 'session' : (host[k] !== undefined ? 'host' : (builtin[k] !== undefined ? 'host-default' : 'machine'));
  return {
    summaryCadence: pickCadence(pick('summaryCadence'), DEFAULTS.summaryCadence),
    closeoutCadence: pickCloseout(pick('closeoutCadence'), DEFAULTS.closeoutCadence),
    profileCadence: pickProfile(pick('profileCadence'), DEFAULTS.profileCadence),
    autoBuild: m.autoBuild,
    // 每一层的来源，便于 CLI/页面讲清楚「这个值是哪层定的」。
    sources: {
      summaryCadence: source('summaryCadence'),
      closeoutCadence: source('closeoutCadence'),
      profileCadence: source('profileCadence'),
    },
  };
}
