// convledger · OpenCode 插件（V2 形状；由 tool/hooks/install.mjs 安装到 ~/.config/opencode/plugins/）
//
// OpenCode 2.x 只认 V2 插件：default export 一个 Plugin.define({ id, setup(ctx) })，
// 旧的「命名导出返回 hook 字典」形状在 2.x 里**不会被激活**（真机探针实测：只有 module-eval，没有 setup）。
// 本插件只做转发，判据/去重/闸门全在 hooks/opencode.mjs：
//   ctx.session.hook('compaction')  → brief 推进压缩请求的系统提示（拿不到账本就一个字不注）
//   session.execution.succeeded     → closeout 判定；有新素材就开一个后台会话去写账（哨兵防递归）
// 注意：session.idle 是 TUI 事件，插件订阅的是服务端公共事件流，收不到它。
import { Plugin } from '@opencode/plugin';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CLI = (globalThis.process && globalThis.process.env && globalThis.process.env.CONVLEDGER_HOOK_CLI)
  || '__CONVLEDGER_CLI__';
const MAIN = (globalThis.process && globalThis.process.env && globalThis.process.env.CONVLEDGER_CLI)
  || '__CONVLEDGER_MAIN__';
const NODE = (globalThis.process && globalThis.process.env && globalThis.process.env.CONVLEDGER_NODE) || 'node';
const TOOL_ROOT = path.posix.dirname(path.posix.dirname(MAIN.replace(/\\/g, '/')));
const CLAIM_DIR = `${TOOL_ROOT}/out/state/opencode-dispatch`;
const DISPATCH_GAP_MS = 10 * 60 * 1000;

function call(args, entry = CLI) {
  return new Promise((resolve) => {
    try {
      execFile(NODE, [entry, ...args], { timeout: 90000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim());
      });
    } catch { resolve(''); }
  });
}
const trace = (row) => {
  try {
    const file = process.env.CONVLEDGER_HOOK_LOG || '__CONVLEDGER_LOG__';
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), origin: 'opencode', ...row }) + '\n');
  } catch { /* 留痕失败不拖垮宿主 */ }
};

/** 跨插件实例的派活闸门。后台 service 与每个 TUI/CLI 会各加载一份插件，进程内 Map
 *  挡不住「同一个 execution.succeeded 被两个实例各派一次」（真机留痕成对出现）。
 *  10 分钟分桶 + wx 原子建文件：抢到文件的那一份才有权派，跨进程天然互斥。 */
function claimDispatch(sid) {
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    const bucket = Math.floor(Date.now() / DISPATCH_GAP_MS);
    const safe = String(sid).replace(/[^\w.-]/g, '_');
    const fd = fs.openSync(`${CLAIM_DIR}/${safe}.${bucket}`, 'wx');
    fs.writeSync(fd, new Date().toISOString());
    fs.closeSync(fd);
    for (const f of fs.readdirSync(CLAIM_DIR)) {   // 清掉过期分桶，别让状态目录涨
      const m = /\.(\d+)$/.exec(f);
      if (m && Number(m[1]) < bucket - 1) { try { fs.rmSync(`${CLAIM_DIR}/${f}`, { force: true }); } catch { /* 下次再清 */ } }
    }
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    return true;   // 状态目录写不了就别拦正常派活
  }
}

/** 已登记的 OpenCode 后台工作会话（封顶一段；没有才新建）。 */
async function opencodeWorker() {
  try {
    const raw = await call(['internal', '--json'], MAIN);
    const j = JSON.parse(raw || '{}');
    return (j.workers && j.workers.opencode) || null;
  } catch { return null; }
}

/** 新建的会话没有模型/代理就跑不动：从源会话抄过来。 */
function modelOf(info) {
  let m = info && info.model;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return null; } }
  if (m && m.id && m.providerID) return { providerID: m.providerID, id: m.id };
  return null;
}

