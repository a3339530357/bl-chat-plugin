# Single-stage Agent Mode

单阶段位于 V2 内，默认关闭。它统一使用 `chatAiConfig`，模型返回文本即作为最终回复；返回原生工具调用时执行并追加结果，然后沿同一路由续话。

## 配置

配置文件中的新默认值：

```yaml
promptCache:
  singleStage: false
  singleStageGroups: []
  agentTemperature: 0.85
  agentTopP: 0.95
  agentSideEffectPolicy: contextual
  agentToolPolicies: {}
```

启用一个群需要同时满足插件/V2 开启、群在 `promptCache.groups` 中、`singleStage=true`、群在 `singleStageGroups` 中。空列表不启用任何群；单阶段群列表中的 `*` 仍受 V2 群列表限制。`groupHistory=false` 或不支持的协议不能启用单阶段。

`chatAiConfig.chatApiUrl/chatApiModel/chatApiKey` 必须有效并支持 OpenAI 原生工具协议。单阶段不会调用 toolsAiConfig；关单阶段或退回旧代码前，仍须确认双阶段的工具 API 配置有效。

temperature/top_p、路由、凭证、模式、工具声明和权限按本轮固定。多 key 按 bot/group/day 稳定选择。配置热更新在下一轮应用，不能通过在途切模式重跑已完成动作。V1/V2 双阶段的原采样参数保持原样。

## 动作策略

- `contextual`：默认。保留有语境的轻量互动，自主轻量动作最多一次，不随机扩大目标/次数；语音、管理、送礼、图片发送、编辑和定时等需当前明确意图。
- `explicit`：所有副作用需明确请求。
- `legacy`：保留原自主策略，仍受执行白名单、同轮去重和预算约束。

引用、历史命令、否定句、能力询问和未来动作不能直接授予当前执行资格；管理权限来自真实发送者，模型 `senderRole/selfDecision/confirm` 不提供授权。内建语音等工具不能通过改分类为 read 绕过要求。

当前意图识别是保守规则，并非完整自然语言授权证明；模糊说法可能需要改用明确指令或让机器人澄清。视频、头像、导图和红包不依赖网关 named/none；工具 schema 常驻，当前目标通过 requiredTools 与执行权限校验。

未知自定义/MCP 工具默认需明确意图。可信管理员可以在 YAML 对未知工具配置分类和意图关键词：

```yaml
promptCache:
  agentToolPolicies:
    myReadOnlyLookup:
      category: read
    myCustomAction:
      category: effect
      intentKeywords: [明确的动作指令]
```

可用分类为 read/light/effect/manage/wait。不要将有实际副作用的工具标记为 read；远端工具描述或只读提示不会自动改变分类。voiceTool 等描述只修改 agent schema clone，共享工具实例及双阶段声明不变。

## 循环与账本

无工具正常轮仅一次请求；K 批普通工具约 K+1 次请求；全部成功终态工具直接结束。没有常规 Q_t/F_t 或第二个聊天模型请求。

`maxToolRounds=R` 限制真实 dispatch 批次；每批可多调用，单批结构上限32。初始/续话/异常恢复共最多 R+2 个逻辑主请求，每个逻辑请求最多一次传输重试，总 HTTP attempt 上限为 2*(R+2)。业务错误不传输重试。空回复、畸形调用、强制目标未达和收尾共用一次恢复机会。

相同参数的副作用同轮不重复执行，参数指纹规范化不修改 wire arguments；拒绝、失败、跳过和预算耗尽仍按 call ID 闭合回执。工具结果过大时保留结果并明确退出，不静默裁掉当前前缀或自动重跑整轮。

新块为 `replayVersion=3/mode=agent/apiRows`，只保存一套原生数据；`referenceVersion=2` 仍表示当前资料入账剥离。QQ 展示继续使用清洗/分段/@/转图，模型原文、签名与实际投递记录分开。失败不伪造已送达 Bot 事件。

原消息 Journal、群游标、represented 和 committed_turns 共享。旧 toolRows/chatRows 与新 apiRows 可以共存，旧块不被重建；新代码切回双阶段时生成确定性兼容视图。模式切换、header/schema、兼容 renderer 和完整块裁剪是可观测缓存断点。上游 TTL/命中由 usage 实测，不做后台保活。

## 回滚

首选关闭 `singleStage` 或移除灰度群。新代码能够继续读取单阶段期间的历史，正在运行的旧轮按原模式闭合。

直接回退 ac3b4ce 前要停止新轮并等待在途任务结束，将 apiRows 转成旧格式。导出器默认 dry-run，只连接指定群/账号已有的活动 scope，不能初始化新 scope。

```bash
node scripts/export-agent-replay-as-dual.mjs --bot BOT_ID --group GROUP_ID --host 127.0.0.1 --port 6379
```

Unix socket 可用 `--socket PATH`；非默认库可用 `--db N`；测试/自定义前缀可用 `--prefix PREFIX`；`--day YYYYMMDD` 默认北京时间今天，过期 scope 拒绝操作。Redis 密码通过 `REDISCLI_AUTH` 环境提供，不写入命令参数。

确认预览后应用，必须提供一个尚不存在的备份路径：

```bash
node scripts/export-agent-replay-as-dual.mjs --bot BOT_ID --group GROUP_ID --host 127.0.0.1 --port 6379 --apply --backup /root/tmp/agent-replay-backup.json
```

备份保存原始块和元数据，权限0600。转换以 scope/resetId、完整 list 和相关 hash 的一致性为前提；并发提交/reset/过期会拒绝，保留游标及消息源信息。没有可用的旧 header 时需要 `--header PATH` 指定完整双阶段 header；正常 agentHeader 已携带 rollbackHeader。

转换后才可退旧代码。恢复备份也需要排空在途任务和新备份路径：

```bash
node scripts/export-agent-replay-as-dual.mjs --bot BOT_ID --group GROUP_ID --host 127.0.0.1 --port 6379 --restore /root/tmp/agent-replay-backup.json --apply --backup /root/tmp/agent-replay-restore-backup.json
```

若转换后账本已经发生新提交，恢复会拒绝，不覆盖新数据。不要用清空历史替代兼容转换。旧日 scope 不被恢复到新日；进程硬崩溃后的副作用恰好一次执行不在本功能保证中。

## 灰度验收

交付默认关闭，不自动部署。先一群，再少量扩群，比较普通/工具/终态/冷场样本的实际主请求数、Σcached/Σinput、未缓存 tokens、P50/P95 延迟、空回复、参数错误、无意图副作用及角色自然度。

生产灰度需覆盖冷场后首轮，不能只取活跃期缓存比例。发生重复副作用、丢账、游标回退或越权立即关单阶段。独立网关探测不执行 QQ/MCP/真实工具，也不能代表全天成本与自然度已经验收。
