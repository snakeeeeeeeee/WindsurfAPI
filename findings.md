# Findings

## Git 历史结论

- `3e4bf2f` 已经修过“只试 3 个账号”的问题，改为大账号池最多尝试 10 个账号，避免前几个号限流时永远摸不到健康号。
- 当前 `fastSwitchMaxAttempts=2` 会让实际尝试数重新变成 3，等于把历史问题用配置形式带回来了。
- `e36cae3` 明确修过“Claude 主动探测烧 Trial quota”，历史经验是不应默认主动探测 Claude。
- `225bba2` 修的是 queue timeout 诊断，不要求主动探测。
- `c63bef5` 加 IP-rate-limit burst 短路是为了避免同 IP 下烧穿账号池；如果账号绑定不同动态代理 IP，这个短路应该保守化。

## 当前目标

- 默认高可用策略应该是被动学习：真实成功写健康，真实限流写 CD，代理失败触发换 IP。
- 动态代理 worker 必须独立于 availability worker；关闭模型探测时，代理自动续期/失败重绑仍要运行。

## 2026-05-08 真实缓存复用 / TTFT 结论

- 用户真实日志已经出现过 `stream reuse ... HIT`，所以“跨轮一定 MISS / conversation-pool 需要整套重写”不成立。
- 之前 Claude 声称已修改 `src/conversation-pool.js`、双锚定 cache_control、跑过 66/66，是未被 git diff 支持的说法。
- CCTest 报告可被 report-only usage 影响，但真实使用场景不应靠改写 usage 解决；保留 `upstream` 才能反映真实上游 cache_read/cache_write。
- 长文本首字慢有两部分：真实模型/上游首 chunk 产生时间，以及本地 Cascade polling 抓到首 chunk 的等待时间。自适应 early polling 只能降低后者，不能保证 `<1s`。
- 真实低命中排查应看 reuse MISS 细节里的 `systemHash`、`toolsHash`、`callerHash`、`projectedHash`，判断是 system/tools/caller/history 哪个维度漂移。
- Docker 线上环境里 `.env` 不是业务 env 的唯一权威源；SQLite `runtime.config.envConfig` 会在启动时覆盖 `WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS` 等键，导致 `.env` 清空后 CCTest 仍看到 `input_tokens=1`。
- 2026-05-08 CCTest 日志显示普通顺序对话已能 `fpBefore -> fpAfter -> next fpBefore` 连续 HIT；但工具调用链中 `checkin fpAfter` 与下一轮 `fpBefore` 持续不一致，且集中在 assistant/tool/tool_result 历史，不能通过忽略工具参数这种高风险方式直接放宽。
- Docker Compose 已配置 `restart: unless-stopped` 时，Dashboard 普通服务重启不需要 Docker socket；API 返回成功后受控 `process.exit(0)`，由 Docker 拉起新进程，新进程会按启动流程重新加载 `.env` 和 SQLite runtime-config 覆盖值。
- 真实日志里 `HIT` 后客户端中断会因为 checkout 已取走 entry 而导致下一次同 fp MISS；但该请求已经进入同一 Cascade，恢复旧 entry 有重复发送同一 user turn 的风险，不应盲目回填。
- 真实日志里 `toolCalls=5` 后下一轮变成 MISS 的更确定原因是 `fingerprintBefore()` 只剥掉最后一个 trailing `tool` 消息；OpenAI/Codex 会一次带回多个连续 tool results，必须把整组 trailing tool results 作为最新输入 turn 一起剥掉，才能匹配上一轮 assistant tool_calls checkin 的 fpAfter。
- 2026-05-09 CCTest 日志里 input tokens 已恢复为真实上游 `570`，说明 Dashboard 清空 Fresh input tokens 覆盖后 SQLite runtime config 已生效；剩余高倍率主要来自工具链多轮 `reuse MISS` 和 cache_read 仅约 4401。
- 同一日志里单个 `toolCalls=1` 后下一轮仍 MISS，说明不仅是连续 tool results；客户端历史里的 assistant `tool_calls` 参数可能使用顶层 `arguments` / `argumentsJson`，而本地合成 checkin 使用 `function.arguments`。指纹投影需要兼容这些常见形态。
