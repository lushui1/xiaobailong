// 白龙马自知识文档 —— 解释自身的代码机制与架构

export const SELF_KNOWLEDGE_TOPICS = {
  self_architecture: {
    id: 'self_architecture',
    title: '白龙马架构与运行机制',
    subtitle: 'How BaiLongma Works',
    icon: '⚙',
    summary: '白龙马（BaiLongma）是一套 Electron + Node.js 混合架构的持续意识框架，版本 2.x。以下是完整的代码机制说明。',
    sections: [
      {
        title: '整体架构',
        content: `白龙马由两层构成：

■ Electron 壳（electron/main.cjs）
  - 负责启动桌面窗口、系统托盘、自动更新
  - 以子进程方式启动 Node.js 后端（src/index.js）
  - 通过 IPC 与渲染进程通信

■ Node.js 后端（src/index.js）
  - 运行真正的"意识循环"
  - 管理 SQLite 数据库、HTTP/WebSocket 服务、LLM 调用
  - 可单独以 npm run start:backend 运行（无 Electron 壳）

Brain UI 前端通过 WebSocket + REST API 与后端实时通信。`,
      },
      {
        title: '意识循环：心跳驱动',
        content: `白龙马不等待用户触发，而是持续运行的事件循环：

■ ticker.js — 心跳节奏器
  - 维护可配置的心跳间隔（默认约 30 秒）
  - 每次 tick 消费后进入下一个心跳周期

■ queue.js — 消息队列
  - 所有消息（用户消息、系统 TICK、社交平台消息）都进队列
  - 队列保证顺序处理，支持优先级中断

■ control.js — 循环控制
  - 负责启动、暂停、恢复循环
  - 保证同一时刻只有一个处理任务在运行

工作流程：
1. 用户消息 → 推入队列 → 触发立即处理（L1 模式）
2. TICK 心跳 → 进入 L2 模式（系统自主思考，可决定是否主动发消息）
3. 社交平台消息 → 经 social/dispatch.js 路由后进队列`,
      },
      {
        title: 'L1 / L2 两种入口',
        content: `白龙马不是"两个人格"，而是同一个 AI 的两种触发入口：

■ L1（用户消息触发）
  - 用户发消息时激活
  - 必须在本轮调用 send_message 至少一次
  - 拥有完整的上下文质量：记忆、人物卡、思维栈等

■ L2（TICK 心跳触发）
  - 系统定时心跳，代表"时间流逝"
  - 无强制回复要求，AI 自行判断是否需要主动发消息
  - 同样拥有 L1 级别的上下文质量：最近对话、记忆、提醒、UI 状态

这种设计让白龙马既能响应用户，又能自主生活。`,
      },
      {
        title: 'LLM 交互：llm.js + prompt.js',
        content: `■ llm.js
  - 封装 OpenAI/DeepSeek 兼容 API 调用
  - 支持流式输出（stream: true）
  - 支持工具调用（tool_calls），解析并触发能力执行
  - 支持 <think> 推理块（DeepSeek R 系列）

■ prompt.js — 系统提示词构建
  - buildSystemPrompt() 组装所有上下文：
    · 固定行为规则（最高优先级）
    · 当前任务状态
    · 人物记忆、思维栈、约束、人格描述
    · 补充上下文（天气、系统信息、热点等）
    · 记忆区
  - 动态注入文档、记忆检索结果等

■ quota.js — 配额管理
  - 速率限制与每日 token 上限控制`,
      },
      {
        title: '记忆系统',
        content: `白龙马有三层记忆机制：

■ 短期：对话历史（messages 表）
  - SQLite 持久化，每轮存储
  - 按最近 N 条 + 时间窗口截取

■ 长期：自动记忆（memories 表）
  - memory/recognizer.js：LLM 自动判断哪些内容值得保存
  - memory/injector.js：根据当前上下文检索相关记忆并注入 prompt
  - 记忆有类型（事实、技能、偏好、人物等）和重要性权重

■ 主动召回：[RECALL: topic]
  - AI 在推理中写下此标记时，触发深度记忆检索
  - memory/refresh-loop.js 定期更新过期记忆

数据库：src/db.js（better-sqlite3，同步 API），表包括：
  conversations、memories、reminders、hotspots、person_cards、docs`,
      },
      {
        title: '工具执行：capabilities/',
        content: `■ capabilities/schemas.js — 工具 JSON Schema 定义
  - 定义所有 LLM 可调用的工具（send_message、exec_command、ui_show、music 等）

■ capabilities/executor.js — 工具调用执行器
  - 接收 LLM 返回的 tool_calls，按名称路由执行
  - 主要能力：
    · send_message：向用户/社交平台发消息
    · exec_command：在沙箱内执行 PowerShell 命令
    · ui_show / ui_update / ui_hide：推送 ACUI 可视化卡片
    · music：搜索、下载、播放本地音乐
    · manage_reminder：创建/取消/列出提醒
    · open_doc_panel：打开参考文档面板
    · fetch_url：抓取网页内容
    · web_search：联网搜索
    · focus_banner：桌面专注横幅

■ capabilities/marketplace/：可安装的扩展工具`,
      },
      {
        title: '上下文感知：环境信息采集',
        content: `白龙马持续感知运行环境：

■ context/gatherer.js — 综合上下文采集器
  - 定时采集所有环境信息并注入 Supplemental Context

■ system-info.js — 系统信息
  - CPU/内存/磁盘使用率、电池状态、操作系统版本

■ geo-weather.js — 地理位置 + 实时天气
  - 城市、时区、国家代码
  - 调用 wttr.in 获取天气数据

■ trending.js — 网络热点
  - 微博热搜、知乎热榜、Hacker News、Reddit 等

■ desktop-scanner.js — 桌面文件扫描
  - 了解用户当前桌面上有哪些文件`,
      },
      {
        title: '社交集成：social/',
        content: `■ social/index.js — 连接器管理器
  - 统一管理所有平台连接，提供 send/receive 接口

■ 支持的平台：
  · social/discord.js — Discord 机器人（discord.js）
  · social/wechat-clawbot.js — 微信（通过 ClawBot 桥接）
  · social/webhooks.js — 通用 Webhook 接收

■ social/dispatch.js — 消息路由分发
  - 将来自不同平台的消息统一格式化后推入队列

所有平台的身份标识（target_id）格式：platform:id
例：discord:123456、wechat:user_openid`,
      },
      {
        title: '语音系统：voice/',
        content: `■ voice/manager.js — 语音总管理器
  - 协调 ASR（语音识别）与 TTS（语音合成）

■ ASR（语音转文字）：
  · voice/whisper/ — 本地 Whisper 模型（Python 子进程）
    支持 tiny / base / small / medium 模型
  · voice/cloud-asr.js — 云端 ASR（阿里云、百度、讯飞）

■ TTS（文字转语音）：
  · voice/tts-providers.js — 多提供商封装
    支持豆包（Doubao）、MiniMax、Edge TTS 等

■ 颜色状态机：
  - 录音中 → 橙色，识别中 → 蓝色，播放中 → 绿色`,
      },
      {
        title: 'UI 系统：Brain UI + ACUI',
        content: `■ Brain UI（src/ui/brain-ui/）
  - 主前端界面，运行于 Electron 渲染进程
  - 模块：
    · app.js — 主应用框架，管理所有面板
    · chat.js — 聊天界面，WebSocket 实时消息
    · thought-stream.js — AI 思维流可视化
    · hotspot.js — 热点信息卡片
    · person-card.js — 人物关系卡片
    · doc.js — 文档参考面板

■ ACUI（src/ui/brain-ui/acui/ 及 ACUI (Remix)/）
  - Agent 控制 UI 组件系统
  - 三种显示模式：
    · notification（右上角通知）
    · center（居中弹窗）
    · floating（可拖拽浮层）
  - 模式 A：注册组件（WeatherCard 等）
  - 模式 B：inline-template（HTML 模板 + 数据绑定）
  - 模式 C：inline-script（完整 Web Component，用于游戏/工具）

■ focus-banner（Focus Banner）
  - 桌面透明浮层横幅，Electron 子窗口
  - 通过 focus_banner 工具控制显示/更新/隐藏`,
      },
      {
        title: 'API 与事件推送',
        content: `■ src/api.js — HTTP + WebSocket 服务器
  - REST API 供前端调用（获取历史、状态、配置等）
  - WebSocket 推送实时事件给前端

■ src/events.js — 事件发射
  - 统一的事件总线：SSE 和 WebSocket 双通道
  - Brain UI 通过 api-client.js 订阅事件流

■ 关键端口：
  - 后端默认监听 localhost:3399（可在 config.json 配置）`,
      },
      {
        title: '配置文件说明',
        content: `■ config.json（根目录）
  - 运行时用户配置：API Key、模型选择、TTS 设置、社交平台 token

■ src/config.js
  - 配置读写模块，统一入口

■ src/paths.js
  - 管理 data/、sandbox/、config/ 等目录路径
  - 开发模式 vs 打包模式下路径不同

■ electron-builder.json
  - 打包配置：NSIS 安装器、文件包含/排除规则

■ 数据目录（data/）
  - db.sqlite：主数据库
  - memories/：持久化记忆文件
  - 沙箱（sandbox/）：exec_command 执行隔离区`,
      },
    ],
  },
}

// 根据用户消息检测是否涉及自知识查询
export function detectSelfKnowledgeTopic(text) {
  if (!text) return null
  const t = text.toLowerCase()

  if (
    /(你的代码|你.*怎么运行|你.*怎么工作|你.*架构|你.*如何运作|白龙马.*代码|bailongma.*代码|你.*实现|代码机制|运行机制|技术架构|你.*内部|你.*系统|你.*模块|你.*是怎么|你.*如何思考|你.*心跳|意识循环|ticker|queue\.js|control\.js|llm\.js|prompt\.js|memory.*机制|记忆.*系统|工具.*调用|capability|executor|acui.*机制|brain.*ui|l1.*l2|l2.*l1|两个入口|turn.*机制|self.knowledge|自知识)/.test(
      t
    )
  ) {
    return 'self_architecture'
  }

  return null
}
