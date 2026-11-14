// LLM 后端：让工具自己调模型，不借宿主的 Agent。
//
// 用户口径（2026-11-13）：**只给一个 API key，剩下的工具自己认。**
// 三种接入走同一份存储、同一套调用：
//   ① `--key sk-…`        拿这个 key 逐个探已知端点，谁认就用谁
//   ② `--bridge`          读本机 OW Bridge 的 api-key + 探 127.0.0.1:41980/v1
//   ③ `--base-url …`      任意 OpenAI 兼容网关（Magpi / OpenRouter / 本地 Ollama 都走这条）
//
// 配置落 `<store>/llm.json`（`tool/out/` 已在 .gitignore 里，key 不入库）。
// 环境变量压过文件：CONVLEDGER_LLM_BASE_URL / _API_KEY / _MODEL。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export class LlmError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'LlmError'; this.status = status; }
}

const FILE = 'llm.json';

/** 候选端点：本机优先，其次主流云。都能用 OpenAI 兼容的 /models 与 /chat/completions。 */
export const KNOWN_ENDPOINTS = Object.freeze([
  { id: 'ow-bridge', label: 'OW Bridge（本机转接）', baseURL: 'http://127.0.0.1:41980/v1' },
  { id: 'omni-route', label: 'OmniRoute（本机转接）', baseURL: 'http://127.0.0.1:20128/v1' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1' },
  { id: 'siliconflow', label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1' },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
  { id: 'zhipu', label: '智谱', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'dashscope', label: '通义（兼容模式）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
]);

/** key 一律脱敏后再出现在任何回执里。 */
export function maskKey(k) {
  const s = String(k ?? '').trim();
  if (!s) return '（未设置）';
  if (s.length <= 10) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** OW Bridge 的本地数据目录（它把 api-key 写在这儿）。 */
export function bridgeDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'Buddy Bridge');
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Buddy Bridge');
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Buddy Bridge');
}

function llmFile(root) { return path.join(root, FILE); }

/** 读配置：文件打底，环境变量覆盖。configured 只认 baseURL + apiKey 都在。 */
export function readLlm(root) {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(llmFile(root), 'utf8')); } catch { file = null; }
  const env = {
    baseURL: process.env.CONVLEDGER_LLM_BASE_URL,
    apiKey: process.env.CONVLEDGER_LLM_API_KEY,
    model: process.env.CONVLEDGER_LLM_MODEL,
  };
  const merged = { ...(file ?? {}) };
  let source = file ? 'file' : 'none';
  for (const [k, v] of Object.entries(env)) {
    if (v) { merged[k] = String(v); source = 'env'; }
  }
  // enabled：后台自动补账的总开关（2026-11-13 用户要求）。默认开；文件里显式 false 才算关。
  // 环境变量压不过它——关掉开关是人的决定，不该被环境变量悄悄翻回来。
  const enabled = file ? file.enabled !== false : true;
  return { ...merged, source, enabled, configured: !!(merged.baseURL && merged.apiKey) };
}

/** 后台自动补账的总闸：接了 key 且开关是开。hook / 循环 / CLI 都认这一个判断。 */
export function llmOn(root) {
  const c = readLlm(root);
  return !!(c.configured && c.enabled);
}

export function writeLlm(root, cfg) {
  fs.mkdirSync(root, { recursive: true });
  const cur = readLlm(root);
  const out = {
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model ?? null,
    provider: cfg.provider ?? null,
    models: Array.isArray(cfg.models) ? cfg.models.slice(0, 200) : [],
    // 钥匙串跟着走：接上/换模型都只是改「当前用的」这条，贴过的 key 不丢
    savedKeys: Array.isArray(cur.savedKeys) ? cur.savedKeys : [],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(llmFile(root), JSON.stringify(out, null, 1));
  // 写盘后立刻回读：别让「以为写进去了」当成事实。
  return { ...readLlm(root), previous: cur.configured ? maskKey(cur.apiKey) : null };
}

export function clearLlm(root) {
  // 断开只清「当前接的」这条；钥匙串留着，下次点一下就换回来，不用重贴。
  let file = null;
  try { file = JSON.parse(fs.readFileSync(llmFile(root), 'utf8')); } catch { file = null; }
  if (!file) return false;
  fs.writeFileSync(llmFile(root), JSON.stringify({
    savedKeys: Array.isArray(file.savedKeys) ? file.savedKeys : [],
    enabled: file.enabled !== false,
    updatedAt: new Date().toISOString(),
  }, null, 1));
  return true;
}

/** 只翻开关，不动 key / 端点 / 模型。 */
export function setEnabled(root, on) {
  const p = llmFile(root);
  let file = {};
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { file = {}; }
  fs.writeFileSync(p, JSON.stringify({ ...file, enabled: !!on, updatedAt: new Date().toISOString() }, null, 1));
  return readLlm(root);
}

// ---- 钥匙串（savedKeys）：贴过的 key 记在本机，换端不重贴 ----
// 口径（2026-11-14 用户要求）：key 只在贴入那刻可见（输入框 password、接上即清空），
// 之后任何回执只给脱敏值；列表记住「哪条 key 属于哪家」，要用时点一下就切过去。
// 明文只躺在 tool/out/store/llm.json（gitignore 内），不进版本库、不进页面。

function keyId(apiKey) {
  return 'k-' + crypto.createHash('sha1').update(String(apiKey)).digest('hex').slice(0, 10);
}

function readRing(root) {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(llmFile(root), 'utf8')); } catch { file = null; }
  return { file, list: Array.isArray(file?.savedKeys) ? file.savedKeys.filter((e) => e && e.apiKey) : [] };
}

