---
name: convledger
description: 用 convledger 账本回答「之前做到哪了 / 上次那个是怎么做的」并维护会话地图：一个 hub 服务所有会话（固定 8765、画布按 /s/<ID>/ 寻址、两个 agent 可同时用）、压缩后第一跳 brief、块表 steps、按锚点回源读原文 body、已证增量 claim、块综述与阶段括号（summarise/phases --put）、章层与接手页（chapters --put、handoff）、跨会话记忆（memory 读取/--digest/--put/--promote/--unpromote/--forget，项目表＋用户画像）、项目工作台（/p/<键>/ 四档＋依赖箭头）、token/credits 用量看板（usage）、代码更新后同步工具状态（upgrade）与收尾同步（progress、sync --prepare/--put）。绝对入口 node {{TOOL_ROOT}}/tool/bin/convledger.mjs。当用户问及本会话或本项目的进度、历史决策、某一步做了什么，要写或改块综述、任务题名、阶段说明、章、项目记忆/用户画像，或要看会话地图/路线图（atlas）、补账档位、经验画像、架构页时使用；触发词：convledger、token 用量、usage、账本、brief、锚点回读、块综述、阶段括号、handoff、接手页、章、项目记忆、用户画像、晋升、memory、导出、项目进度、任务进度、收尾检查、补账、sync、项目工作台、会话地图、路线图、atlas、架构页、经验画像、工具版本、upgrade、工作台没更新。
---

# convledger 会话账本

## 入口：先认这一条

- 工具入口（绝对路径）：`{{TOOL_ROOT}}/tool/bin/convledger.mjs`
- 调用方式，在任何目录、任何宿主里都成立：

  ```
  node {{TOOL_ROOT}}/tool/bin/convledger.mjs <命令> [参数] [--session 会话前8位]
  ```

  下文把这一长串简写为 `convledger <命令>`，展开就是上面这行。
- 账本目录：`{{TOOL_ROOT}}/tool/out/store/<会话ID>/`，全是派生数据，可随时重建。
- 页面：`http://127.0.0.1:8765/`（一个 hub 服务所有会话：`/` 是会话库，每段会话的画布在 `/s/<ID>/`；**项目工作台在 `/p/<项目键>/`**，四档缩放、依赖箭头、任务↔原文往返；**应用看板在 `/app`**，是 `convledger app` 应用窗口的落点——左侧导航、五家 agent 卡片（源/Skill/hooks/最近事件、一键连接/修钩子/装 Skill）、最近会话、经验与记忆、钩子事件，5 秒刷新；左栏六入口「看板 / 会话 / 地图 / 工作台 / 用量 / 架构」都在 App 壳内切换，不跳网页库；用量页（`/app?view=usage`）按 agent、每个会话、每次注入列出宿主上报的 token/credits 与本工具回读开销，宿主没上报就写未上报；地图与工作台以 `?embed=1` 内嵌（各自隐藏品牌/视图 tab/左栏清单，只留一条功能控件），整屏只有一套导航，不再像「整页塞进一块板」；工作台顶栏有项目下拉（只列有任务状态的项目）；旧 `/status` 302 到 `/app`）。页面顶部「会话实时」读最近一段账本，显示第几步、哪一块、还有多少字节没收尾，每 5 秒更新，不等 `sync --put`。**还没跑过收尾的项目工作台不是裸 404**：有会话时给空状态页（说明任务状态要同步才生成、给可复制的 `sync --prepare` 命令、列出项目里的会话、留返回入口）；一个会话都没有才回 404，页面同样带导航。
- 会话库：标题优先读桌面端工作区里的会话名（Qoder 的 `chat_sessions.title`，只读库，不写宿主），读不到才回落到账本派生的任务/块/阶段标题；左栏 agent 分组可拖动排序（或 Alt+↑↓），顺序存在本机，会话库与画布共用。每一行都标整理过没有：绿「已整理 · 综述 234/236 · 阶段 29 · 题名 196/196」/ 黄「欠 N 项 · …」/ 灰「未整理 · 只有结构账」，判据与 `convledger outstanding` 同一条（锚点失效的旧综述不算）；顶栏「全部」按钮循环切「只看未整理 / 只看整理过」，总数行给「整理过 N / 总数」，画布左栏同一条会话上也有这个小标。
- 项目工作台与导出：顶部两块实时内容随账本刷新——「经验 · 按阶段」（块综述 lesson 按会话＋阶段收拢，点会话号回画布）与「用户画像 · 做事方式」（用户表＋项目表条目，0 条如实写）；画布阶段六格下也有「这一程的经验」。`convledger export` 把经验写进 `PROGRESS.md`，并生成 `out/exports/projects/<项目名>--<项目键>/sessions/<会话>-notes.md` 会话笔记。项目工作台每 5 秒按 revision 自动刷新（档位与选中保留），新任务不用手动刷。
- 架构页与页面往返：架构页在会话库顶栏（`/architecture`），画整个工具的模块架构图＋PM/PT 工作路线图（可点、可搜、可缩放；路线图进页面时实时读项目状态，不再是快照），不属于任何一段会话，别挂到画布顶栏。会话画布顶栏的「▤ 工作台」直接跳项目工作台（按会话 cwd 算项目键）；项目工作台顶栏随之出现「← 返回会话」，回到刚才那段对话的画布并保留档位与选中；从项目工作台点任务里的来源会话进画布时，画布也会显示「← 返回项目」。
- **代码更新后先跑** `convledger upgrade`（`convledger upgrade --check` 只报告不同步项）：同步五家已装 Skill 副本、重启常驻 hub、登记代码版本水位。`git pull` 落地后由 `post-merge` hook 自动跑一次（`convledger on` 装、另一台电脑接入时也跑一次 `on`）；**手工改完源码、或开场 brief 出现「工具版本」提示**时仍要自己跑一次；`--check` 出现 ✗ 就说明工作台还在跑旧版。幂等，已是最新时不重启。若是在 Agent 的命令会话里拉的，新 hub 可能被会话清理带走，宿主下一个事件会就近补起。
- 这个文件不存在 = 本机没装这套工具。先确认仓库还在 `{{TOOL_ROOT}}`；新设备直接跑 `node {{TOOL_ROOT}}/tool/bin/convledger.mjs setup --no-open`（体检、找宿主、**按检测到的宿主装 Skill/hooks**——Qoder/Claude Code/WorkBuddy 写 settings.json，Codex 写 `hooks.json`，OpenCode 装插件——**只建你此刻正在用的那一段的账，历史一段都不建**（打开哪段建哪段）、桌面入口、起 hub 一次做完，结尾四行「下一步」说明还缺什么；`--build N`/`--all` 才建历史，`--check` 只看计划，`--uninstall` 只撤自己写的条目；`--open` 会开系统浏览器，在 Agent 内不要加），再用内置浏览器打开 `/`。桌面入口：Windows 写快捷方式，Linux 写 `.desktop` 应用菜单项；macOS 尚未在真机实测。

