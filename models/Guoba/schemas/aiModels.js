function makeAiBlock(displayName, prefix, urlField, modelField, keyField, urlPlaceholder, modelPlaceholder, usageHint) {
  return [
    {
      field: `${prefix}.${urlField}`,
      label: `${displayName} · URL`,
      component: "Input",
      bottomHelpMessage: `${usageHint}。完整 endpoint URL（含 /v1/chat/completions）`,
      componentProps: { placeholder: urlPlaceholder }
    },
    {
      field: `${prefix}.${modelField}`,
      label: "┗ 模型名",
      component: "Input",
      bottomHelpMessage: "模型名，按你用的站点给的模型列表填",
      componentProps: { placeholder: modelPlaceholder }
    },
    {
      field: `${prefix}.${keyField}`,
      label: "┗ API Key",
      component: "InputPassword",
      bottomHelpMessage: "这个服务的密钥（sk- 开头那种）",
      componentProps: { placeholder: "sk-xxxxx" }
    }
  ]
}

export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "AI 模型配置"
  },
  ...makeAiBlock(
    "对话追踪模型（判断你在不在跟它说话）",
    "trackAiConfig",
    "trackAiUrl", "trackAiModel", "trackAiApikey",
    "https://api.openai.com/v1/chat/completions",
    "gpt-4o-mini",
    "判断群友的消息是不是在跟它说话（没@时的接话判断）。推荐便宜快速的小模型"
  ),
  {
    component: "Select",
    label: "判定通道 judgeProvider",
    field: "trackAiConfig.judgeProvider",
    bottomHelpMessage: "上面两处判断（接着聊、要不要插话）用哪个模型做。TypeSafe=专用判断模型，给出把握程度百分比，失败自动退回上面的对话追踪模型。切换后需重启 Yunzai",
    componentProps: {
      options: [
        { label: "TypeSafe 判断模型（给把握百分比，失败自动退回）", value: "typesafe" },
        { label: "用上面的对话追踪模型判断（原方式）", value: "flash" }
      ]
    }
  },
  {
    component: "Switch",
    label: "判定过程落盘",
    field: "trackAiConfig.typesafeDump",
    bottomHelpMessage: "每次 Jev 判定把原始请求和响应原样写到 /root/tmp/jev-last-request.json 和 jev-last-response.json（覆盖式，看最近一次）。排查判断问题用，平时可关"
  },
  ...makeAiBlock(
    "工具决策模型（判断要不要用工具）",
    "toolsAiConfig",
    "toolsAiUrl", "toolsAiModel", "toolsAiApikey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-2.5-flash",
    "判断该不该调用某个工具（旧双阶段用；一次搞定模式下由主对话模型兼任）"
  ),
  ...makeAiBlock(
    "主对话模型（写回复用的，最重要）",
    "chatAiConfig",
    "chatApiUrl", "chatApiModel", "chatApiKey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-2.5-pro",
    "写回复内容用的模型，直接决定它说话的质量和智力，挑最好的"
  ),
  ...makeAiBlock(
    "画图模型",
    "imageEditAiConfig",
    "imageEditApiUrl", "imageEditApiModel", "imageEditApiKey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-3-pro-image-preview",
    "用于 googleImageEditTool（图生图）、bananaTool（文生图）等图片生成工具"
  ),
  ...makeAiBlock(
    "看图模型（识图）",
    "analysisAiConfig",
    "analysisApiUrl", "analysisApiModel", "analysisApiKey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-3-pro-preview",
    "看懂群里的图片、给表情包打标签、内容审核用。必须选能看图的模型（多模态）"
  ),
  ...makeAiBlock(
    "联网搜索模型",
    "searchAiConfig",
    "searchApiUrl", "searchApiModel", "searchApiKey",
    "https://api.openai.com/v1/chat/completions",
    "deepseek-r1-search",
    "用于 searchInformationTool 联网搜索，建议使用带搜索能力的模型"
  ),
  ...makeAiBlock(
    "记忆提取 memoryAiConfig",
    "memoryAiConfig",
    "memoryAiUrl", "memoryAiModel", "memoryAiApikey",
    "https://api.openai.com/v1/chat/completions",
    "gpt-4o-mini",
    "用于长期记忆提取、表达学习的 AI 场景化学习，推荐小模型省钱"
  ),
  ...makeAiBlock(
    "语义向量模型（判断意思相近用的）",
    "embeddingAiConfig",
    "embeddingApiUrl", "embeddingApiModel", "embeddingApiKey",
    "https://api.openai.com/v1/embeddings",
    "text-embedding-3-small",
    "把文字变成数字向量、用于按意思匹配（表情包选图、知识库检索）。⚠️ URL 结尾是 /v1/embeddings，不是 chat/completions"
  )
]