/** 存一条 key（按 key 本身去重；同一条重贴只更新归属信息）。models 一并记下，切换时不用重探。 */
export function saveKeyEntry(root, { apiKey, baseURL, provider, label, model, models }) {
  if (!apiKey || !baseURL) throw new LlmError('存 key 要给 apiKey 和 baseURL', 0);
  const { file, list } = readRing(root);
  const id = keyId(apiKey);
  const now = new Date().toISOString();
  const hit = list.find((e) => e.id === id);
  if (hit) {
    Object.assign(hit, {
      baseURL, provider: provider ?? hit.provider ?? null, label: label ?? hit.label ?? null,
      model: model ?? hit.model ?? null,
      models: Array.isArray(models) ? models.slice(0, 200) : hit.models ?? [],
      updatedAt: now,
    });
  } else {
    list.unshift({
      id, apiKey: String(apiKey), baseURL,
      provider: provider ?? null, label: label ?? null, model: model ?? null,
      models: Array.isArray(models) ? models.slice(0, 200) : [],
      addedAt: now, lastUsedAt: null,
    });
  }
  // 上限 10 条：再多的挤掉最久没用的（没记录用过的按加入时间算）
  const kept = list
    .sort((a, b) => String(b.lastUsedAt ?? b.addedAt ?? '').localeCompare(String(a.lastUsedAt ?? a.addedAt ?? '')))
    .slice(0, 10);
  fs.writeFileSync(llmFile(root), JSON.stringify({ ...(file ?? {}), savedKeys: kept, updatedAt: now }, null, 1));
  return listSavedKeys(root);
}

/** 列出钥匙串：一律脱敏，并标出哪条正在使用。 */
export function listSavedKeys(root) {
  const { list } = readRing(root);
  const cur = readLlm(root);
  const activeId = cur.apiKey ? keyId(cur.apiKey) : null;
  return list.map(({ apiKey, models, ...rest }) => ({
    ...rest,
    keyMasked: maskKey(apiKey),
    modelCount: Array.isArray(models) ? models.length : 0,
    inUse: activeId !== null && rest.id === activeId,
  }));
}

/** 切到钥匙串里的某一条：把它变成「当前接的」，并记 lastUsedAt。 */
export function useSavedKey(root, id) {
  const { file, list } = readRing(root);
  const hit = list.find((e) => e?.id === id);
  if (!hit) throw new LlmError(`钥匙串里没有 ${id} 这条（跑 convledger llm --keys 看列表）`, 0);
  hit.lastUsedAt = new Date().toISOString();
  fs.writeFileSync(llmFile(root), JSON.stringify({ ...(file ?? {}), savedKeys: list, updatedAt: hit.lastUsedAt }, null, 1));
  writeLlm(root, { baseURL: hit.baseURL, apiKey: hit.apiKey, model: hit.model, provider: hit.provider, models: hit.models });
  return readLlm(root);
}

/** 从钥匙串删一条。正在使用的那条不许删——删了会被 ensureActiveSaved 捞回来，白白制造错觉。 */
export function removeSavedKey(root, id) {
  const { file, list } = readRing(root);
  const cur = readLlm(root);
  const hit = list.find((e) => e?.id === id);
  if (!hit) return false;
  if (cur.apiKey && keyId(cur.apiKey) === id) throw new LlmError('这条正在使用，先断开（或切到别的）再删', 0);
  const kept = list.filter((e) => e.id !== id);
  fs.writeFileSync(llmFile(root), JSON.stringify({ ...(file ?? {}), savedKeys: kept, updatedAt: new Date().toISOString() }, null, 1));
  return true;
}

/** 已接上但钥匙串里还没有的 key（老配置 / 环境变量来的），自动收进串里，口径统一。 */
export function ensureActiveSaved(root) {
  const c = readLlm(root);
  if (!c.configured || !c.apiKey) return false;
  const { list } = readRing(root);
  if (list.some((e) => e?.id === keyId(c.apiKey))) return false;
  const ep = KNOWN_ENDPOINTS.find((x) => x.id === c.provider);
  saveKeyEntry(root, {
    apiKey: c.apiKey, baseURL: c.baseURL, provider: c.provider,
    label: ep?.label ?? (c.provider === 'custom' ? '自定义端点' : c.provider ?? '自定义'),
    model: c.model, models: c.models,
  });
  return true;
}

