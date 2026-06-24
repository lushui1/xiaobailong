// voice-panel.js —— 语音面板编排层
//
// 组装共享会话引擎（voice-core）+ 两个模式策略（常开 voice-continuous / 按住空格 voice-ptt），
// 暴露 initVoicePanel + window.xiaobailongVoice（承重墙：app.js 的 TTS 打断与视频/音乐联动依赖它）。
//
// 解耦结构：
//   voice-core.js       共享机制——点云渲染 + 麦克风采集 + ASR 传输/转录 + 会话生命周期
//   voice-continuous.js  常开策略——自动断句发送 + barge-in 打断检测（会话默认策略）
//   voice-ptt.js         PTT 策略——按住门控 + 松手立即发送（在常开策略之上叠加）
//
// 改一个模式的策略只动对应文件，底层机制集中在 core；两模式共用同一个 core 会话，
// 以保持「常开在跑时按空格 = 强制立即发一次」的叠加语义。

import { createVoiceCore } from './voice-core.js';
import { createContinuousPolicy } from './voice-continuous.js';
import { createPttController } from './voice-ptt.js';

export function initVoicePanel({
  btnId, panelId, canvasId, statusId, transcriptId,
  getChatInput, getSendBtn, getSendMessage, getLang, getAutoSend, getAutoMic,
}) {
  const btn        = document.getElementById(btnId);
  const panel      = document.getElementById(panelId);
  const canvas     = document.getElementById(canvasId);
  const transcript = document.getElementById(transcriptId);

  if (!panel || !canvas) return;

  // ─── 组装 core + 两个模式策略 ───
  const core = createVoiceCore({ canvas, transcript, getChatInput, getSendMessage, getLang });
  const continuous = createContinuousPolicy(core, { getAutoSend });

  // 常开会话开关：点球/按钮触发，也被 PTT 在「mic 未开」时复用（保持叠加语义）
  async function toggleVoice() {
    if (!core.micActive) {
      // startSession 内部已处理失败回退 + 状态同步
      return Boolean(await core.startSession());
    }
    core.stopSession();
    return false;
  }

  const ptt = createPttController(core, {
    toggleVoice,
    cancelAutoSend: continuous.cancelAutoSend,
  });

  // 安装模式策略钩子：continuous = 会话默认策略；PTT 通过 core.pttHolding 在其上叠加。
  core.setOnFrame(continuous.onFrame);
  core.setOnTranscript(continuous.onTranscript);
  core.setOnSessionStop(continuous.onSessionStop);
  core.setOnSuspendForTTS(continuous.onSuspendForTTS);
  core.setOnResume(continuous.onResume);
  // 会话状态变化 → 同步按钮高亮（mic 开着或用户保留了开麦意图时高亮）
  core.setOnState(() => {
    btn?.classList.toggle('active', core.micActive || core.userWantedMic);
  });

  // ─── 承重墙：window.xiaobailongVoice 接口契约（app.js 依赖，不可改形状） ───
  window.xiaobailongVoice = {
    isActive: () => core.micActive,
    // 视频/音乐模式：完全停止 mic（不需要打断能力）
    suspendForMedia: () => core.suspendForMedia(),
    // TTS 模式：只停云端 ASR WebSocket，保持 mic 硬件 + ScriptProcessor，开启打断预缓冲
    suspendForTTS: () => core.suspendForTTS(),
    // TTS 正常结束：清掉续播计时再恢复会话
    resumeAfterMedia: () => {
      continuous.clearNoSpeechTimer();
      core.resumeSession(false);
    },
    stop: () => core.stopSession(),
    setTTSAnalyser: (analyser) => core.setTTSAnalyser(analyser),
    pttStart: ptt.pttStart,
    pttEnd: ptt.pttEnd,
  };

  window.addEventListener('xiaobailong:video-mode', (event) => {
    if (event.detail?.active) {
      window.xiaobailongVoice.suspendForMedia();
    } else {
      window.xiaobailongVoice.resumeAfterMedia();
    }
  });

  window.addEventListener('xiaobailong:music-mode', (event) => {
    if (event.detail?.active) {
      window.xiaobailongVoice.suspendForMedia();
    } else {
      window.xiaobailongVoice.resumeAfterMedia();
    }
  });

  // ─── 面板初始化 ───
  function openPanel() {
    panel.hidden = false;
    core.startRenderLoop();
  }

  btn?.addEventListener('click', toggleVoice);
  canvas.addEventListener('click', toggleVoice);

  core.setStatus('idle');
  openPanel();
  if (getAutoMic?.()) toggleVoice();
}