## 它是什么

从五种宿主（Qoder `~/.qoder/projects`、Claude Code `~/.claude/projects`、WorkBuddy `~/.workbuddy/projects`、OpenCode `~/.local/share/opencode/opencode.db`、Codex `~/.codex/sessions/**/rollout-*.jsonl`——后两种先投影成 `out/opencode/<会话>/<会话>.jsonl`、`out/codex/<会话>/<会话>.jsonl` 再走同一条管线）的 append-only JSONL 里派生出「段 → 块 → 步 → 阶段 → 章」五层结构和锚点（OpenCode 来源要 Node ≥22.5，低于它只是那一家跳过；Codex 的助手/工具/压缩映射按 rollout 格式写、本机暂无此类样本故标注未实测）。正文一个字都不搬进账本——除了画布服务过的会话会留一份逐字归档（见下节）。

同一个 store 收所有会话，`--session <前缀>` 不分宿主；`ledger.json` 的 `runner` 字段写明来源。store 里只有一个账本时可省略 `--session`，否则先 `convledger sessions`。

## 一个 hub 服务所有会话（最容易用错的一条）

1. **不用挑会话。** `convledger map` 自己认「跑这条命令时所在的会话」，优先级：`--session` > 环境变量 `CONVLEDGER_SESSION` > 同工作目录里源文件最新的那段 > 全机最新写入的那段。认出来的会话还没建账就先建。
2. **一个地址，会话在路径里。** hub 固定 `http://127.0.0.1:8765`，本会话画布是 `/s/<会话ID>/`；`/` 是会话库整页。
3. **两个 agent 同时用＝同一端口下两个路径。** 谁也不抢端口；左栏照样列全部会话，点一行进 `/s/<id>/`。
4. **端口 8765 被别的程序占用时自动顺延到下一个空位**（临时运行办法）：`map`/`setup`/`app`/`url` 先复用已有 hub（哪怕它上次顺延到了临时端口），没有则首选 8765、被占就顺延并打印临时地址；腾出 8765 后重跑 `convledger map` 回到 8765。也可 `--port N` 直接指定。
5. **hub 是常驻进程。** `map` 探 `GET /health`，是 hub 就直接用；不是就 detached 起一个（`map --serve`），命令立刻返回，不随调用它的 agent/终端退出。`map --stop` 停。
6. **画布是这段会话的复刻，且能兜底。** 段、块、步、原话都由它自己的 transcript 派生。画布首次被访问和每次重建前都把源日志逐字同步进 `out/store/<会话>/source.jsonl`；源日志被宿主清掉后，`body`、`anchors`、`find` 与画布一起回落到归档，输出第一行声明「读自归档……不是新的真相」。
7. **旧地址仍能开**：`/atlas` → 最近写入的那段会话画布；`/open?session=<前缀>` → 302 到 `/s/<全 ID>/`。

## 工作流 0：把会话画布拉起来

1. 探活（认 hub，不认端口通不通）：

   ```
   curl -s http://127.0.0.1:8765/health
   ```

   回 `{"ok":true,"hub":true,...}` 就是 hub 在跑；没有就跑下一步。

2. 一条命令拿到本会话地址（没起会自己起）：

   ```
   node {{TOOL_ROOT}}/tool/bin/convledger.mjs map
   ```

   横幅写明 `http://127.0.0.1:8765/s/<会话>/`、会话、runner、cwd、段数、归档大小。常用旗标：`--port N`（换整个 hub 的端口）、`--rebuild SEC`（重建间隔，默认 20；`0` = 只读不重建，归档仍同步）、`--session <前缀>`、`--open`（系统浏览器打开）、`--stop`（停 hub）。

3. 用户要看页面时，用 **Qoder 桌面端的内置浏览器**打开（`browser-use` 的 `navigate_page`），**不要**用系统浏览器 `cmd start`——内置面板只有 agent 在对话里能唤醒，脚本唤不起。面板已开着同一地址就刷新，别另开。agent 自己跑 `map`/`setup` 时**不要加 `--open`**（那只开系统浏览器）；拿到打印的地址后由你用内置浏览器打开。
4. 用户不需要记网址：`/` 是会话库，本会话画布地址由 `map` 横幅给出。**页面关掉不会停 hub**——回来时双击桌面或开始菜单「convledger 地图」（现在打开的是无地址栏的专属应用窗口，走 `convledger app`，落在 `/app` 本机看板），或跑 `convledger url --copy`（确保 hub 在跑并把地址放进剪贴板）。浏览器访问照旧：`http://127.0.0.1:8765/`。**地址常驻**：开始菜单搜 convledger 就有入口，用户问地址优先给 `http://127.0.0.1:8765/`。
5. 页面每 4 秒重读账本；点块＝选中＋推近＋右栏，点阶段括号牌＝六格说明，**点章括号牌＝九格接手页**（主线行上方现在是两条带：上面章、下面阶段；章牌写 `章 N · 第 a–b 步 · 章名`，面板里就是 `convledger handoff` 那几格，另有「定位到第 N 步」与「复制 handoff」——接手页文本只有一份，由 hub 的 `/handoff` 出），**左上角还常驻一张「章笔记」**：视口正中那一张块属于哪一章，卡就写那一章的目的／走到哪／怎么接手（按屏幕像素排，12% 的「适应」档也读得出；章牌里的字是世界像素，那一档只剩 4px），末尾一枚「打开九格」进同一份接手页，没写章或搜索清单出现时这张卡让位，搜索框找块与段，底部续做框写请求。**块间连线是流式的**：缺口沿行进方向朝箭头走（灰＝主线，橙虚线＝宿主步岔出插曲，绿虚线＝汇回主干），只改画法，不改线的走法、端点与箭头；系统开了「减少动态」就整层停住。**中景保持原块**（阶段信息由上方括号牌承担），近景是全明细；已写阶段之后的新内容在「尾段」（虚线占位带）里按真人提问一条一块，尾段说明待写时如实标出。右栏近景写「我的要求 / 经验 / 做成什么」，原话只在原文入口，不再复读「你说的/我回的」；任务行会写「这一步在做…」，主线任务没有模型题名时显示未命名，不拿原话顶替。右下角「已同步 · 落后 N 秒」里的 N（构建时间在悬停提示里）是源最后写入与账本构建之差，**0 才代表画到了最新**；块综述/阶段/任务题名是模型写的，不随重建自动变。

