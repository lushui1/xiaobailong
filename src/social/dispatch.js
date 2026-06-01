import { sendClawbotMessage } from './wechat-clawbot.js'
import { parseSocialTarget } from './targets.js'

async function sendClawbot({ userId }, content) {
  return sendClawbotMessage(userId, content)
}

export async function dispatchSocialMessage(targetId, content) {
  const target = parseSocialTarget(targetId)
  if (!target) return null
  
  switch (target.platform) {
    case 'wechat-clawbot':
      return sendClawbot(target, content)
    default:
      console.warn(`[dispatch] unsupported platform: ${target.platform}`)
      return { ok: false, skipped: true, reason: `platform ${target.platform} not supported` }
  }
}
