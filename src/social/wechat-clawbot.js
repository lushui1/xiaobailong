import { WeChatClient } from 'wechat-ilink-client'
import { getClawbotCredentials, setClawbotCredentials, clearClawbotCredentials } from '../config.js'
import { upsertClawbotToken, getAllClawbotTokens } from '../db.js'

let client = null
let currentQrUrl = null   // set during login, cleared after scan
let clawbotStatus = 'idle' // idle | qr_pending | connected | error

// Called by dispatch.js to send replies back to WeChat
export async function sendClawbotMessage(userId, content) {
  if (!client || clawbotStatus !== 'connected') {
    return { ok: false, reason: 'wechat-clawbot not connected' }
  }
  try {
    await client.sendText(userId, content)
    return { ok: true, platform: 'wechat-clawbot' }
  } catch (err) {
    console.error(`[ClawBot] sendText 失败: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

// Called by api.js for GET /social/wechat-clawbot/qr
export function getClawbotQR() {
  return { status: clawbotStatus, qr_url: currentQrUrl }
}

// Called by api.js for POST /social/wechat-clawbot/logout
export function logoutClawbot() {
  clearClawbotCredentials()
  clawbotStatus = 'idle'
  currentQrUrl = null
  try { client?.stop?.() } catch {}
  client = null
}

export function startClawbotConnector({ pushMessage, emitEvent } = {}) {
  const saved = getClawbotCredentials()

  client = new WeChatClient(saved ? {
    accountId: saved.accountId,
    token: saved.botToken,
    baseUrl: saved.baseUrl,
  } : {})

  // Monkey-patch client.api.apiFetch：库内部 sendMessage 只 await apiFetch、丢掉响应文本，
  // 而 apiFetch 仅在 HTTP !res.ok 时抛错——HTTP 200 + body 里 {"ret": -1} 这种业务失败被完全吞掉，
  // 导致 sendText 报"成功"但消息没投递。这里拦响应：sendmessage 端点解析 JSON，
  // 发现非零 ret/code 时显式抛错，让上层 sendClawbotMessage 的 catch 拿到真实失败原因。
  try {
    const rawApiFetch = client.api?.apiFetch?.bind(client.api)
    if (typeof rawApiFetch === 'function') {
      client.api.apiFetch = async (params) => {
        const rawText = await rawApiFetch(params)
        if (params?.endpoint === 'ilink/bot/sendmessage') {
          let body = null
          try { body = JSON.parse(rawText) } catch {}
          if (body && typeof body === 'object') {
            const ret = body.ret ?? body.code ?? body.errcode
            if (ret != null && ret !== 0) {
              const errMsg = body.err_msg || body.errmsg || body.message || body.msg || ''
              console.error(`[ClawBot] sendMessage 服务端拒绝 ret=${ret} ${errMsg} raw=${rawText.slice(0, 500)}`)
              throw new Error(`iLink sendmessage rejected: ret=${ret} ${errMsg}`)
            }
          }
        }
        return rawText
      }
      console.log('[ClawBot] sendMessage 响应校验已启用')
    } else {
      console.warn('[ClawBot] client.api.apiFetch 不可访问，跳过响应校验（库实现可能已变化）')
    }
  } catch (err) {
    console.warn(`[ClawBot] 安装响应校验失败（不致命，继续启动）: ${err.message}`)
  }

  // 启动时把上次落盘的 context_token 回填到内存 Map：
  // ilink 库 sendText 用的是 this.contextTokens.get(to)，重启后这个 Map 是空的；
  // 不回填则只能等用户先发一条新消息才能回复。token 可能服务端已过期，所以
  // sendText 仍可能失败，executor 已有兜底提示，这里只是尽量恢复。
  // contextTokens 在 .d.ts 里是 private 但运行时是普通 class field —— 加 guard 防作者哪天换成 # 真私有。
  try {
    if (client.contextTokens instanceof Map) {
      const rows = getAllClawbotTokens()
      if (rows.length) {
        for (const row of rows) {
          client.contextTokens.set(row.from_user_id, row.context_token)
        }
        console.log(`[ClawBot] 已从持久化恢复 ${rows.length} 条 context_token`)
      }
    } else {
      console.warn('[ClawBot] client.contextTokens 不可访问（库实现可能已变化），跳过 token 恢复')
    }
  } catch (err) {
    console.warn(`[ClawBot] 恢复 context_token 失败（不致命，继续启动）: ${err.message}`)
  }

  client.on('message', (msg) => {
    // 每条入站消息都带新鲜的 context_token —— 库已经在内部 set 到 Map 了，
    // 这里只是同步落盘一份，让下次重启能继承当前会话。
    if (msg?.context_token && msg?.from_user_id) {
      try { upsertClawbotToken(msg.from_user_id, msg.context_token) } catch {}
    }
    const text = WeChatClient.extractText?.(msg) ?? extractText(msg)
    if (!text) return
    const fromId = `wechat:clawbot:${msg.from_user_id}`
    pushMessage(fromId, text, 'WECHAT_CLAWBOT', {
      social: { platform: 'wechat-clawbot', user_id: msg.from_user_id },
    })
    emitEvent?.('message_in', {
      from_id: fromId,
      content: text,
      channel: 'WECHAT_CLAWBOT',
      timestamp: new Date().toISOString(),
    })
  })

  client.on('error', (err) => {
    console.error(`[ClawBot] 错误: ${err.message}`)
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
  })

  client.on('sessionExpired', () => {
    console.warn('[ClawBot] 会话已过期，请重新扫码登录')
    clearClawbotCredentials()
    clawbotStatus = 'idle'
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'session_expired' })
  })

  if (!saved) {
    // 首次登录：发起扫码流程
    clawbotStatus = 'qr_pending'
    console.log('[ClawBot] 未找到已保存凭证，开始扫码登录...')
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'qr_pending' })

    client.login({
      onQRCode(url) {
        currentQrUrl = url
        clawbotStatus = 'qr_ready'
        console.log(`[ClawBot] 二维码已就绪，请在设置面板扫码`)
        emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'qr_ready', qr_url: url })
      },
    }).then(result => {
      currentQrUrl = null
      // wechat-ilink-client 的 login() 在超时/取消等情况下不会 reject，
      // 而是 resolve 一个 { connected: false, message } —— 必须显式检查 connected 字段，
      // 否则会误把超时当成扫码成功，UI 卡在虚假的"已连接"
      if (!result?.connected || !result?.accountId || !result?.botToken) {
        clawbotStatus = 'idle'
        const reason = result?.message || '未知原因'
        console.warn(`[ClawBot] 扫码登录未完成: ${reason}`)
        emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'idle', reason })
        return
      }
      clawbotStatus = 'connected'
      setClawbotCredentials({
        accountId: result.accountId,
        botToken: result.botToken,
        baseUrl: result.baseUrl,
      })
      console.log(`[ClawBot] 扫码登录成功，已保存凭证`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'connected', accountId: result.accountId })
      client.start().catch(err => console.error(`[ClawBot] start 失败: ${err.message}`))
    }).catch(err => {
      clawbotStatus = 'error'
      console.error(`[ClawBot] 扫码登录失败: ${err.message}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
    })
  } else {
    // 凭证已存，直接启动
    clawbotStatus = 'connected'
    console.log(`[ClawBot] 使用已保存凭证启动（accountId: ${saved.accountId}）`)
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'connected', accountId: saved.accountId })
    client.start().catch(err => {
      // start 失败说明凭证已失效或后端连不上 —— 必须同步把内存状态打回去，
      // 否则 popup 查询时仍会拿到 'connected'，UI 显示"已连接"但实际啥都不通
      clawbotStatus = 'error'
      console.error(`[ClawBot] start 失败: ${err.message}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
    })
  }

  return {
    platform: 'wechat-clawbot',
    stop() {
      clawbotStatus = 'idle'
      try { client?.stop?.() } catch {}
    },
  }
}

// 从消息结构中提取文本（兼容 extractText 未导出的情况）
function extractText(msg) {
  if (!msg) return ''
  const items = msg.item_list || msg.itemList || []
  for (const item of items) {
    if (item.type === 1 || item.type === 'text') {
      return item.text_item?.text || item.textItem?.text || ''
    }
  }
  return ''
}
