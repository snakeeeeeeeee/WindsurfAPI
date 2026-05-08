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
