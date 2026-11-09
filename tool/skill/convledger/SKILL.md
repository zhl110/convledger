---
name: convledger
description: 用 convledger 账本回答「之前做到哪了 / 上次那个是怎么做的」并维护会话地图：一个 hub 服务所有会话（固定 8765、画布按 /s/<ID>/ 寻址、两个 agent 可同时用）、压缩后第一跳 brief、块表 steps、按锚点回源读原文 body、已证增量 claim、块综述与阶段括号（summarise/phases --put）、章层与接手页（chapters --put、handoff）、跨会话记忆（memory 读取/--digest/--put/--promote/--unpromote，项目表＋用户画像）、项目任务页（/p/<键>/ 四档＋依赖箭头）与收尾同步（progress、sync --prepare/--put）。绝对入口 node {{TOOL_ROOT}}/tool/bin/convledger.mjs。当用户问及本会话或本项目的进度、历史决策、某一步做了什么，要写或改块综述、任务题名、阶段说明、章、项目记忆/用户画像，或要看会话地图/路线图（atlas）、补账档位、经验画像、架构页时使用；触发词：convledger、账本、brief、锚点回读、块综述、阶段括号、handoff、接手页、章、项目记忆、用户画像、晋升、memory、导出、项目进度、任务进度、收尾检查、补账、sync、项目任务页、会话地图、路线图、atlas、架构页、经验画像。
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
- 页面：`http://127.0.0.1:8765/`（一个 hub 服务所有会话：`/` 是会话库，每段会话的画布在 `/s/<ID>/`；**项目任务页在 `/p/<项目键>/`**，四档缩放、依赖箭头、任务↔原文往返）。页面顶部「会话实时」读最近一段账本，显示第几步、哪一块、还有多少字节没收尾，每 5 秒更新，不等 `sync --put`。
- 会话库：标题优先读桌面端工作区里的会话名（Qoder 的 `chat_sessions.title`，只读库，不写宿主），读不到才回落到账本派生的任务/块/阶段标题；左栏 agent 分组可拖动排序（或 Alt+↑↓），顺序存在本机，会话库与画布共用。每一行都标整理过没有：绿「已整理 · 综述 234/236 · 阶段 29 · 题名 196/196」/ 黄「欠 N 项 · …」/ 灰「未整理 · 只有结构账」，判据与 `convledger outstanding` 同一条（锚点失效的旧综述不算）；顶栏「全部」按钮循环切「只看未整理 / 只看整理过」，总数行给「整理过 N / 总数」，画布左栏同一条会话上也有这个小标。
- 项目页与导出：顶部两块实时内容随账本刷新——「经验 · 按阶段」（块综述 lesson 按会话＋阶段收拢，点会话号回画布）与「用户画像 · 做事方式」（用户表＋项目表条目，0 条如实写）；画布阶段六格下也有「这一程的经验」。`convledger export` 把经验写进 `PROGRESS.md`，并生成 `convledger-export/sessions/<会话>-notes.md` 会话笔记。项目页每 5 秒按 revision 自动刷新（档位与选中保留），新任务不用手动刷。
- 架构页与页面往返：架构页在会话库顶栏（`/architecture`），画整个工具的模块架构图＋PM/PT 工作路线图（可点、可搜、可缩放；路线图进页面时实时读项目状态，不再是快照），不属于任何一段会话，别挂到画布顶栏。会话画布顶栏的「▤ 项目页」直接跳项目任务页（按会话 cwd 算项目键）；项目页顶栏随之出现「← 返回会话」，回到刚才那段对话的画布并保留档位与选中；从项目页点任务里的来源会话进画布时，画布也会显示「← 返回项目」。
- 这个文件不存在 = 本机没装这套工具。先确认仓库还在 `{{TOOL_ROOT}}`；新设备直接跑 `node {{TOOL_ROOT}}/tool/bin/convledger.mjs setup --no-open`（体检、找宿主、装 Skill/hooks、**按写入时间建最近 20 个会话的账**、桌面入口、起 hub 一次做完，结尾四行「下一步」说明还缺什么；`--build N`/`--all` 改建账范围，`--check` 只看计划，`--uninstall` 只撤自己写的条目；`--open` 会开系统浏览器，在 Agent 内不要加），再用内置浏览器打开 `/`。桌面入口：Windows 写快捷方式，Linux 写 `.desktop` 应用菜单项；macOS 尚未在真机实测。

