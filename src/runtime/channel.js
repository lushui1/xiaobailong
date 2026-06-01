export const CHANNEL_NORMALIZE = {
  WECHAT_CLAWBOT: 'WECHAT',
  WECHAT_OFFICIAL: 'WECHAT',
  WECHAT: 'WECHAT',
  WECOM: 'WECOM',
  DISCORD: 'DISCORD',
  FEISHU: 'FEISHU',
  TUI: 'TUI',
  API: 'TUI',
  voice: 'TUI',
  '语音识别': 'TUI',
  FocusBanner: 'TUI',
  REMINDER: 'SYSTEM',
  SYSTEM: 'SYSTEM',
  APP_SIGNAL: 'SYSTEM',
}

// LLM 可选的 channel 枚举（send_message 工具用）
export const PUBLIC_CHANNELS = ['WECHAT', 'DISCORD', 'FEISHU', 'WECOM', 'TUI', 'AUTO']

export function normalizeChannel(channel) {
  if (!channel) return 'TUI'
  if (CHANNEL_NORMALIZE[channel] != null) return CHANNEL_NORMALIZE[channel]
  return String(channel).toUpperCase()
}
