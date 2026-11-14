// Every token price tag in the tool lives in this one leaf module. Modules that
// spend a budget import the number instead of restating it, so re-pricing the
// route layer is a one-file edit rather than a grep-and-hope sweep.
// Nothing here imports from the rest of the tool — a knob table must not depend
// on the code it constrains.

// Truncation matrix, measured against an external reference codebase.
export const CALL_LIMIT = 800; // tool_use args
export const ARTIFACT_CALL_LIMIT = 32000; // Write/Edit args are the payload, not noise
export const RESULT_LIMIT = 4000; // tool_result bodies

// One back-fill read: big enough to answer a question, small enough that
// fetching it still leaves the context it was meant to save.
export const BODY_BUDGET_TOKENS = 12000;

// Prices of the two route layers.
export const CARD_TOKEN_CAP = 300;
// The index is O(segments), so its bound is a rate, not a snapshot total.
// Fitted over the 47 ledgers in out/store (1..71 段): 61 t fixed + 30.9 t/段,
// worst residual +18 t. The cap below is that line with ~25% headroom, so a real
// regression is caught without the assertion tripping just because a session grew.
export const INDEX_FIXED_TOK = 120;
export const INDEX_TOKENS_PER_SEGMENT = 40;
// The whole point of routing is to cost less than reading; above this share of
// the context it replaces, the route layer has become the thing it indexes.
export const ROUTE_SHARE_CAP = 0.05;

// The semantic layer (claims). Prices measured against an external reference codebase: the numbered
// sentence slice is `sentences.slice(0, 12000)` in src/lib/ladder-context.ts and
// REVISION_SHARE = 0.4 in src/lib/ladder.ts.
export const CLAIM_SENTENCE_CAP = 12000; // chars of a segment's own prose the author gets to cite
// Address-bearing result lines get their OWN budget of the same size, never a share
// of the prose one: a fat read segment must keep both its conclusions and the
// addresses it read, and `prove` is clamped by BODY_BUDGET_TOKENS at the CLI anyway.
export const CLAIM_RESULT_CITABLE_CAP = 12000;
export const CLAIM_THREAD_TAKEAWAYS = 4; // upstream takeaways ("plaques") shown alongside the segment// These two are in tokens (lib.tok), not chars, and CLAIM_TAKEAWAY_MAX equals the
// card's 增量 line on purpose: a verified claim that would be clipped on the card
// is a claim the route layer cannot route, so the cap is checked, not truncated.
export const CLAIM_TOPIC_MAX = 10;
export const CLAIM_TAKEAWAY_MAX = 30;
// 块层摘要的两档宽度，单位是显示宽度（view.mjs 的 wlen：汉字 1、拉丁 0.55），不是 tok。
// 远景那一格要在大字号下放得下：卡内宽＝300 世界像素－边框－左右内边距＝272px，atlas.css 把
// .fwhat 定在 38px，7 格＝266px 正好不裁字（selftest ⑦ 逐条比这两个数，字号与格数只能有一份）。
// 窄字符按 0.55 格算，所以 "PRD-atlas.md"（12 个窄字符＝6.6 格）也放得下。
export const CLAIM_MARK_W = 7;
// 中景那一行的预算＝那一行放得下的字数，不是"想写多少字"：卡内宽 272px ÷ 24px 字号＝11 格/行，
// .mtitle 排两行＝24 格；但中文标点禁则会在行首顶掉一个字（atlas-probe 实测 22 格仍多出第三行、
// 被 line-clamp 静默裁掉 31px），所以留出一格余量取 20。多一个字都不该写进账里。
export const BLOCK_GIST_W = 20;
// 块综述（summaries.json）：模型写、工具校验。宽度仍用 wlen 的格数——和中景卡面同一把尺。
// short 顶远景那一个格位（与 CLAIM_MARK_W 同源），title 排中景两行（22 字 < 20 格×2 行）。
export const SUMMARY_SHORT_W = CLAIM_MARK_W;
export const SUMMARY_TITLE_MAX = 22;
export const SUMMARY_SAID_MAX = 60;
export const SUMMARY_ANSWERED_MAX = 80;
export const SUMMARY_DONE_MAX = 48;
// 右栏新增两格：用户到底要什么、这段留下什么可复用经验。都是模型归纳，不是原话搬运。
export const SUMMARY_NEED_MAX = 80;
export const SUMMARY_LESSON_MAX = 96;
export const SUMMARY_TASK_TITLE_MAX = 18;
// 一整格文本若是块内某句原话的连续子串（去标点后 ≥8 字），那就是截段不是综述。
export const SUMMARY_MIN_QUOTE_OVERLAP = 8;
// 阶段层（phases.json，PRD-phases）。宽度仍用 wlen 的格数：括号 chip 与卡面同一把尺；
// 其余五格是右栏的散文，长度上限只防一次误贴整份文档，不压正常一句话。
export const PHASE_SHORT_W = 10;
export const PHASE_DOING_MAX = 80;
export const PHASE_STATE_MAX = 60;
export const PHASE_EFFECT_MAX = 60;
export const PHASE_PLAN_MAX = 90;
export const PHASE_TRACK_MAX = 60;
// 章层（chapters.json，PRD-chapters）：一块目标几十步的「接手一页」。八格都是散文，
// 上限只防把整份文档贴进来；brief 在章模式下的预算由 CHAP_BRIEF_MAX_TOK 保证
//（hook 的 INJECT_MAX=2000 仍是兜底硬顶，不改它）。
export const CHAP_SHORT_W = 10;
export const CHAP_GOAL_MAX = 60;
export const CHAP_WHERE_MAX = 80;
export const CHAP_RULES_MAX = 90;
export const CHAP_TASKS_MAX = 90;
export const CHAP_WALLS_MAX = 90;
export const CHAP_CAUTION_MAX = 90;
export const CHAP_ARCH_MAX = 90;
export const CHAP_HANDOFF_MAX = 80;
export const CHAP_MIN_PHASES = 3;         // 少于 3 个阶段就等于又重复了一遍阶段层，白加一层
export const CHAP_DIGEST_TOKENS = 6000;   // chapters --digest 一章的素材预算
export const CHAP_BRIEF_MAX_TOK = 1800;   // 章模式下 brief 的目标上限
// 文档清单（src/docs.mjs）：只扫标题，不读正文。上限防把 reference/ 或 node_modules 卷进来。
export const DOC_MAX_FILES = 80;
export const DOC_MAX_HEADS = 60;
export const DOC_MAX_DEPTH = 3;
export const REVISION_SHARE = 0.4; // ≥ this overlap with the previous claim ⇒ 修订, not 新增
// Topic layer (tool/PRD-topics.md). TOPIC_NAME_MAX reuses the claim handle's width on
// purpose: a topic name is a routing handle, so the cap that makes a claim routable
// makes a topic label routable too.
export const TOPIC_NAME_MAX = CLAIM_TOPIC_MAX;
export const MAX_TOPICS_PER_SEGMENT = 3; // 多话题 ≠ 多根: annotate, never restructure
export const MIN_SEGMENTS_PER_TOPIC = 2; // one segment is not a topic — never published as a branch

