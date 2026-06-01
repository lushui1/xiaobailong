// mimo TTS 提供商
// 小米 mimo-v2.5-tts 通过 chat completions 接口调用
import { Readable } from 'stream'

export class MimoTTS {
  constructor(apiKey, baseUrl = 'https://token-plan-cn.xiaomimimo.com') {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.model = 'mimo-v2.5-tts'
  }

  async synthesize(text) {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'user', content: '请朗读以下内容' },
          { role: 'assistant', content: text }
        ]
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`mimo TTS failed (${response.status}): ${error}`)
    }

    const data = await response.json()
    const audioBase64 = data.choices?.[0]?.message?.audio?.data
    
    if (!audioBase64) {
      throw new Error('mimo TTS: no audio data in response')
    }

    return Buffer.from(audioBase64, 'base64')
  }

  // 返回 Node.js Readable stream
  async synthesizeStream(text) {
    const buffer = await this.synthesize(text)
    return Readable.from(buffer)
  }
}