## 工作流 1：建账与更新

- **接手一个项目先读导出**：工具目录 `out/exports/projects/<项目名>--<项目键>/PROGRESS.md`（没有就跑一次 `convledger export`），再看同目录 `USER-PROFILE.md`；历史快照查 `INDEX.md`，跨项目先看 `convledger export --list`。**文件存在不等于新鲜**：`convledger export --check` 说新鲜再用，过期先 `convledger export`。
- 接手继续做之前，先 `convledger brief`（头行带待办请求条数、附最近的请求原文）和 `convledger requests --pending`：地图底部输入框只会把请求写进账本，不会把消息推进会话——不查就看不见。
- `convledger index <session.jsonl|目录>` 建单个账本；`convledger index --all [--project P] [--limit N]` 批量（只出统计）。
- `convledger sessions` 看哪些已建账、哪些还没有，并直接给出**每本整理过没有**（判据与 `outstanding` 同一条：hash 还有效的块综述/题名/阶段/已证增量，失效的不算）；默认只列最肥 8 本，`--all` 逐本列全，`--json` 才给源文件路径。要跨会话补链就 `sessions --all` 挑「未整理」的那几本。
- 重建是幂等的：段、块、步、阶段边界全从源 JSONL 现算，源变了重跑一次即可。
- 压缩边界自动推送：`node {{TOOL_ROOT}}/tool/hooks/install.mjs [--client qoder|claude-code|workbuddy|codex|opencode|all] [--probe|--remove]` 把 `SessionStart`／`PreCompact`／`PostCompact`／`Stop` 挂进用户级配置。**所有项目的会话都管**：每段会话按自己的 transcript 建账并注入自己的 brief，不按 cwd 划界（cwd 只在新会话还没有自己源文件时借读同项目的账本）。PreCompact 只重建账本，PostCompact／SessionStart 注 brief；去重按「来源＋事件＋会话」三键，跨事件不互相消音，压缩边界不吃同文去重。注册形状按宿主分：Qoder 吃 `{command, args}`；Claude Code 与 WorkBuddy 吃 `command` shell 串（settings.json）；Codex 是 `~/.codex/hooks.json` 里的 `{hooks:{事件:[{hooks:[{type:'command',command,commandWindows,timeout}]}]}}`（hooks 仍是 beta，装完可能要在 Codex 里确认信任）；OpenCode 走插件 `~/.config/opencode/plugins/convledger.js`——**2.x 只认 V2 形状**（`Plugin.define({id, setup(ctx)})` + `ctx.session.hook('compaction')` + `ctx.event.subscribe`），旧的命名导出返回 hook 字典在 2.x 里连 setup 都不会跑（真机探针实测）；收尾挂在服务端的 `session.execution.succeeded/interrupted`（`session.idle` 只在 TUI 层，插件收不到）。**实证边界（2026-11-13 全表核对）**：Qoder / Claude Code / WorkBuddy / OpenCode 四家的投递与后台派活都已真机跑通（**不是只有 Qoder 和 WorkBuddy 能用**），Codex hooks 仍是 beta、未实测投递。答「哪家能用」前先跑 `convledger caps --json` 看 `status` / `gaps`；CHANGELOG 里的「未实测」是当时结论，不许当现状转述。**改派活方式前先 `convledger caps` 核工具名与 evidence**：凭印象写工具名（给 Claude Code 写 `Task`、把 Qoder 的 `create_chat_session` 抄给别家）会给出一条模型执行不了的指令，工具会把它拦成「不派」。
- 收尾检查（Qoder 已注册）：**已接模型后端（`convledger llm`）时这一跳不再派后台会话**——hook 静默起 `closeout --auto`，由它接管全部欠项：块综述、收尾任务（sync）、任务题名、阶段、项目记忆、用户画像，每段落盘仍走各自的 `--put` 闸门。以下派发流程只在**没接模型**时生效。没接时 `Stop` hook 只在「有未分析素材 + 本轮有真人消息」时提示一次，但**只发一句「后台收尾」派发信号**——不再把整段 sync 指令塞进当前对话让人在这里逐批磨。当前对话只做一件事：调一次宿主能力另起一段**独立后台会话**去做收尾。**Qoder 用 `create_chat_session`（`callbackMode=supervise`，它沿用当前对话的模型）**；其他宿主按 `convledger caps` 的能力表走：WorkBuddy / Claude Code 用 `Agent`（`run_in_background: true`）开后台子代理，OpenCode 由插件自己派（agent 不用管），Codex 不派。别把 Qoder 的会话工具套到别家，也别凭印象改工具名（先 `convledger caps` 看 evidence；被拦成「不派」就照做，不换写法重试）；派完立即结束本轮，别在当前对话里逐批处理。**只能用宿主当前正在用的模型**，不许在工具里另接 claude/codex 之类外部模型。**项目还没有任务表时提示首次建表**（后台会话里 `sync --prepare` + `taskChanges` 用 `localKey` 建首批任务）；信号里附手动兜底命令；派发失败/无该能力时可手动跑兜底命令，仍不 block 当前对话。**派出的后台会话 prompt 必须以哨兵 `[convledger-internal]` 开头**——hook 见到源头带哨兵的会话一律不触发收尾，防止「总结工具再总结自己的后台会话」无限派生；否则它会自我增殖。**能复用 worker 的宿主（Qoder 独立会话 / OpenCode 插件）别每次新开**：先 `convledger internal` 看 worker id，有就 `send_message_to_chat_session` 续派、没有才 `create_chat_session` 新建（prompt 以 `[convledger-internal]` 开头）并 `convledger internal --set <id>` 记住；这类内部会话已从会话库与画像统计里隐藏。WorkBuddy / Claude Code 这类后台子代理型每轮新开是正常的，别硬套 `internal --set`。`stop_hook_active` 放行，不循环。
- 收尾时先跑 `convledger outstanding` 看链路欠项（综述/题名/尾段阶段/候选/请求）；**已接模型时这些欠项由 `closeout --auto` 自动接管，不必手动补**——下面保留手动兜底（没接模型或循环失败时用）。写新综述前先 `convledger lessons` 看已有经验，避免重复；再顺带补**新块的综述**：`convledger summarise --missing` 看缺哪些 → `convledger digest --block <本轮几块>`（**分小批：一次只拿最近 3–4 块素材**，别全补）→ 按五格一次写成 `{"blocks":[…]}`，另两格 `need`（我理解的用户要求）与 `lesson`（可复用经验，如「文档要同步更新」「做事认真」）尽量写 → 一次 `summarise --put -` 落盘。**分小批、逐轮往前推**：本轮只补最近 3–4 块，更早的下一轮每轮往前 1 块（≤8 块则一次补完），补完即止别硬干；一次全补 63 块素材约 40KB、要几分钟，观感像死机。**踩过的坑、找到的根因、下次怎么避免，优先写进 lesson**，别只写在回复里。卡片标题优先用综述；没有综述时只按产物派生（`写 xx 等 n 件`），**不许把用户原话剪一段当标题**。画布顶栏有**三个档位**，都存 `out/prefs.json`（本机共用）：**「补账」**（每轮 / 每 5 轮 / 压缩时）决定 Stop hook 什么时候提示补综述；**「画像」**（自动 / 关）决定画像落后时要不要催；**「建账」**（活跃 / 全部 / 关）决定后台要不要自动建历史账，默认关＝打开哪段建哪段。收到 `[convledger · 后台补账]`／`[convledger · 后台画像]`：**别在当前对话里写**，另起一段后台会话（同 `create_chat_session`）去做——在其里 `digest --block <本轮那几块>`／`memory --digest --class 画像` 取材、一次写完 JSON、`summarise --put -`／`memory --put --scope user` 一次落盘，没有合格证据就如实不写；派完立即结束本轮。同一批只催一次，不会循环；关掉画像档位就完全不提。

