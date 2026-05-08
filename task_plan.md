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
