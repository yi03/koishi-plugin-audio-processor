import { Context, Schema, h, Argv, Session } from 'koishi' // 引入 Session
import { } from 'koishi-plugin-ffmpeg'
import { } from 'koishi-plugin-silk'
import fs from 'fs';
import { URL } from 'url';

export const name = 'audio-processor'
export const inject = ['ffmpeg', 'silk']
type ProcessMode = 'atempo' | 'asetrate';

// --- 无全局 usage ---

export interface Config {
  defaultSpeed?: number;
  defaultSpeedMode?: ProcessMode;
  defaultReverseMode?: ProcessMode;
  mergeTimeout?: number;
}

// --------- 配置 Schema ---------
export const Config: Schema<Config> = Schema.object({
  defaultSpeed: Schema.number().min(0.1).max(100.0).default(2.0).description('`变速` 命令在未指定倍速 (-s) 时的默认值。'),
  defaultSpeedMode: Schema.union(['atempo', 'asetrate']).default('asetrate').description('`变速` 命令的默认处理模式。`atempo`: 保留音调, `asetrate`: 改变音调。'),
  defaultReverseMode: Schema.union(['atempo', 'asetrate']).default('atempo').description('`倒放` 命令的默认处理模式。`atempo`: 保留音调, `asetrate`: 改变音调。'),
  mergeTimeout: Schema.number().min(30).default(60).description('合并语音操作第二步的等待超时时间（秒）。'),
})

// --- Helper: extractAndDecodeAudio ---
interface DecodedAudioData {
    inputBufferForFfmpeg: Buffer;
    inputOptionsForFfmpeg: string[];
    originalSampleRate: number;
}
async function extractAndDecodeAudio(
    ctx: Context,
    elements: h[],
    sourceDescription: string
): Promise<DecodedAudioData | string> {
    const logger = ctx.logger(name);
    try {
        const audioElements = h.select(elements, 'audio');
        if (audioElements.length === 0) {
            logger.warn(`No audio element found in ${sourceDescription}.`);
            return `在 ${sourceDescription} 中未找到有效的语音或音频内容。`;
        }
        const audioAttrs = audioElements[0].attrs;
        let audioBuffer: Buffer;
        if (audioAttrs.path) {
             try {
               audioBuffer = await fs.promises.readFile(audioAttrs.path);
             } catch (fsError) {
               logger.warn(`Failed to read file (${audioAttrs.path}): %s. Trying src...`, fsError);
               if (!audioAttrs.src) {
                 return `无法读取本地文件 (${sourceDescription})，且无网络地址：${fsError.message}`;
               }
             }
        }
        if (!audioBuffer && audioAttrs.src) {
            try {
                new URL(audioAttrs.src);
                const response = await ctx.http.get(audioAttrs.src, { responseType: 'arraybuffer' });
                audioBuffer = Buffer.from(response);
            } catch (error) {
                logger.error(`Cannot fetch audio for ${sourceDescription}: ${error.message}`);
                return `无法获取 ${sourceDescription} 的有效音频资源。`;
            }
        }
        if (!audioBuffer || audioBuffer.length === 0) {
            logger.error(`Failed to obtain audio data buffer for ${sourceDescription}.`);
            return `未能获取 ${sourceDescription} 的有效音频数据。`;
        }
        if (!ctx.silk?.isSilk || !ctx.silk?.decode) {
            logger.error('Silk plugin not available.');
            throw new Error('依赖的 Silk 插件未正确加载。');
        }
        let inputBufferForFfmpeg: Buffer;
        let inputOptionsForFfmpeg: string[] = [];
        const assumedSampleRate = 24000;
        if (ctx.silk.isSilk(audioBuffer)) {
            const pcm = await ctx.silk.decode(audioBuffer, assumedSampleRate);
            inputBufferForFfmpeg = Buffer.from(pcm.data);
            inputOptionsForFfmpeg = ['-f', 's16le', '-ar', String(assumedSampleRate), '-ac', '1'];
        } else {
            inputBufferForFfmpeg = audioBuffer;
            inputOptionsForFfmpeg = [];
        }
        return { inputBufferForFfmpeg, inputOptionsForFfmpeg, originalSampleRate: assumedSampleRate };
    } catch (error) {
        logger.error(`Error extracting/decoding audio from ${sourceDescription}: %s`, error);
        if (error instanceof Error && error.stack) logger.error(error.stack);
        return `处理 ${sourceDescription} 的音频时出错：${error.message || '未知错误'}`;
    }
}


