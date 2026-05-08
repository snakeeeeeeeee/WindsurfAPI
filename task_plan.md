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
