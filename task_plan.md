# WindsurfAPI 被动强可用精简计划

## Goal

把当前过重的高可用调度收敛为“被动强可用 + 动态代理自动维护”：

- 默认不主动探测 Claude 模型，避免烧真实调用额度。
- 保留真实请求失败后的快速换号能力。
- 保留账号级模型 CD、同系列 fallback、Cascade reuse 粘性。
- 保留动态代理绑定、检测、过期/失败自动换 IP。
- Dashboard 面板隐藏复杂 breaker/worker 参数，展示少量可操作状态。

## Phases

- [complete] Phase 1: 梳理当前默认配置、worker、Dashboard 接口。
- [complete] Phase 2: 调整默认策略为被动强可用，恢复每请求最多尝试 10 个账号。
- [complete] Phase 3: 拆出动态代理 worker，使其不依赖模型探测 worker 开关。
- [complete] Phase 4: 精简 Dashboard 高可用/动态代理展示与配置。
- [complete] Phase 5: 针对性语法检查和已有回归测试。

## Decisions

- 不删除底层 Redis/SQLite 状态能力，先改变默认行为和面板入口。
- 主动模型探测保留为手动/高级能力，不再作为生产默认。
- 动态代理自动维护独立保留。

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| 旧 runtime-config / SQLite 已保存值可能覆盖 .env 新默认 | 设计检查 | 代码增加旧 aggressive 默认迁移；如果生产 DB 是人工改过的 aggressive 配置，需要在 Dashboard 保存一次新配置 |

## 2026-05-08 真实缓存复用与长文本首字优化

## Goal

- 优化真实使用场景下的 Cascade 会话复用和可诊断性，不为了 CCTest 外观改写 usage。
- 降低长 Cascade 请求中轮询带来的首字等待，并补充首 chunk / 首文本诊断字段。
- 不再承诺未经实测的命中率或 TTFT 数字。

## Phases

- [complete] Phase 1: 核验 Claude 之前声称的改动，确认 `conversation-pool.js` 没有本轮大改。
- [complete] Phase 2: 移除偏 CCTest 外观的 `hybrid_max` / 跨 caller cache scope 方案，保留真实 caller 隔离。
- [complete] Phase 3: 验证 Cascade 自适应轮询和 TTFT 诊断。
- [complete] Phase 4: 增加 reuse MISS 指纹组成摘要，定位 system/tools/caller/history 漂移。
- [complete] Phase 5: 增加 Dashboard 运行时业务 env 配置页，避免 Docker/SQLite 覆盖 `.env` 难排查。
- [complete] Phase 6: 增加 Cascade checkin 的 after projectedHash 诊断，定位 CCTest tool-call 链 fpAfter/fpBefore 不一致。
- [complete] Phase 7: 增加 Dashboard 服务重启按钮，保存运行时配置后可由 Docker/进程守护重新拉起并读取 SQLite 覆盖配置。
- [complete] Phase 8: 修复工具调用轮 assistant 文本回放差异导致的复用 MISS，并补充 hash-only projectedTail 诊断。
- [complete] Phase 9: 修复 stream 冷无输出 transient stall 被 fast-switch 预算挡住、无法换账号重试的问题。

## 2026-05-10 CCTest 目标命中率补写配置

## Goal

- 在 Dashboard 增加目标缓存命中率补写配置。
- 默认关闭，不影响当前 tail-only cache write 行为。
- 开启后基于最终 cache_read 反推最低 cache_creation，使 CCTest 命中率可稳定靠近 90% 等目标。

## Phases

- [complete] Phase 1: 梳理现有 usage runtime env、面板字段和测试位置。
- [complete] Phase 2: 后端增加目标命中率补写逻辑。
- [complete] Phase 3: Dashboard/runtime-config/i18n 增加配置项。
- [complete] Phase 4: 补回归测试并本地验证。
- [complete] Phase 5: 热更新 Docker 并做实际调用验证。

## 2026-05-10 CCTest 展示命中率 input floor

## Goal

- 处理 CCTest 顶部缓存命中率仍显示 99% 的展示口径。
- 保留现有 write floor，同时新增按 `cache_read / (input + cache_read)` 口径补 fresh input 的开关。
- 通过 Dashboard 可配置，默认关闭。

## Phases

- [complete] Phase 1: 确认 CCTest 顶部命中率疑似忽略 cache_creation。
- [complete] Phase 2: 新增 `WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_TARGET_INPUT_FLOOR`。
- [complete] Phase 3: Dashboard/runtime-config/i18n 增加配置项。
- [complete] Phase 4: 增加 read-only hit-rate 回归测试并验证。
- [complete] Phase 5: 热更新 Docker，清理旧命中率覆盖并启用新配置。

## 2026-05-10 禁用 Cascade 历史裁剪

## Goal

- 用户确认模型路由支持长上下文，要求不要裁剪历史。
- 增加显式运行时开关，允许完整回放客户端历史。
- 通过 Dashboard 可配置，默认关闭。

## Phases

- [complete] Phase 1: 确认当前裁剪由 `cascadeHistoryBudget()` 控制。
- [complete] Phase 2: 增加 `CASCADE_DISABLE_HISTORY_TRIM=1` 开关。
- [complete] Phase 3: Dashboard/runtime-config/i18n 增加配置项。
- [complete] Phase 4: 增加回归测试并验证。
- [complete] Phase 5: 热更新 Docker 并启用配置。

## 2026-05-10 Claude CLI /compact 纯文本兼容

## Goal

- 不恢复历史裁剪，继续允许完整长上下文传入。
- 修复 Claude CLI `/compact` 报 `response did not contain valid text content`。
- 会话压缩/摘要请求强制纯文本返回，不让代理把摘要输出误解析成 `tool_use`。

## Phases

- [complete] Phase 1: 定位 `/v1/messages` 到 chat 工具解析路径。
- [complete] Phase 2: Messages 层识别会话压缩/续聊摘要请求，并移除本轮 tools/tool_choice。
- [complete] Phase 3: Chat 层在 `__forceTextResponse` 下禁用 native bridge、tool preamble、流式/非流式工具输出解析。
- [complete] Phase 4: 增加回归测试并验证普通文件总结不误伤。
- [complete] Phase 5: 热更新 Docker 服务并确认健康状态。