/** 挑默认模型：补账不需要旗舰，优先便宜快的。挑不到就取第一个。 */
export function pickModel(models = []) {
  const prefer = [/flash/i, /mini/i, /lite/i, /turbo/i, /free/i, /small/i];
  for (const re of prefer) {
    const hit = models.find((m) => re.test(m));
    if (hit) return hit;
  }
  return models[0] ?? null;
}

/** 把 fetch 那串 "fetch failed" 翻成人话：真原因藏在 cause 里，得从整条错误链上找。 */
export function describeNetError(e, timeoutMs) {
  if (e?.name === 'AbortError') return `超时（${timeoutMs}ms）`;
  const detail = [e?.cause?.code, e?.cause?.errno, e?.cause?.message, e?.code, e?.message]
    .filter(Boolean).join(' ');
  if (/ECONNREFUSED/i.test(detail)) return '端口没人听（服务没起？）';
  if (/ENOTFOUND|EAI_AGAIN/i.test(detail)) return '域名解析不了（拼写或断网？）';
  if (/CERT|certificate|self.signed|SSL|TLS/i.test(detail)) return 'TLS 握手失败（https/http 搞混了？）';
  if (/ETIMEDOUT/i.test(detail)) return `连接超时（${timeoutMs}ms）`;
  return detail ? detail.slice(0, 140) : '连不上';
}

async function tryEndpoint(ep, apiKey, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${ep.baseURL.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (r.status === 200) {
      const j = await r.json().catch(() => null);
      const models = (Array.isArray(j?.data) ? j.data : []).map((m) => m?.id).filter(Boolean);
      return { ...ep, ok: true, models };
    }
    return { ...ep, ok: false, status: r.status, reason: r.status === 401 || r.status === 403 ? 'key 不被这家接受' : `HTTP ${r.status}` };
  } catch (e) {
    return { ...ep, ok: false, reason: describeNetError(e, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只凭一个 key 找它的端点。
 * @returns {Promise<{hit: object|null, tried: object[]}>}
 */
export async function probeEndpoints(apiKey, { endpoints = KNOWN_ENDPOINTS, timeoutMs = 6000 } = {}) {
  const tried = [];
  for (const ep of endpoints) {
    const r = await tryEndpoint(ep, apiKey, timeoutMs);
    tried.push(r);
    if (r.ok) return { hit: r, tried };
  }
  return { hit: null, tried };
}

/** 本机 OW Bridge：读它的 api-key，再看端点活没活。 */
export async function detectBridge({ dataDir, timeoutMs = 1500 } = {}) {
  const dir = dataDir ?? bridgeDataDir();
  const keyFile = path.join(dir, 'api-key');
  if (!fs.existsSync(keyFile)) return { ok: false, reason: `没找到 ${keyFile}（OW Bridge 没跑过或没装在这台机器）` };
  const apiKey = fs.readFileSync(keyFile, 'utf8').trim();
  if (!apiKey) return { ok: false, reason: 'api-key 是空的' };
  const ep = KNOWN_ENDPOINTS.find((x) => x.id === 'ow-bridge');
  const r = await tryEndpoint(ep, apiKey, timeoutMs);
  return r.ok ? { ok: true, apiKey, baseURL: r.baseURL, models: r.models, provider: 'ow-bridge', label: r.label } : { ok: false, reason: r.reason };
}

/**
 * 一次补全调用（补账只需要这个）。
 * @returns {Promise<{text: string, usage: object|null, ms: number}>}
 */
export async function chat(cfg, { system, user, maxTokens = 2048, temperature = 0.2, timeoutMs = 90000 } = {}) {
  if (!cfg?.baseURL || !cfg?.apiKey) throw new LlmError('还没接模型：先跑 convledger llm --key <你的 key>', 0);
  if (!cfg?.model) throw new LlmError('没选模型：加 --model，或先跑 convledger llm --key <key> 让它自动挑', 0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${String(cfg.baseURL).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: ctrl.signal,
    });
    const body = await r.text();
    if (!r.ok) {
      const brief = body.replace(/\s+/g, ' ').slice(0, 240);
      const why = r.status === 401 ? 'key 不对或已失效'
        : r.status === 404 ? `模型 ${cfg.model} 不在这个端点上`
          : r.status === 429 ? '被限流了，稍后再试'
            : `HTTP ${r.status}`;
      throw new LlmError(`${why}：${brief}`, r.status);
    }
    let j;
    try { j = JSON.parse(body); } catch { throw new LlmError(`返回的不是 JSON：${body.slice(0, 200)}`, 0); }
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LlmError(`返回里没有 choices[0].message.content：${body.slice(0, 200)}`, 0);
    return { text, usage: j?.usage ?? null, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError(`连不上 ${cfg.baseURL}：${describeNetError(e, timeoutMs)}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** `llm --test` 的探活：一条极短的请求，只验通不通。 */
export async function testLlm(cfg, { timeoutMs = 30000 } = {}) {
  const r = await chat(cfg, { user: '回复两个字：通了', maxTokens: 16, temperature: 0, timeoutMs });
  return { ...r, reply: String(r.text).trim().slice(0, 40) };
}