// 人写的外挂层（notes.json / requests.jsonl），单位是字符而不是 tok：这是人手打的
// 自由文本，不进路由层。上限只防一次误贴整篇文档，不压正常一句话。
export const NOTE_TITLE_MAX = 40;
export const NOTE_BODY_MAX = 600;
export const REQUEST_TEXT_MAX = 500;

// 每轮增量素材的预算（PRD §6.5）：素材、状态摘要、候选清单都算在内；
// 超额按完整材料单元分批，未装入的留下批，不静默截断。
export const NEW_MATERIAL_TOKENS = 6000;

// 项目记忆层（memories.json，tool/PRD-memory.md §五 G0）：一条记忆一句话，
// 不把整段对话搬进来。text 用 tok——右栏一行放不下就不是能读的记忆。
export const MEMORY_TEXT_MAX = 80; // tokens（lib.tok）
export const MEMORY_TOPIC_MAX = CLAIM_TOPIC_MAX; // 与 claim 把手同一把尺，不新造
export const MEMORY_QUOTE_MAX = 200; // 单条引文字符上限：证据是一句话，不是素材库
export const MEMORY_EVIDENCE_MAX = 6; // 一条记忆最多挂几条证据

// 记忆素材（memory --digest，PRD-memory §六）：一次性命令的硬顶。超了从最旧的会话
// 整段丢，并在输出头上写明丢了哪些；--max 可显式覆盖，仍按会话整段取舍。
export const MEMORY_DIGEST_TOKENS = 30000;
// 速率式（selftest 断言，不写死快照）：首跑 2026-10-28 本项目 2 会话实测 3251t，
// 取 400 固定 + 2800/会话（含 25% 余量）。素材按会话整段取舍，所以速率是可加的。
export const MEMORY_DIGEST_FIXED = 400;
export const MEMORY_DIGEST_PER_SESSION = 2800;
// memory 读取：首跑零记忆 227t、4 条记忆 342t；固定 300 覆盖「现在到哪」，每条按上限 110t 计。
export const MEMORY_READ_FIXED = 300;
export const MEMORY_READ_PER_ENTRY = 110;

// 记忆归纳的触发门（PRD-memory §十二，2026-11-12 用户定）：看增量，不看日历。
// 项目记忆：自上次归纳以来新增多少条带 lesson 的块 / 多少个会话分析过；
// 用户画像：自上次画像以来新增多少个会话。
// 注意与「证据门」分开：一条画像至少 2 个不同会话的证据是写入闸门（MEMORY_* 那几条），
// 不随这里的触发门变化。阈值是启动值，跑一段按命中率调——只改这里，别在别处写数字。
export const MEMORY_PROJECT_LESSON_DUE = 8;
export const MEMORY_PROJECT_SESSION_DUE = 3;
export const MEMORY_USER_SESSION_DUE = 8;