## 工作流 2：恢复记忆（回答历史问题 / 压缩后接上）

0. **压缩后的第一跳**：新上下文里应有一段自动注入的 brief（首行标 `[convledger · 工具派生，不是模型记忆]`）。实测宿主动的是它缓存的最近一次 `SessionStart` 输出——压缩后第一个模型回合贴进上下文，`PostCompact` 那条当前不投递，别因为它没出现就判定通路断了。先看尾行「注入于」时刻：不是这次压缩的时刻，说明拿到的是旧账，用 `convledger brief` 补一次新鲜的。首行若写「不是你当前会话」，那是本项目上一段会话的账本，只当定位用。怀疑通路没活就 `convledger hooks` 查。
1. `convledger brief` —— 恢复第一跳：**会话写过章就出章模式**（每章一行＋目的，只展开最后一章），没章就出阶段摘要（做了/成了）＋尾段声明。`convledger brief --chapter N` 给该章九格，`convledger brief --phase N` 给该阶段六格与块表，`convledger handoff [N|all]` 只要接手页那几格（长会话从这里读，别从 brief 一路读下来）。
2. `convledger steps` —— 块表：第几步、主线还是插曲、句范围、这块解决了什么、每块自带回读命令；`--json` 拿结构化数据。
3. `convledger show` —— 所有段的一行索引；`convledger card S07` —— 单段路由卡。
4. `convledger body S07` 或 `convledger body S07-S11` —— 按锚点回源读正文。默认 `12000` tok 预算，满了会停在某段某行并给续读命令（`--after LINE` 续读）；`--text` 只读对话、`--full` 不裁剪、`--max N` 改预算（`0` = 不限）。
5. `convledger prove S07` —— 写认识增量前的素材：编号句子＋上游牌子＋结构事实＋判据。
6. 关键词定位只当兜底：`convledger find <文本>`。能用锚点就别用它。
7. 跨会话看项目：`convledger projects`（项目＝`cwd` 整串相等；默认列全部项目，`--all` 附未归组与每个项目的会话 id）。
8. `convledger memory` —— 跨会话记忆：第二段「现在到哪」由工具现算（最新会话/最后一步/阶段覆盖/待办/已证），后面才是已写记忆（项目四类＋用户表画像/晋升规则，画像每条带 `来源 <项目>:<sid>:Sxx`）；默认隐藏失效条目，`--all` 看原因。一条记忆都没写时它也答得出「到哪」。

顺序是「brief 知道自己在哪 → handoff 读最近一大块 → brief --phase 认出块 → body 读块内段」。**不要**一上来就把前面所有对话塞进上下文，也不要整份源文件扫读。

## 工作流 3：写外挂表（综述 / 阶段 / 增量 / 请求）

工具运行时零模型调用：**写的是你（读模型），工具只做机械校验。**