## 它是什么

从四种宿主（Qoder `~/.qoder/projects`、Claude Code `~/.claude/projects`、WorkBuddy `~/.workbuddy/projects`、OpenCode `~/.local/share/opencode/opencode.db`——最后一种先投影成 `out/opencode/<会话>/<会话>.jsonl` 再走同一条管线）的 append-only JSONL 里派生出「段 → 块 → 步 → 阶段 → 章」五层结构和锚点（OpenCode 来源要 Node ≥22.5，低于它只是那一家跳过）。正文一个字都不搬进账本——除了画布服务过的会话会留一份逐字归档（见下节）。

同一个 store 收所有会话，`--session <前缀>` 不分宿主；`ledger.json` 的 `runner` 字段写明来源。store 里只有一个账本时可省略 `--session`，否则先 `convledger sessions`。

## 一个 hub 服务所有会话（最容易用错的一条）

1. **不用挑会话。** `convledger map` 自己认「跑这条命令时所在的会话」，优先级：`--session` > 环境变量 `CONVLEDGER_SESSION` > 同工作目录里源文件最新的那段 > 全机最新写入的那段。认出来的会话还没建账就先建。
2. **一个地址，会话在路径里。** hub 固定 `http://127.0.0.1:8765`，本会话画布是 `/s/<会话ID>/`；`/` 是会话库整页。
3. **两个 agent 同时用＝同一端口下两个路径。** 谁也不抢端口；左栏照样列全部会话，点一行进 `/s/<id>/`。
4. **端口被别的程序占着就报错**，不替你换端口——地址稳定优先。`--port` 只在确实要换整个 hub 时用。
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
4. 用户不需要记网址：`/` 是会话库，本会话画布地址由 `map` 横幅给出。**页面关掉不会停 hub**——回来时双击桌面或开始菜单「convledger 地图」，或跑 `convledger url --copy`（确保 hub 在跑并把地址放进剪贴板）。**地址常驻**：开始菜单搜 convledger 就有入口，用户问地址优先给 `http://127.0.0.1:8765/`。
5. 页面每 4 秒重读账本；点块＝选中＋推近＋右栏，点阶段括号牌＝六格说明，**点章括号牌＝九格接手页**（主线行上方现在是两条带：上面章、下面阶段；章牌写 `章 N · 第 a–b 步 · 章名`，面板里就是 `convledger handoff` 那几格，另有「定位到第 N 步」与「复制 handoff」——接手页文本只有一份，由 hub 的 `/handoff` 出），**左上角还常驻一张「章笔记」**：视口正中那一张块属于哪一章，卡就写那一章的目的／走到哪／怎么接手（按屏幕像素排，12% 的「适应」档也读得出；章牌里的字是世界像素，那一档只剩 4px），末尾一枚「打开九格」进同一份接手页，没写章或搜索清单出现时这张卡让位，搜索框找块与段，底部续做框写请求。**块间连线是流式的**：缺口沿行进方向朝箭头走（灰＝主线，橙虚线＝宿主步岔出插曲，绿虚线＝汇回主干），只改画法，不改线的走法、端点与箭头；系统开了「减少动态」就整层停住。**中景保持原块**（阶段信息由上方括号牌承担），近景是全明细；已写阶段之后的新内容在「尾段」（虚线占位带）里按真人提问一条一块，尾段说明待写时如实标出。右栏近景写「我的要求 / 经验 / 做成什么」，原话只在原文入口，不再复读「你说的/我回的」；任务行会写「这一步在做…」，主线任务没有模型题名时显示未命名，不拿原话顶替。右下角「已同步 · 落后 N 秒」里的 N（构建时间在悬停提示里）是源最后写入与账本构建之差，**0 才代表画到了最新**；块综述/阶段/任务题名是模型写的，不随重建自动变。

