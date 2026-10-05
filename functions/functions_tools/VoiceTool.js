import { AbstractTool } from './AbstractTool.js';
import fs from "fs"
import path from "path"
import YAML from "yaml"
// VoiceTool.js
export class VoiceTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'voiceTool';
    this.description = '这是一个实现你发送语音功能的工具，平常正常对话时、当你想发送语音时调用此工具(注意此工具不是唱歌)。';
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: 'string',
          description: '你想发送的语音文字(注意不要包含颜文字等内容，只要纯文字，颜文字等内容会使语音转文字出问题，如果有英文单词或字母尝试用中文谐音代替)'
        },

      },
      required: ['text']
    };

  }

  async func(opts, e) {
    const { text } = opts;

    // SiliconFlow CosyVoice2 TTS（2026-10-04 换源：原魔搭 AI-jiaran 接口已 404 下线）
    // 配置在插件自身 config/message.yaml 的 voiceAiConfig（与 imageEditAiConfig 同模式）
    try {
      const cfg = this.loadConfig().voiceAiConfig || {}
      if (!cfg.ttsApiKey) return '发送语音失败: 未配置 voiceAiConfig.ttsApiKey'
      const response = await fetch(cfg.ttsApiUrl || 'https://api.siliconflow.cn/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.ttsApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: cfg.ttsModel || 'FunAudioLLM/CosyVoice2-0.5B',
          input: text,
          voice: cfg.ttsVoice || 'FunAudioLLM/CosyVoice2-0.5B:claire',
          response_format: 'mp3'
        })
      })
      if (!response.ok) {
        return `发送语音失败: TTS接口 HTTP ${response.status}`
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      const { randomUUID } = await import('crypto')
      // 临时文件放 TRSS data/ 下：该目录已只读挂载进 NapCat 容器，
      // /root/tmp 未挂载会让 NapCat 读 file:// 时 ENOENT（同视频发送问题）
      const tmpFile = `/root/projects/TRSS-Yunzai/data/voice-${randomUUID().slice(0, 8)}.mp3`
      fs.writeFileSync(tmpFile, buffer)
      await e.reply(segment.record(`file://${tmpFile}`))
      // NapCat 处理完再清理，避免 data/ 堆积语音文件
      setTimeout(() => { try { fs.unlinkSync(tmpFile) } catch { } }, 60000)
      return `发送语音内容(${text})成功，你已经发送语音了，所以不需要强调你已经发送语音，继续说之后的事情，回复的文字内容不要和语音内容重合`
    } catch (error) {
      return `发送语音失败: ${error.message}`
    }
    /* 原魔搭实现（接口已下线，保留备查）

    // try {
    //   const resData = await Bot.sendApi('send_group_ai_record', {
    //     "group_id": groupId,
    //     "character": "lucy-voice-female1",
    //     "text": text
    //   });

    //   if (resData.status == 'ok') {
    //     return `发送语音内容(${text})成功，你已经发送语音了，所以不需要强调你已经发送语音，继续说之后的事情`;
    //   } else {
    //     return `发送语音失败`;
    //   }

    // } catch (error) {
    //   console.error(`发送语音失败:`, error);
    //   return `发送语音失败: ${error.message}`;
    // }


    try {
      let file_url
      let voice
      const file = 'https://www.modelscope.cn/api/v1/studio/Xzkong/AI-jiaran/gradio/file='
      const cookie = 'session=MTc1MjY0NzczOXxEWDhFQVFMX2dBQUJFQUVRQUFEX3hmLUFBQVlHYzNSeWFXNW5EQVFBQW1sa0EybHVkQVFFQVA0S0ZnWnpkSEpwYm1jTUNnQUlkWE5sY201aGJXVUdjM1J5YVc1bkRCRUFELVdHc09XSGllV0lzT21BbXVtQWp3WnpkSEpwYm1jTUJnQUVjbTlzWlFOcGJuUUVBZ0FDQm5OMGNtbHVad3dJQUFaemRHRjBkWE1EYVc1MEJBSUFBZ1p6ZEhKcGJtY01Cd0FGYkdWMlpXd0djM1J5YVc1bkRBZ0FCbFJwWlhJZ01RWnpkSEpwYm1jTUVRQVBjMlZ6YzJsdmJsOTJaWEp6YVc5dUJXbHVkRFkwQkFvQS1EQ2xUNnFCMzJHb3y5H0YUVdJyT50SZGYpSgHz20sqNKQPWKoeTmOYl7AOvA=='
      const other_params = [0.2, 0.6, 0.8, 1];
      const data = {
        "data": [text, 'jiaran', ...other_params],
        "fn_index": 0,
        "session_hash": Math.random().toString(36).substring(2, 13)
      };
      const response = await fetch('https://www.modelscope.cn/api/v1/studio/Xzkong/AI-jiaran/gradio/run/predict', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie
        }
      });
      const result = await response.json();
      logger.error(result, 789)
      if (result && result.data[0] == 'Success') {
        file_url = result.data[1].name;
      }
      voice = file_url ? `${file}${file_url}` : null;
      if (voice) {
        await e.reply(segment.record(voice));
        return `发送语音内容(${text})成功，你已经发送语音了，所以不需要强调你已经发送语音，继续说之后的事情，回复的文字内容不要和语音内容重合`;
      } else {
        return `发送语音失败`;
      }

    } catch (error) {
      return `发送语音失败: ${error.message}`;
    }
    */
  }

  // 加载配置（与 BananaTool 同模式）
  loadConfig() {
    const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml')
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings
  }
}