- 块综述：`convledger digest` 一次拿全部缺块素材（缺哪些：`convledger summarise --missing`；单块要全量用 `--block N`）→ 按素材一次写成 `{"blocks":[…]}`（五格必填；`need` / `lesson` 选填，右栏会显示成「我的要求 / 经验」）→ 一次 `convledger summarise --put -`。四道闸门全过才落盘并重建——批量提交只重建一次。
- 阶段说明：`convledger digest --phases` 拿全量步表＋文档标题清单 → 划连续步区间、写六格 → `convledger phases --put -`。边界/覆盖/锚点/引用全过才落盘。
- 章（会话太长时的接手页）：`convledger chapters --digest` 拿素材 → 写九格（一开始的目的 / 走到哪 / 核心规则与原则 / 主要任务 / 碰过的壁 / 注意事项 / 架构现状 / 怎么接手 / 章名）→ `convledger chapters --put -`。**章的边界必须落在阶段边界上**（`from`＝某阶段的 `from`、`to`＝某阶段的 `to`）、每章 ≥3 段阶段、从第 1 步起首尾相接；没成章的尾部如实留着，别硬凑。写完 `brief` 自动换成章模式，长会话的注入才不会超预算被截断。
- 只写已收口的步：当前步还在长，先别写它的块综述与阶段（写完立刻失效）。补阶段用 `{"append":true}`：只校验新区间，过期的尾段会被丢掉再接上。写章前阶段必须新鲜、成章后再别回头改；顺序固定为块综述 → 阶段 → 章。
- 认识增量：`convledger prove S07` → `convledger claim`（单条参数）或 `convledger claim --json -`（stdin 批量）。六条判据全过才是 verified。
- 话题与任务支：`convledger topics` 看已成支/暂挂的话题与覆盖段；`convledger label S04 T1`（或 `convledger label S04 --name 把手`）给段挂话题——话题名必须逐字出现在该段已证增量里，否则拒挂。`convledger branches [--state 已复核]` 看任务支。
- 人写标注：`convledger notes`；地图底部续做请求：`convledger requests [--pending] [--done R01]`。
- 规则清单：`convledger rules [--part N]` —— 已证 rule 增量汇成清单，新上下文读它就知道要注意什么。
- 项目记忆：`convledger memory --digest` 拿素材（默认最近 8 个会话，超预算整段丢最旧）→ 按末尾的 G4 口径写成 JSON → `convledger memory --put -`。写入口先重建再核锚点，一条不过整批不写；记忆恒为 `basis=model`，永不 verified，账本一变按锚点自动失效。
- 用户画像：`convledger memory --digest --class 画像` 跨全部项目取最近 8 个会话（每行带 `<项目>:<sid8>:Sxx`）→ `convledger memory --put - --scope user`。画像证据要跨 ≥2 个会话、每条带 `project`、只认真人原话（工具回执不算），用户表只收画像。**维度**（可选 `dimension` 字段）：目标 / 边界 / 规则 / 偏好 / 背景 / 验收 / 分工 / 反馈 / 性格——class 说是什么，dimension 说回答哪一类约束；缺哪个维度补哪个，没有证据的维度留空。画像收工作要求/偏好 **以及** 可复用的沟通、决策与性格特征；只写有跨会话原话支撑的倾向，**不做心理诊断、不贴贬义标签**。**自动档**只在「至少 2 段会话晚于上次画像」时把任务交给当前 agent（同一批按会话集合去重，只催一次）；工具不自己分析、不调外部模型，写不写仍由 agent 按 G4 判断。
- 晋升与撤销：`convledger memory --promote M03` 只有在这条规则能在 ≥2 个项目里找到等价条目时才写用户表副本（G8），失败不写任何文件；`--unpromote U01` 删副本并把来源条目的 `promoted_to` 回 null。**合并重复画像**：把两段证据合到一条（`--put` 带 `revises` 修订保留的那条），再 `convledger memory --forget U20` 删掉被并掉的那条——只动用户表，项目表没有删入口。
- 导出统一收在工具目录：`convledger export` 把项目进度与用户画像写进 `out/exports/projects/<项目名>--<项目键>/`（`PROGRESS.md`、`USER-PROFILE.md`、`INDEX.md`、`archive/`），不再往每个项目工作目录塞 `convledger-export/`；旧位置的会在下次导出时自动复制过来，`export --migrate-legacy` 可搬走并删旧目录。内容变了才存快照，**每项目合计**留 30 份；自动刷新只添不删，显式 `export` 才剪（先 `--dry-run` 看会删哪几个）；`--put`/`--promote`/`--unpromote` 成功后会**自动刷新**；交接前用 `export --check` 确认新鲜（不新鲜 exit 1）。
- Token 用量：`convledger usage [--json] [--refresh]` 只算 **Agent 使用本工具**的真实消耗，普通对话不计数。归因三类：后台收尾会话整段 + 每次注入后第一个模型调用 + 含 convledger 调用的真人回合；**缓存命中单列、不计入**，注入/回读只给文本体积估算（也不计入）。Claude Code / WorkBuddy / OpenCode 报 token，Qoder 只报 credits，Codex 这版没有 `token_count` 就写未上报；同一回复按宿主稳定 id 去重。App 壳「用量」页与命令同源，首次统计在后台 worker 跑，不阻塞 hub。
- 项目任务（跨会话）：`convledger progress --project <键>` 看主阶段/欠项/下一行动；收尾时 `sync --prepare` → 按素材写 `{batchId, baseRevision, taskChanges[], events[], candidates[], dispositions[]}` → `sync --put`。每个材料单元都要有处置（绑定/无变化/待整理），不要空提交吞掉新要求；`--from-line N` 只用于受控起点，用了就在回执里写明。**更新已有任务必须 `{id, patch}`；`localKey` 只用于新建**（拿它更新会多出一条重复任务）。任务字段有上限（title≤18、result/remaining≤60），超了会被拒。**一次收尾提示可能跨多批**：`sync --prepare` 只冻 6,000 tok 前缀，回执给 `omittedFrom` 就接着 prepare，直到覆盖完。**闸门只认素材里逐字出现过的字面**：英文词、文件名、数字不在 digest 素材里就换写成素材里有的词，别放宽判据。

闸门不过就不写，**不要改判据去迁就文字**。

## 记忆三层与更新节奏（别按日历推，按增量）

记忆有三层，粒度不同，各有各的触发条件。**把任何一层写成「每周更一次」都会和真实进度脱节**——一天 5–10 个会话，一周压 30–70 个一起消化，中间的判断全失准。