## 工作流 1：建账与更新

- **接手一个项目先读导出**：`<项目>/convledger-export/PROGRESS.md`（没有就跑一次 `convledger export`），再看同目录 `USER-PROFILE.md`；历史快照查 `INDEX.md`，跨项目先看 `convledger export --list`。**文件存在不等于新鲜**：`convledger export --check` 说新鲜再用，过期先 `convledger export`。
- 接手继续做之前，先 `convledger brief`（头行带待办请求条数、附最近的请求原文）和 `convledger requests --pending`：地图底部输入框只会把请求写进账本，不会把消息推进会话——不查就看不见。
- `convledger index <session.jsonl|目录>` 建单个账本；`convledger index --all [--project P] [--limit N]` 批量（只出统计）。
- `convledger sessions` 看哪些已建账、哪些还没有，并直接给出**每本整理过没有**（判据与 `outstanding` 同一条：hash 还有效的块综述/题名/阶段/已证增量，失效的不算）；默认只列最肥 8 本，`--all` 逐本列全，`--json` 才给源文件路径。要跨会话补链就 `sessions --all` 挑「未整理」的那几本。
- 重建是幂等的：段、块、步、阶段边界全从源 JSONL 现算，源变了重跑一次即可。
- 压缩边界自动推送：`node {{TOOL_ROOT}}/tool/hooks/install.mjs [--client qoder|workbuddy|opencode|all] [--probe|--remove]` 把 `SessionStart`／`PreCompact`／`PostCompact`／`Stop` 挂进用户级 settings.json。**所有项目的会话都管**：每段会话按自己的 transcript 建账并注入自己的 brief，不按 cwd 划界（cwd 只在新会话还没有自己源文件时借读同项目的账本）。PreCompact 只重建账本，PostCompact／SessionStart 注 brief；去重按「来源＋事件＋会话」三键，跨事件不互相消音，压缩边界不吃同文去重。两个宿主的 handler 形状不同：Qoder 吃 `{command, args}`，WorkBuddy 只吃 `command` 的 shell 串。OpenCode 走插件 `~/.config/opencode/plugins/convledger.js`：`experimental.session.compacting` 注 brief、`session.idle` 按同样判据发收尾提示。
- 收尾检查（Qoder 已注册）：`Stop` hook 只在「项目有任务状态 + 有未分析素材 + 本轮有真人消息」时提示一次，内容是欠账条数与 `sync --prepare` 命令；`stop_hook_active` 放行，不循环。没有任务状态的项目不会被打扰。
- 收尾时先跑 `convledger outstanding` 看链路欠项（综述/题名/尾段阶段/候选/请求）；写新综述前先 `convledger lessons` 看已有经验，避免重复；再顺带补**新块的综述**：`convledger summarise --missing` 看缺哪些 → `convledger digest --block N` 取素材 → 按五格必填写，另两格 `need`（我理解的用户要求）与 `lesson`（可复用经验，如「文档要同步更新」「做事认真」）尽量写 → `summarise --put`。**踩过的坑、找到的根因、下次怎么避免，优先写进 lesson**，别只写在回复里。卡片标题优先用综述；没有综述时只按产物派生（`写 xx 等 n 件`），**不许把用户原话剪一段当标题**。画布顶栏的**「补账」档位**（每轮 / 每 5 轮 / 压缩时，存 `out/prefs.json`，本机共用）决定 Stop hook 什么时候提示补综述：收到 `[convledger · 补账]` 的阻断时，先按提示把那几块的综述写完再结束本轮；同一批块只提示一次，不会循环。

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