// --- 核心处理函数 runFfmpegProcess ---
async function runFfmpegProcess(
    ctx: Context,
    audioData: DecodedAudioData,
    outputOptions: string[]
): Promise<Buffer | string> {
     const logger = ctx.logger(name);
    try {
        const processedAudio = await ctx.ffmpeg
            .builder()
            .input(audioData.inputBufferForFfmpeg)
            .inputOption(...audioData.inputOptionsForFfmpeg)
            .outputOption(...outputOptions)
            .run('buffer');
        if (!processedAudio || processedAudio.length === 0) {
            logger.warn('FFmpeg processing resulted in empty buffer.');
            return '音频处理失败，未能生成有效结果。';
        }
        return processedAudio;
    } catch (error) {
        logger.error('An unexpected error occurred during FFmpeg processing: %s', error);
        if (error instanceof Error && error.stack) logger.error(error.stack);
        let errMsg = `处理音频时发生内部错误：${error.message || '未知错误'}`;
        if (error.stderr) errMsg += `\nFFmpeg Error: ${error.stderr}`;
        return errMsg;
    }
}

// --- 核心处理函数 mergeAudio ---
async function mergeAudio(
  ctx: Context,
  audioData1: DecodedAudioData,
  audioData2: DecodedAudioData
): Promise<h | string> {
  const logger = ctx.logger(name);

  try {
      // --- 方法 2: 在 Node.js 中合并 Buffer ---
      if (audioData1.inputOptionsForFfmpeg.join(' ') !== audioData2.inputOptionsForFfmpeg.join(' ')) {
           logger.warn(`Input audio formats might differ, concatenation might fail or produce unexpected results. Input 1: ${audioData1.inputOptionsForFfmpeg}, Input 2: ${audioData2.inputOptionsForFfmpeg}`);
      }
      const combinedPcmBuffer = Buffer.concat([
          audioData1.inputBufferForFfmpeg,
          audioData2.inputBufferForFfmpeg
      ]);
      const inputOptions = audioData1.inputOptionsForFfmpeg;
      const outputOptions = ['-f', 'wav'];
      const mergedAudio = await ctx.ffmpeg.builder()
          .input(combinedPcmBuffer)
          .inputOption(...inputOptions)
          .outputOption(...outputOptions)
          .run('buffer');
      if (!mergedAudio || mergedAudio.length === 0) {
          logger.warn('Audio merging failed (Buffer.concat method): ffmpeg output buffer is empty.');
          return '音频合并失败，未能生成有效结果 (方法 2)。';
      }
      return h.audio(mergedAudio, 'audio/wav');
  } catch (error) {
      logger.error('An unexpected error occurred during FFmpeg processing (Buffer.concat method): %s', error);
      if (error instanceof Error && error.stack) {
          logger.error(error.stack);
      }
      let errMsg = `合并音频时发生内部错误 (方法 2)：${error.message || '未知错误'}`;
      if (error.stderr) {
         errMsg += `\nFFmpeg Error: ${error.stderr}`;
      }
      return errMsg;
  }
}