| 层 | 单位 | 什么时候动 | 判据 |
|---|---|---|---|
| 块经验（综述的 `lesson`） | 一个块一条，约 27 字 | 补账写综述时顺手写 | 不走阈值，跟着块 |
| 项目记忆（`进度/经验/规则/探索`） | 项目级几条 | 增量够了才归纳 | 自上次归纳：新增 ≥8 条带 lesson 的块，或 ≥3 个新会话 |
| 用户画像（`画像`） | 跨项目，每条要 ≥2 个不同会话的证据 | 增量够了才归纳 | 自上次画像：新增 ≥8 个会话 |

怎么归纳（两步，都过闸门，不编）：
- 项目：`convledger memory --digest --project <键>` 取材（约 4k tok）→ 按 `进度/经验/规则/探索` 写 JSON → `convledger memory --put -`（默认项目作用域）→ 看一眼 `convledger memory` 是否读得回。
- 画像：`convledger memory --digest --class 画像` → 按 `目标/边界/规则/偏好/背景/验收/分工/反馈/性格` 写 → `convledger memory --put - --scope user`。
- 两类条目都可带可选 `scenes` 多标签（活动/产物/互动/环境四轴，枚举见 digest 末行）；标的是这条记忆适用的工作场景，不适用就留空。brief 选择时场景命中优先，旧条目没标签才按维度兜底。

三条硬规矩：
- **不每轮归纳，也不固定按周/按天**：判据只看「自上次以来新增了多少」。
- **增量没涨就不提**：没干活的时候不要催，否则这条提示会变成噪音。
- **归纳是模型的活**：工具只负责在增量够时提一句，不替 agent 写完再落盘。成本不是理由——三层全跑也就一万 token 量级，瓶颈是时机。

## 命令总表

`[--session <前缀>] [--store <DIR>]` 两个旗标所有命令通用（`--store` 换账本根，自测用；日常不要动）。

