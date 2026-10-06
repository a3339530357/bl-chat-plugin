// Frozen historical wire format: migrations must not generate fixtures through
// the current renderer, which intentionally no longer sends these fields.
export function legacyReferenceContent({ turnId, userId, messageId, asOf, allowedTools = [], references = {} }) {
  const metadata = { turnId, currentUserQQ: String(userId), targetMessageId: messageId ?? null, asOf, allowedTools, newObserverCount: 0 }
  return '\n\n【本轮参考资料】\n' + JSON.stringify(metadata, null, 2) + '\n' + Object.values(references).join('\n') +
    '\n未列出的消息当前没有进行中的任务，不能沿用旧轮 processing/tool_running 状态，也不能把已消费的历史消息当作新任务重复执行。'
}