const definition = {
  id: 'convledger',
  async setup(ctx) {
    // 1) 压缩边界：把「第一跳」推进压缩摘要的系统提示；CLI 输出为空就什么都不加。
    try {
      await ctx.session.hook('compaction', async (event) => {
        const sid = event && event.sessionID;
        if (!sid) return;
        const text = await call(['brief', '--session', sid]);
        if (text && Array.isArray(event.system)) event.system.push({ type: 'text', text });
      });
    } catch (e) {
      trace({ event: 'opencode.setup', action: 'compaction-register-failed', error: String(e?.message ?? e).split('\n')[0] });
    }

    // 2) 一轮结束：有未分析素材时，开一个后台会话写账，不占用当前对话。
    //    后台会话第一条消息带 [convledger-internal] 哨兵，CLI 侧与登记表都会跳过它，避免自我增殖。
    const inFlight = new Set();   // 同一实例内防并发；跨实例去重交给 claimDispatch 的落盘分桶
    const controller = new AbortController();
    void (async () => {
      try {
        const types = ['session.execution.succeeded', 'session.execution.interrupted'];
        for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
          const sid = event && event.data && event.data.sessionID;
          if (!sid || inFlight.has(sid)) continue;
          inFlight.add(sid);
          try {
            let text = await call(['closeout', '--session', sid]);
            if (!text) {
              // closeout 在「素材都分析完」时会直接 skip。可综述/阶段/记忆归纳的欠项还在，
              // 这家的欠项就永远补不上——退一步问 outstanding，有欠项就派一段补账会话。
              // 只有确实有欠项才派，否则每一轮都会空开一次。
              const od = await call(['outstanding', '--session', sid]);
              if (od && /块综述缺|支线题名缺|尾段第|项目记忆该归纳|用户画像该更新|待办请求/.test(od)) {
                text = '[convledger-internal] 本会话素材已分析完，但还有欠项。按下面逐条补齐，'
                  + '过闸门才落盘；没有可写的就如实标 no-change，不要编。\n' + od;
                trace({ event: 'opencode.closeout', session: sid, action: 'dispatch-by-outstanding' });
              }
            }
            if (!text) continue;
            // 两条派活路径统一在这里节流：以前只在 closeout 空文本那条分支判 Map，
            // 有新素材时每轮都派，且多个插件实例各派一次。
            if (!claimDispatch(sid)) {
              trace({ event: 'opencode.closeout', session: sid, action: 'throttled' });
              continue;
            }
            // 先复用已登记的工作会话；没有再新建（封顶一段，防越开越多）。
            let bgId = await opencodeWorker();
            if (bgId) {
              try { await ctx.session.prompt({ sessionID: bgId, text }); }
              catch { bgId = null; }   // 被归档/删掉了就重建
            }
            if (!bgId) {
              let info = null;
              try { info = await ctx.session.get({ sessionID: sid }); } catch { /* 拿不到目录就按插件位置建 */ }
              const directory = (info && (info.directory || info.location?.directory)) || ctx.location?.directory;
              let bg = null;
              try { bg = await ctx.session.create(directory ? { directory } : {}); }
              catch { bg = await ctx.session.create({}); }
              bgId = bg && (bg.id || bg.sessionID);
              if (!bgId) { trace({ event: 'opencode.closeout', session: sid, action: 'no-bg-session' }); continue; }
              // 新会话默认没有模型/代理：跑不动会 step.failed（真机踩过），从源会话抄过来。
              const model = modelOf(info);
              if (model) { try { await ctx.session.switchModel({ sessionID: bgId, model }); } catch { /* 抄不到就在下一轮重试 */ } }
              if (info && info.agent) { try { await ctx.session.switchAgent({ sessionID: bgId, agent: info.agent }); } catch { /* 同上 */ } }
              await call(['internal', '--add', bgId], MAIN);
              await call(['internal', '--set', bgId, '--host', 'opencode'], MAIN);
              await ctx.session.prompt({ sessionID: bgId, text });
            }
            trace({ event: 'opencode.closeout', session: sid, action: 'dispatch-bg', background: bgId });
          } catch (e) {
            trace({ event: 'opencode.closeout', session: sid, action: 'dispatch-failed', error: String(e?.message ?? e).split('\n')[0] });
          } finally {
            inFlight.delete(sid);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) trace({ event: 'opencode.setup', action: 'subscribe-failed', error: String(e?.message ?? e).split('\n')[0] });
      }
    })();

    trace({ event: 'opencode.plugin', action: 'ready' });
    return () => controller.abort();
  },
};

export default Plugin.define(definition);