- 块综述：`convledger digest --block N` 拿素材（缺哪些：`convledger summarise --missing`）→ 按素材写成 JSON（五格必填；`need` / `lesson` 选填，右栏会显示成「我的要求 / 经验」）→ `convledger summarise --put -`。四道闸门全过才落盘并重建。
- 阶段说明：`convledger digest --phases` 拿全量步表＋文档标题清单 → 划连续步区间、写六格 → `convledger phases --put -`。边界/覆盖/锚点/引用全过才落盘。
- 章（会话太长时的接手页）：`convledger chapters --digest` 拿素材 → 写九格（一开始的目的 / 走到哪 / 核心规则与原则 / 主要任务 / 碰过的壁 / 注意事项 / 架构现状 / 怎么接手 / 章名）→ `convledger chapters --put -`。**章的边界必须落在阶段边界上**（`from`＝某阶段的 `from`、`to`＝某阶段的 `to`）、每章 ≥3 段阶段、从第 1 步起首尾相接；没成章的尾部如实留着，别硬凑。写完 `brief` 自动换成章模式，长会话的注入才不会超预算被截断。
- 只写已收口的步：当前步还在长，先别写它的块综述与阶段（写完立刻失效）。补阶段用 `{"append":true}`：只校验新区间，过期的尾段会被丢掉再接上。写章前阶段必须新鲜、成章后再别回头改；顺序固定为块综述 → 阶段 → 章。
- 认识增量：`convledger prove S07` → `convledger claim`（单条参数）或 `convledger claim --json -`（stdin 批量）。六条判据全过才是 verified。
- 话题与任务支：`convledger topics` 看已成支/暂挂的话题与覆盖段；`convledger label S04 T1`（或 `convledger label S04 --name 把手`）给段挂话题——话题名必须逐字出现在该段已证增量里，否则拒挂。`convledger branches [--state 已复核]` 看任务支。
- 人写标注：`convledger notes`；地图底部续做请求：`convledger requests [--pending] [--done R01]`。
- 规则清单：`convledger rules [--part N]` —— 已证 rule 增量汇成清单，新上下文读它就知道要注意什么。
- 项目记忆：`convledger memory --digest` 拿素材（默认最近 8 个会话，超预算整段丢最旧）→ 按末尾的 G4 口径写成 JSON → `convledger memory --put -`。写入口先重建再核锚点，一条不过整批不写；记忆恒为 `basis=model`，永不 verified，账本一变按锚点自动失效。
- 用户画像：`convledger memory --digest --class 画像` 跨全部项目取最近 8 个会话（每行带 `<项目>:<sid8>:Sxx`）→ `convledger memory --put - --scope user`。画像证据要跨 ≥2 个会话、每条带 `project`、只认真人原话（工具回执不算），用户表只收画像。
- 晋升与撤销：`convledger memory --promote M03` 只有在这条规则能在 ≥2 个项目里找到等价条目时才写用户表副本（G8），失败不写任何文件；`--unpromote U01` 删副本并把来源条目的 `promoted_to` 回 null。
- 导出到项目：`convledger export` 把项目进度与用户画像写进 `<项目>/convledger-export/`（`PROGRESS.md`、`USER-PROFILE.md`、`INDEX.md`、`archive/`）。内容变了才存快照，**每项目合计**留 30 份；自动刷新只添不删，显式 `export` 才剪（先 `--dry-run` 看会删哪几个）；`--put`/`--promote`/`--unpromote` 成功后会**自动刷新**；交接前用 `export --check` 确认新鲜（不新鲜 exit 1）。
- 项目任务（跨会话）：`convledger progress --project <键>` 看主阶段/欠项/下一行动；收尾时 `sync --prepare` → 按素材写 `{batchId, baseRevision, taskChanges[], events[], candidates[], dispositions[]}` → `sync --put`。每个材料单元都要有处置（绑定/无变化/待整理），不要空提交吞掉新要求；`--from-line N` 只用于受控起点，用了就在回执里写明。**更新已有任务必须 `{id, patch}`；`localKey` 只用于新建**（拿它更新会多出一条重复任务）。任务字段有上限（title≤18、result/remaining≤60），超了会被拒。**一次收尾提示可能跨多批**：`sync --prepare` 只冻 6,000 tok 前缀，回执给 `omittedFrom` 就接着 prepare，直到覆盖完。**闸门只认素材里逐字出现过的字面**：英文词、文件名、数字不在 digest 素材里就换写成素材里有的词，别放宽判据。