| 命令 | 旗标 | 返回什么 |
| --- | --- | --- |
| `index <jsonl\|目录>` | `--all` `--project` `--limit` | 建账回执：段数、路由层 token、回合/工具/压缩统计 |
| `raw <前缀>` | `--from B` `--limit N` | 只读展示更早、还没建账的原始记录（按行原文，不生成段/卡/索引）；末尾给下一片 `catchup` 与再往前翻的 `--from` |
| `catchup <前缀>` | — | 长历史按片往前补账：一次再建一片（默认 256KB，追平即止，段 id 用全文件绝对行号不动旧段）；`raw` 的写入侧 |
| `sessions` | `--all` `--json` | 一本文一行：段数 / MB / 在写 / 最后写入 / **整理过没有**（默认最肥 8 本）；`--all` 逐本列全，`--json` 给源路径与 `organize` 字段 |
| `projects` | `--json` `--all` | 项目层：同一 cwd 的会话归一组；键/名字/会话数/段数/最近活动/最近主线步 |
| `memory` | `--digest` `--put <file\|->` `--scope project\|user` `--promote Mxx` `--unpromote Uxx` `--forget Uxx` `--project <键\|名字>` `--all` `--json` `--class` `--max N` | 跨会话记忆：读取（现在到哪＋项目四类＋用户画像）、素材（`--class 画像` 跨项目）、写入（G0–G9 全过才落盘）、晋升/撤销（G8）、删一条用户表（合并重复画像） |
| `archive` | — | 把源日志逐字归档进账本；回执含归档字节、本次新增、同步时刻 |
| `anchors` | — | 逐段校验锚点是否仍可解引用；源没了对归档校验，行里标 `archived` |
| `export` | `--project` `--all` `--list` `--check` `--dry-run` `--force` `--migrate-legacy` | 写 `out/exports/projects/<项目名>--<项目键>/`：进度、画像、清单、历史快照（内容变了才存，每项目合计留 30 份，自动刷新不剪；`--dry-run` 预览裁剪；`--list` 打跨项目总索引） |
| `usage` | `--json` `--refresh` | 工具相关真实用量：后台收尾 + 回填后首个调用 + 含 convledger 调用的回合（普通对话不计；缓存命中不计）；按 agent/会话列；注入与回读只给文本体积估算（不计入）。Qoder 只报 credits、Codex 本机没有 token_count；`--refresh` 忽略增量缓存重扫 |
| `progress` | `--project <键|名字>` `--task PT001` `--json` | 项目任务进度（只读）：主阶段/欠项/下一行动、计数、任务清单；未整理时如实说没有 |
| `sync --prepare` | `--project` `--session <ID>` [`--from-line N`] | 冻结增量素材与 batchId（不写状态、不推进游标）；预算 6,000 tok |
| `sync --put` | `--put <文件|->` `--project` `--session` [`--actor`] | 校验并提交任务/事件/候选/处置；分层回执（任务/记忆发布/导出），成功后自动刷新导出 |
| `sync --status` | `--project` `--json` | 各会话分析位置、未决调用、候选、待发布 outbox、最近批次 |
| `sync --retry` | `--project` | 只重试 outbox 里待发布的记忆，不越过闸门 |
| `sync --dismiss C001` | `--project` `--why` | 把失败候选标 dismissed；该条目没有其他待发布候选时一并收口 |
| `prefs` | `--summary <each\|every5\|compact>` `--profile <auto\|off>` `--host <宿主>` `--session <前缀>` | 补账/收尾档位，三层可覆盖：会话级 > Agent 级 > 内置宿主默认（WorkBuddy 默认「压缩时」）> 机器级。给 `--host`/`--session` 即在该层设（值 `reset` 回到上层）；不带则显示机器级与内置默认 |
| `map` | `--port` `--rebuild` `--session` `--open` `--stop` | 确保 hub 在跑并给出本会话画布地址 `/s/<ID>/`（横幅：URL、会话、宿主、cwd、段数、归档） |
| `app` | — | 确保 hub 在跑，用专属应用窗口打开（Edge/Chrome `--app`；找不到就退回默认浏览器） |
| `url` | `--copy` | 确保 hub 在跑，打印会话库地址；`--copy` 放进剪贴板 |
| `llm` | `--key <key>` `--bridge` `--base-url <url>` `--model M` `--test` `--clear` | 接模型后端（给补账用）。**只给一个 API key 就够**——工具自己认出是哪家、端点在哪、有哪些模型；`--bridge` 直接读本机 OW Bridge 的 key；`--base-url` 接任意 OpenAI 兼容网关（Magpi / OpenRouter / 本地 Ollama 都走这条）；`--test` 发一条最短请求验通不通。**同样的事在 App 左栏「设置」页点点就能做**（含试连通、断开、补账档位三档）。配置落 `<store>/llm.json`（`tool/out/` 已 gitignore，key 不入库），所有回执里 key 一律脱敏 |
| `closeout` | `--auto` `--session 前缀` `--max N` | 后台补账循环：接了模型（见 `llm`）就由它静默把缺综述的块补完——每轮一小批、闸门照过、写 `<store>/closeout-result-*.json`；没接模型明确拒绝。宿主 hook 检测到已接模型时不再要求当前 Agent 补综述（压缩边界自动起这份循环），没接才走老路 |
| `doctor` | `--purge` | 体检宿主进程：每套实例一行（保留·有窗口 / 残留·无窗口）。Electron 宿主崩溃后主进程可能退不掉，留下没有窗口却占几个 G 的僵尸树；`--purge` 清掉它们（只清**无窗口且启动超 90 秒**的，有窗口的绝不碰）。`map`/`app`/`url` 启动时也会顺手清一次 |
| `setup` | `--client <id\|all>` `--choose` `--hub` `--check` `--build N` `--all` `--no-hooks` `--no-shortcut` `--no-open` `--no-hub` `--uninstall` | 新设备装：**按 Agent 选装**（`--client qoder` 只装 Qoder；`--choose` 交互选；不给 client 才装全部检测到的），装 Skill/hooks、**只建当前这一段账**（历史不建）、写桌面入口；**默认不起 hub**（装完不占后台内存，双击桌面「convledger 地图」或 `convledger map` 才起），要装完就起加 `--hub`；`--build N`/`--all` 才建历史，`--uninstall` 只撤自己写的 |
| `status` | — | 连接状态分层：hooks 每家几条 · Skill 每家挂没挂（含 Junction 指向）· hub · 桌面入口 · 账本；末尾给「已断开 / 仍连接」判定 |
| `off` | `--all` `--keep-hub` | **断开**：撤 hooks 与 Skill、停 hub；账本与历史原样留着；`--all` 连桌面入口一起撤；Junction 只解链接不删真本 |
| `on` | — | 接上：按检测到的宿主把 hooks 与 Skill 装回去，并还原断开前的单源链接；hub 不自动起 |
| `outstanding` | `--json` | 链路自检：缺哪些块综述/任务题名/尾段阶段/未成章阶段/待证候选/待办请求；只列不写 |
| `lessons` | `--limit N` `--json` | 可复用经验：已写 lesson 的块（新→旧），带当时要求与回读锚点；锚点失效的不列 |
| `brief` | `--phase N` `--chapter N` | 恢复第一跳：有章出章模式（每章一行＋目的，只展开最后一章），没章出阶段摘要＋尾段声明；末尾附**协作画像**（记忆表里按 验收/边界/反馈/分工/目标 挑的几条，同一维度只取一条）；`--chapter` 给该章九格，`--phase` 给该阶段六格与块表 |
| `handoff [N\|all]` | — | 接手一页：默认最后一个已写章的九格（目的/走到哪/规则/任务/碰壁/注意/架构/怎么接手），`all` 出全部 |
| `steps` | `--json` | 块表：第几步、主线/插曲、句范围、解决了什么、回读命令 |
| `show` | — | 路由表：所有段的一行索引（约 1 次调用） |
| `card S07[,S08]` | — | 路由卡全文（单段 ≤300 tok 的预算） |
| `body S07[,S08-S11\|all]` | `--text` `--full` `--max N` `--after LINE` | 按锚点回源读正文（默认 12000 tok 预算，满预算给续读行号） |
| `prove S07[,S08]` | `--json` | 写增量的素材：编号句子＋上游牌子＋结构事实＋判据 |
| `claim S07` | `--move` `--topic` `--takeaway` `--evidence` | 落一条已证增量；`--json -` 从 stdin 批量，全过才落盘 |
| `branches` | `--state` `--json` | 任务支表：头、段数、四级完成度、落地物、有无被后续任务回读 |
| `digest` | `--block N[,N-N]` `--tasks` `--phases` | 写综述/阶段说明的素材：`--block` 可单块/逗号列表/区间（**分小批补账用**）；不带给全部缺块素材；`--phases` 给全量步表＋文档标题清单 |
| `summarise` | `--put <file\|->` `--missing` | 写入模型综述/任务题名；四道闸门全过才落盘并重建 |
| `phases` | `--json` `--put <file\|->` `--docs-root` | 阶段表：连续步区间、六格说明、引用的文档章节；写入同样过闸门；尾段可追加（JSON 里 `append:true`，只校验新区间，旧阶段原样保留） |
| `chapters` | `--json` `--put <file\|->` `--digest [--chapter N]` `--docs-root` | 章表（阶段之上的一大块）：九格接手页；边界必须落在阶段边界上、每章 ≥3 段阶段、从第 1 步起首尾相接；`--put` 支持 `append`；写过章 `brief` 自动换章模式 |
| `topics` | — | 话题表：已成支的、暂挂的、覆盖到哪些段 |
| `label S04 T1` | `--name` | 给段挂话题（话题名必须逐字出现在该段已证增量里） |
| `rules` | `--part N` `--json` | 已证 rule 增量汇成的清单 |
| `notes` | `--json` | 人写的标注（`basis=human-note`，永不参与六条判据） |
| `requests` | `--pending` `--json` `--done R01` | 地图底部续做请求；`--done` 标完成 |
| `lines 113-218` | — | 直接读源文件的行区间 |
| `facts [a.b.c]` | `--all` | 结构账本摘要；点路径取子块（如 `facts boundaries`） |
| `find <文本>` | — | 关键词定位到段与行（兜底，能用锚点就别用） |
| `trace` | `--reset` `--all` | 本会话的数据访问审计（回补次数、读回 tokens）；明细默认只给最近 20 条，`--all` 给全量 |
| `hooks` | — | 推送通路体检：挂没挂、宿主发过哪些事件、最近一次注入多少 tok |
| `caps` | — | 宿主派活能力表：每家走哪条通道（独立后台会话 / 异步子代理 / 同步 / 不派）、依据与实测状态；代码按 `channel` 出文案，不写 if。改 `out/host-caps.json` 即可覆盖，不用动代码 |
| `help` | `--help` | 用法行 |