// --- 插件主逻辑 ---
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);

  // ================== 合并状态管理 ==================
  interface PendingMergeState {
      audioData1: DecodedAudioData;
      timeoutId: NodeJS.Timeout;
  }
  const pendingMerges = new Map<string, PendingMergeState>();
  const MERGE_TIMEOUT_MS = config.mergeTimeout * 1000;

  function clearPendingMerge(userId: string) {
      const state = pendingMerges.get(userId);
      if (state) {
          clearTimeout(state.timeoutId);
          pendingMerges.delete(userId);
          return true;
      }
      return false;
  }
  // ==================================================

  // --- 主命令 ---
  ctx.command('语音处理', '语音处理 (变速/倒放/剪辑/合并)')
    .alias('audio-processor')
    .action(async ({ session }) => {
        await session.execute(`help ${name}`);
    });

  // --- 变速命令 ---
  ctx.command('变速', '对语音进行变速处理')
    .usage(
`功能: 语音变速。
用法: 回复语音发送“变速 [选项]”，或直接发送指令后按提示发语音。

选项:
-s <倍速>: 播放速度 (默认: ${config.defaultSpeed})
-m <模式>: atempo(保调) / asetrate(变调) (默认: ${config.defaultSpeedMode})

示例:
变速
变速 -s 1.5
变速 -s 0.8 -m atempo
`
    )
    .option('speed', '-s <speed:number>', { fallback: config.defaultSpeed })
    .option('mode', '-m <mode:string>', { fallback: config.defaultSpeedMode })
    .action(async ({ session, options }) => {
        const targetSpeed = options.speed;
        const targetMode = options.mode as ProcessMode;
        if (targetMode !== 'atempo' && targetMode !== 'asetrate') return `无效模式 "${targetMode}"，请用 'atempo' 或 'asetrate'。`;
        if (typeof targetSpeed !== 'number' || !Number.isFinite(targetSpeed) || targetSpeed <= 0) return '倍速 (-s) 必须是正数。';
        if (targetMode === 'atempo' && (targetSpeed < 0.5 || targetSpeed > 100.0)) {
            await session.send(`提示: 倍速 ${targetSpeed} 超出 atempo 模式推荐范围 [0.5, 100.0]，效果可能不理想。`);
        }
        let elements: h[];
        let sourceDesc: string;
        if (session.quote) {
            elements = session.quote.elements;
            sourceDesc = '引用的消息';
        } else {
            await session.send('请在60秒内发送需要变速的语音');
            const msg = await session.prompt(60000);
            if (!msg) return '操作超时。';
            try {
                elements = h.parse(msg);
                sourceDesc = '后续发送的消息';
            } catch (e) { return '无法解析收到的消息。'; }
        }
        const audioDataResult = await extractAndDecodeAudio(ctx, elements, sourceDesc);
        if (typeof audioDataResult === 'string') return audioDataResult;
        const filters: string[] = [];
        if (targetSpeed !== 1.0) {
            if (targetMode === 'asetrate') {
                const newRate = Math.round(audioDataResult.originalSampleRate * targetSpeed);
                if (newRate > 0) filters.push(`asetrate=${newRate}`);
                else logger.warn('Invalid target sample rate calculated.');
            } else { filters.push(`atempo=${targetSpeed}`); }
        }
        const outputOptions = ['-f', 'wav'];
        if (filters.length > 0) outputOptions.push('-af', filters.join(','));
        const processedResult = await runFfmpegProcess(ctx, audioDataResult, outputOptions);
        return typeof processedResult === 'string' ? processedResult : h.audio(processedResult, 'audio/wav');
    });

  // --- 倒放命令 ---
  ctx.command('倒放', '对语音进行倒放处理')
    .usage(
`功能: 语音倒放，可变速。
用法: 回复语音发送“倒放 [选项]”，或直接发送指令后按提示发语音。

选项:
-s <倍速>: 倒放速度 (默认: 1.0)
-m <模式>: atempo(保调) / asetrate(变调) (默认: ${config.defaultReverseMode})

示例:
倒放
倒放 -s 2
倒放 -s 1.5 -m atempo
`
    )
    .option('speed', '-s <speed:number>', { fallback: 1.0 })
    .option('mode', '-m <mode:string>', { fallback: config.defaultReverseMode })
    .action(async ({ session, options }) => {
        const targetSpeed = options.speed;
        const targetMode = options.mode as ProcessMode;
        if (targetMode !== 'atempo' && targetMode !== 'asetrate') return `无效模式 "${targetMode}"，请用 'atempo' 或 'asetrate'。`;
        if (typeof targetSpeed !== 'number' || !Number.isFinite(targetSpeed) || targetSpeed <= 0) return '倍速 (-s) 必须是正数。';
        if (targetMode === 'atempo' && (targetSpeed < 0.5 || targetSpeed > 100.0)) {
             await session.send(`提示: 倍速 ${targetSpeed} 超出 atempo 模式推荐范围 [0.5, 100.0]，效果可能不理想。`);
        }
        let elements: h[];
        let sourceDesc: string;
        if (session.quote) {
            elements = session.quote.elements;
            sourceDesc = '引用的消息';
        } else {
            await session.send('请在60秒内发送需要倒放的语音');
            const msg = await session.prompt(60000);
            if (!msg) return '操作超时。';
            try {
                elements = h.parse(msg);
                sourceDesc = '后续发送的消息';
            } catch (e) { return '无法解析收到的消息。'; }
        }
        const audioDataResult = await extractAndDecodeAudio(ctx, elements, sourceDesc);
        if (typeof audioDataResult === 'string') return audioDataResult;
        const filters: string[] = ['areverse'];
        if (targetSpeed !== 1.0) {
            if (targetMode === 'asetrate') {
                const newRate = Math.round(audioDataResult.originalSampleRate * targetSpeed);
                if (newRate > 0) filters.push(`asetrate=${newRate}`);
                else logger.warn('Invalid target sample rate calculated for reverse speed.');
            } else { filters.push(`atempo=${targetSpeed}`); }
        }
        const outputOptions = ['-f', 'wav', '-af', filters.join(',')];
        const processedResult = await runFfmpegProcess(ctx, audioDataResult, outputOptions);
        return typeof processedResult === 'string' ? processedResult : h.audio(processedResult, 'audio/wav');
    });

  // --- 剪辑命令 ---
  ctx.command('剪辑 <startTime:number> <endTime:number>', '剪辑语音片段')
      .usage(
`功能: 剪辑语音片段。
用法: 回复语音发送“剪辑 开始秒 结束秒”，或直接发送指令后按提示发语音。

参数:
开始秒: 起始时间 (如 0, 1.5)
结束秒: 结束时间 (需大于开始秒)

示例:
剪辑 0 5
剪辑 1.5 3.2
`
      )
      .action(async ({ session, args }) => {
          const startTime = args[0];
          const endTime = args[1];
          if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0) return '开始时间 <startTime> 必须是非负数字。';
          if (typeof endTime !== 'number' || !Number.isFinite(endTime) || endTime <= 0) return '结束时间 <endTime> 必须是正数。';
          if (endTime <= startTime) return '结束时间 <endTime> 必须大于开始时间 <startTime>。';
          let elements: h[];
          let sourceDesc: string;
          if (session.quote) {
              elements = session.quote.elements;
              sourceDesc = '引用的消息';
          } else {
              await session.send('请在60秒内发送需要剪辑的语音');
              const msg = await session.prompt(60000);
              if (!msg) return '操作超时。';
              try {
                  elements = h.parse(msg);
                  sourceDesc = '后续发送的消息';
              } catch (e) { return '无法解析收到的消息。'; }
          }
          const audioDataResult = await extractAndDecodeAudio(ctx, elements, sourceDesc);
          if (typeof audioDataResult === 'string') return audioDataResult;
          const duration = endTime - startTime;
          const outputOptions = ['-ss', String(startTime), '-t', String(duration), '-f', 'wav'];
          const processedResult = await runFfmpegProcess(ctx, audioDataResult, outputOptions);
          return typeof processedResult === 'string' ? processedResult : h.audio(processedResult, 'audio/wav');
      });

  // --- 合并语音 - 第一步 ---
  ctx.command('合并语音', '开始合并语音流程 (第一步)')
      .usage(
`功能: 开始合并语音 (第一步)。
用法: 回复【第一条】要合并的语音，发送“合并语音”。

说明:
机器人会记录该语音，并提示进行第二步。
需要在 ${config.mergeTimeout} 秒内完成第二步。
`
      )
      .action(async ({ session }) => {
          const userId = session.userId;
          if (!session.quote) {
              return '请回复【第一条】要合并的语音，然后发送“合并语音”。';
          }
          const firstAudioResult = await extractAndDecodeAudio(ctx, session.quote.elements, '第一条回复的语音');
          if (typeof firstAudioResult === 'string') {
              return `处理第一条语音出错：${firstAudioResult}`;
          }
          clearPendingMerge(userId);
          const timeoutId = setTimeout(() => {
              if (pendingMerges.has(userId)) {
                  pendingMerges.delete(userId);
                  logger.warn(`Merge operation timed out for user ${userId}. State cleared.`);
                  session.send('合并语音操作已超时，请重新开始。').catch(e => logger.warn('Failed to send timeout message:', e));
              }
          }, MERGE_TIMEOUT_MS);
          pendingMerges.set(userId, { audioData1: firstAudioResult, timeoutId });
          return `已记录第一条语音。\n请在 ${config.mergeTimeout} 秒内回复【第二条】语音，并发送“确认合并”。`;
      });

  // --- 合并语音 - 第二步 ---
  ctx.command('确认合并', '完成合并语音流程 (第二步)')
      .usage(
`功能: 完成语音合并 (第二步)。
用法: 回复【第二条】要合并的语音，发送“确认合并”。

说明:
必须在“合并语音”后 ${config.mergeTimeout} 秒内完成。
如果回复错误，可重试回复正确的语音。
`
      )
      .action(async ({ session }) => {
          const userId = session.userId;
          const pendingState = pendingMerges.get(userId);
          if (!pendingState) {
              return '没有待处理的合并请求。请先回复第一条语音并发送“合并语音”。';
          }
          if (!session.quote) {
              return '请回复【第二条】要合并的语音，然后发送此指令。';
          }
          const secondAudioResult = await extractAndDecodeAudio(ctx, session.quote.elements, '第二条回复的语音');
          if (typeof secondAudioResult === 'string') {
              return `处理第二条语音出错：${secondAudioResult}\n请确保回复的是有效语音，然后重试“确认合并”。`;
          }
          clearPendingMerge(userId);
          const mergeResult = await mergeAudio(ctx, pendingState.audioData1, secondAudioResult);
          return mergeResult;
      });
}