闸门不过就不写，**不要改判据去迁就文字**。

## 命令总表

`[--session <前缀>] [--store <DIR>]` 两个旗标所有命令通用（`--store` 换账本根，自测用；日常不要动）。

| 命令 | 旗标 | 返回什么 |
| --- | --- | --- |
| `index <jsonl\|目录>` | `--all` `--project` `--limit` | 建账回执：段数、路由层 token、回合/工具/压缩统计 |
| `sessions` | `--all` `--json` | 一本文一行：段数 / MB / 在写 / 最后写入 / **整理过没有**（默认最肥 8 本）；`--all` 逐本列全，`--json` 给源路径与 `organize` 字段 |
| `projects` | `--json` `--all` | 项目层：同一 cwd 的会话归一组；键/名字/会话数/段数/最近活动/最近主线步 |
| `memory` | `--digest` `--put <file\|->` `--scope project\|user` `--promote Mxx` `--unpromote Uxx` `--project <键\|名字>` `--all` `--json` `--class` `--max N` | 跨会话记忆：读取（现在到哪＋项目四类＋用户画像）、素材（`--class 画像` 跨项目）、写入（G0–G9 全过才落盘）、晋升/撤销（G8） |
| `archive` | — | 把源日志逐字归档进账本；回执含归档字节、本次新增、同步时刻 |
| `anchors` | — | 逐段校验锚点是否仍可解引用；源没了对归档校验，行里标 `archived` |
| `export` | `--project` `--all` `--list` `--check` `--dry-run` `--force` | 写 `<项目>/convledger-export/`：进度、画像、清单、历史快照（内容变了才存，每项目合计留 30 份，自动刷新不剪；`--dry-run` 预览裁剪；`--list` 打跨项目总索引） |
| `progress` | `--project <键|名字>` `--task PT001` `--json` | 项目任务进度（只读）：主阶段/欠项/下一行动、计数、任务清单；未整理时如实说没有 |
| `sync --prepare` | `--project` `--session <ID>` [`--from-line N`] | 冻结增量素材与 batchId（不写状态、不推进游标）；预算 6,000 tok |
| `sync --put` | `--put <文件|->` `--project` `--session` [`--actor`] | 校验并提交任务/事件/候选/处置；分层回执（任务/记忆发布/导出），成功后自动刷新导出 |
| `sync --status` | `--project` `--json` | 各会话分析位置、未决调用、候选、待发布 outbox、最近批次 |
| `sync --retry` | `--project` | 只重试 outbox 里待发布的记忆，不越过闸门 |
| `sync --dismiss C001` | `--project` `--why` | 把失败候选标 dismissed；该条目没有其他待发布候选时一并收口 |
| `map` | `--port` `--rebuild` `--session` `--open` `--stop` | 确保 hub 在跑并给出本会话画布地址 `/s/<ID>/`（横幅：URL、会话、宿主、cwd、段数、归档） |
| `url` | `--copy` | 确保 hub 在跑，打印会话库地址；`--copy` 放进剪贴板 |
| `setup` | `--check` `--build N` `--all` `--no-hooks` `--no-shortcut` `--no-open` `--uninstall` | 新设备一键：找宿主、装 Skill/hooks、建最近 20 段账、写桌面入口、起 hub；`--uninstall` 只撤自己写的 |
| `outstanding` | `--json` | 链路自检：缺哪些块综述/任务题名/尾段阶段/未成章阶段/待证候选/待办请求；只列不写 |
| `lessons` | `--limit N` `--json` | 可复用经验：已写 lesson 的块（新→旧），带当时要求与回读锚点；锚点失效的不列 |
| `brief` | `--phase N` `--chapter N` | 恢复第一跳：有章出章模式（每章一行＋目的，只展开最后一章），没章出阶段摘要＋尾段声明；`--chapter` 给该章九格，`--phase` 给该阶段六格与块表 |
| `handoff [N\|all]` | — | 接手一页：默认最后一个已写章的九格（目的/走到哪/规则/任务/碰壁/注意/架构/怎么接手），`all` 出全部 |
| `steps` | `--json` | 块表：第几步、主线/插曲、句范围、解决了什么、回读命令 |
| `show` | — | 路由表：所有段的一行索引（约 1 次调用） |
| `card S07[,S08]` | — | 路由卡全文（单段 ≤300 tok 的预算） |
| `body S07[,S08-S11\|all]` | `--text` `--full` `--max N` `--after LINE` | 按锚点回源读正文（默认 12000 tok 预算，满预算给续读行号） |
| `prove S07[,S08]` | `--json` | 写增量的素材：编号句子＋上游牌子＋结构事实＋判据 |
| `claim S07` | `--move` `--topic` `--takeaway` `--evidence` | 落一条已证增量；`--json -` 从 stdin 批量，全过才落盘 |
| `branches` | `--state` `--json` | 任务支表：头、段数、四级完成度、落地物、有无被后续任务回读 |
| `digest` | `--block N` `--tasks` `--phases` | 写综述/阶段说明的素材：逐块原话/回复/产物，或全量步表＋文档标题清单 |
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
| `help` | `--help` | 用法行 |

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
- 端口报「不是本工具的 hub」：那个端口被别的程序占着。腾出来，或 `--port` 换整个 hub 的端口（地址会跟着变）。
- 横幅写着「按最新写入判定」：没有同工作目录的会话，它取了全机最新的一段——若不对，用 `--session` 指定。
- 最后一段括号消失：账本长大了、锚点变了，该段按设计失效；等会话停下来再补写。
- 提示「store 里有 N 个会话，加 --session」：只读命令会先按「env → 同工作目录最新 → 全机最新」自己认一段会话（认到的写在 stderr 说一句，连凭什么认的一起写），认不出来才走到这条；那就加 `--session <前缀>`，或先 `convledger sessions`。`sync` 写项目任务仍必须显式给 `--session`（它还要核这条会话属不属于这个项目）；`summarise`/`phases`/`claim` 不给也会自动认，认错了会被锚点闸门挡下——但**别赌**，写入口一律带上 `--session`。
- `hooks` 显示事件发了但没投递：看判定行（事件）与投递行（哪一路真送到）；压缩边界后没出现 brief，先手动 `convledger brief` 兜底。

