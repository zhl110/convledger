// convledger · OpenCode 插件（由 tool/hooks/install.mjs 安装到 ~/.config/opencode/plugins/）
// 只做转发：压缩时注 brief，会话空闲时提示收尾。判据与去重都在 hooks/opencode.mjs 里。
const CLI = (globalThis.process && globalThis.process.env && globalThis.process.env.CONVLEDGER_HOOK_CLI)
  || '<repo>/tool/hooks/opencode.mjs';

export const Convledger = async ({ client, $ }) => {
  const run = async (mode, sid) => {
    try {
      const out = await $`node ${CLI} ${mode} --session ${sid}`.text();
      return String(out || '').trim();
    } catch { return ''; }
  };
  const sidOf = (event) => (event && event.properties && (event.properties.sessionID || (event.properties.info && event.properties.info.id)))
    || (event && event.sessionID) || null;

  return {
    // 压缩时把「第一跳」推进新上下文；拿不到账本时 CLI 输出为空，这里就什么都不加。
    'experimental.session.compacting': async (input, output) => {
      const sid = (input && (input.sessionID || (input.session && input.session.id))) || null;
      if (!sid) return;
      const text = await run('brief', sid);
      if (text) output.context.push(text);
    },

    // 会话空闲且「有任务状态 + 有新素材 + 本轮有真人消息」时，像 Stop hook 一样提示一次。
    // 去重标记由 CLI 写（同一个人回合只提示一次），这里不重复判断。
    event: async ({ event }) => {
      if (!event || event.type !== 'session.idle') return;
      const sid = sidOf(event);
      if (!sid) return;
      const text = await run('closeout', sid);
      if (!text) return;
      try { await client.session.prompt({ path: { id: sid }, body: { parts: [{ type: 'text', text }] } }); }
      catch { /* 发送失败就等下一轮，不重试轰炸 */ }
    },
  };
};
