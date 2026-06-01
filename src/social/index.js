import { startClawbotConnector } from './wechat-clawbot.js'

const running = new Map()

export async function startSocialConnectors({ pushMessage, emitEvent } = {}) {
  try {
    const connector = await startClawbotConnector({ pushMessage, emitEvent })
    if (connector) {
      running.set('wechat-clawbot', connector)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'started' })
    }
  } catch (error) {
    console.error(`[social] wechat-clawbot connector failed to start: ${error.message}`)
    emitEvent?.('social_status', { status: 'start_error', platform: 'wechat-clawbot', error: error.message })
  }

  return [...running.values()]
}

export async function restartConnector(platform, { pushMessage, emitEvent } = {}) {
  if (platform !== 'wechat-clawbot') return

  const existing = running.get(platform)
  if (existing) {
    try { existing.stop() } catch {}
    running.delete(platform)
  }

  try {
    const connector = await startClawbotConnector({ pushMessage, emitEvent })
    if (connector) {
      running.set(platform, connector)
      emitEvent?.('social_status', { platform, status: 'restarted' })
    }
  } catch (error) {
    console.error(`[social] ${platform} restart failed: ${error.message}`)
    emitEvent?.('social_status', { status: 'start_error', platform, error: error.message })
  }
}