## 维护

正本在仓库 `tool/skill/convledger/SKILL.md`；改完跑 `node {{TOOL_ROOT}}/tool/skill/install.mjs` 同步到各宿主用户级目录（`~/.qoder/skills/convledger/`、`~/.workbuddy/skills/convledger/`），`--check` 只比对不写。正本里的入口用 `{{TOOL_ROOT}}` 占位，install.mjs 安装时渲染成仓库实际路径——换机器或搬仓后重新安装即可，不用改正本。

- 自测：`node {{TOOL_ROOT}}/tool/test/selftest.mjs`；跨平台用 `CONVLEDGER_SELFTEST_SESSION` 指一段会话。全量 9–11 分钟，**跑着别改源码**。
- 提交前密钥扫描：`node {{TOOL_ROOT}}/tool/scan-secrets.mjs`（扫历史与暂存区，`--staged` 只扫暂存）；本仓已把 `core.hooksPath` 指到 `.githooks`，`pre-commit` 会跑一次。

**改了 `tool/src/` 或 `tool/web/` 之后，页面要重启 hub 才变**：hub 是常驻进程，`project-page.mjs`、`map.mjs` 这些模块在进程启动时就加载进内存了（`atlas.js`/`atlas.css` 是每次请求现读，带 mtime 版本号，刷新即可）。所以改完 src 记得 `convledger map --stop && convledger map`，别对着没变的页面怀疑自己改错了。