## 连接与断开（用户说「太费 token / 一直挂着我关不掉」时看这段）

连接不是一件事，是四层：hooks（四家 `settings.json`/`hooks.json` ＋ OpenCode 插件）、Skill（五家目录）、hub 常驻、桌面入口。**说「断开」时按下面这套办，别自写临时脚本摘配置**：

- 先看清：`convledger status` —— 逐层列出 hooks 每家几条、Skill 每家挂没挂（是链接会写出指向哪）、hub 在不在跑、账本多少会话。末尾给「已断开 / 仍连接」判定。
- 断开：`convledger off` —— 撤 hooks、撤 Skill、停 hub；账本与历史原样留着。`--all` 连桌面入口一起撤，`--keep-hub` 留着看板。
- 接回：`convledger on` —— 按检测到的宿主装回去；断开前是单源链接（Junction 指向一份真本）的，接回时还原成链接，不会变成各写一份副本。
- 只断一家：看板卡片上的「断开」，或 `hooks/install.mjs --client <家> --remove` ＋ `skill/install.mjs --client <家> --remove`。

代价落在哪，说清楚再让用户决定：
- **Stop hook 的 `decision:'block'`** 是主要开销——它把当前对话拽回来多跑一轮，还可能派一段后台会话（后台会话 token 另算）。想省钱先关这一层，注入本身很便宜。
- `SessionStart`/`PostCompact` 注入约 300–1000 tok／次，量级远小于上面那条。
- hub 常驻只是内存与页面轮询；账本会话越多、列表越慢。看完板 `map --stop`，不要让它一直开着。

## 红线

- 不放宽闸门换覆盖率：没有就如实说「没有」，不编。
- 外挂表带锚点 hash：账本一变，旧条目自动失效回落，**不把旧说明挂到新内容上**。
- `--put` 会先按当前源重建、再拿新账本算锚点：核对回执那句「N 段……重建后仍新鲜 M 段」，M < N 就是过期了，**别去放宽 hash 换落盘**。
- `basis:model` 的综述永远不是 verified；只有过六条判据的 claim 才配 verified。
- 页面上模型写的内容会标「模型综述 / 模型说明（归纳，不过六条判据）」——转述时保留这个限定。
- hook 是**只读推送层**：拿不到账本就一个字都不注（fail-open），也不许在 hook 里现写阶段/综述——那等于绕过闸门往上下文里塞话。
- 归档是源的最后一次逐字镜像，**不是新的真相**：源还在就以源为准；别把归档当输入回写账本。

## 常见故障

- 页面打不开：hub 没起（`map` 会自己起）或端口被别的程序占着。
- 端口报「不是本工具的 hub」/ hub 起不来：那个端口被别的程序占着。会自动顺延到空位并打印临时地址（`ensureHubAuto`）；也可 `convledger map --port N` 指定。腾出后重跑 `map` 回到 8765。
- 横幅写着「按最新写入判定」：没有同工作目录的会话，它取了全机最新的一段——若不对，用 `--session` 指定。
- 最后一段括号消失：账本长大了、锚点变了，该段按设计失效；等会话停下来再补写。
- 提示「store 里有 N 个会话，加 --session」：只读命令会先按「env → 同工作目录最新 → 全机最新」自己认一段会话（认到的写在 stderr 说一句，连凭什么认的一起写），认不出来才走到这条；那就加 `--session <前缀>`，或先 `convledger sessions`。`sync` 写项目任务仍必须显式给 `--session`（它还要核这条会话属不属于这个项目）；`summarise`/`phases`/`claim` 不给也会自动认，认错了会被锚点闸门挡下——但**别赌**，写入口一律带上 `--session`。
- `hooks` 显示事件发了但没投递：看判定行（事件）与投递行（哪一路真送到）；压缩边界后没出现 brief，先手动 `convledger brief` 兜底。

## 维护

正本在仓库 `tool/skill/convledger/SKILL.md`；改完跑 `node {{TOOL_ROOT}}/tool/skill/install.mjs` 同步到各宿主用户级目录（`~/.qoder/skills/convledger/`、`~/.claude/skills/convledger/`、`~/.workbuddy/skills/convledger/`、`~/.config/opencode/skills/convledger/`），`--check` 只比对不写。正本里的入口用 `{{TOOL_ROOT}}` 占位，install.mjs 安装时渲染成仓库实际路径——换机器或搬仓后重新安装即可，不用改正本。

- 自测：`node {{TOOL_ROOT}}/tool/test/selftest.mjs`；跨平台用 `CONVLEDGER_SELFTEST_SESSION` 指一段会话。全量 9–11 分钟，**跑着别改源码**。
- 宿主差异（配置位置、hook 形状、真实事件名、投递证据与状态）用 `convledger caps --json` 的 `status` / `gaps` 查：改 hook/安装器前先核对，改完重新核对全部已接入宿主。
- 提交前密钥扫描：`node {{TOOL_ROOT}}/tool/scan-secrets.mjs`（扫历史与暂存区，`--staged` 只扫暂存）；本仓已把 `core.hooksPath` 指到 `.githooks`，`pre-commit` 会跑一次。

**改了 `tool/src/` 或 `tool/web/` 之后，页面要重启 hub 才变**：hub 是常驻进程，`project-page.mjs`、`map.mjs` 这些模块在进程启动时就加载进内存了（`atlas.js`/`atlas.css` 是每次请求现读，带 mtime 版本号，刷新即可）。所以改完 src 记得 `convledger map --stop && convledger map`，别对着没变的页面怀疑自己改错了。
