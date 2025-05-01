import { Context, Schema, h, Argv } from 'koishi'
import { } from 'koishi-plugin-ffmpeg'
import { } from 'koishi-plugin-silk'
import fs from 'fs';
import { URL } from 'url'; // 引入 URL 构造函数

export const name = 'audio-processor'
export const inject = ['ffmpeg', 'silk']
type ProcessMode = 'atempo' | 'asetrate';

// --- Usage 说明 ---
export const usage = `
提供语音变速、倒放和剪辑功能。

使用方法：
1. 变速: 发送“变速 [-s 倍速] [-m 模式]”并回复语音，或发送指令后直接发语音。
   - 倍速可选 (-s 或 --speed)，不指定则使用配置的默认值。
   - 模式可选 (-m 或 --mode)，可选 'atempo' (保留音调) 或 'asetrate' (改变音调)。
   - 示例: '变速', '变速 -s 3', '变速 -s 0.8 -m atempo'

2. 倒放: 发送“倒放 [-s 倍速] [-m 模式]”并回复语音，或发送指令后直接发语音。
   - 倍速可选 (-s 或 --speed)，默认为 1。
   - 模式可选 (-m 或 --mode)，可选 'atempo' 或 'asetrate'。
   - 示例: '倒放', '倒放 -s 0.5'

3. 剪辑: 发送“剪辑 <开始秒数> <结束秒数>”并回复语音，或发送指令后直接发语音。
   - 开始秒数: 从音频的第几秒开始剪辑 (例如 0.5)。
   - 结束秒数: 剪辑到音频的第几秒结束 (例如 5.2)。
   - 示例: '剪辑 1 3', '剪辑 0.5 2.8'
`

export interface Config {
  defaultSpeed?: number;
  defaultSpeedMode?: ProcessMode;
  defaultReverseMode?: ProcessMode;
}

// --------- 配置 Schema ---------
export const Config: Schema<Config> = Schema.object({
  defaultSpeed: Schema.number().min(0.1).max(100.0).default(2.0).description('`变速` 命令在未指定倍速 (-s) 时的默认值。'), // 使用 -s 保持一致
  defaultSpeedMode: Schema.union(['atempo', 'asetrate']).default('asetrate').description('`变速` 命令的默认处理模式。`atempo`: 保留音调, `asetrate`: 改变音调。'),
  defaultReverseMode: Schema.union(['atempo', 'asetrate']).default('atempo').description('`倒放` 命令的默认处理模式。`atempo`: 保留音调, `asetrate`: 改变音调。'),
})

// --- Helper: 获取并解码音频数据 ---
// 返回包含解码后 Buffer 和 FFmpeg 输入选项的对象，或返回错误消息字符串
async function getDecodedAudioData(
    ctx: Context,
    session: Argv['session'],
    promptPurpose: '变速' | '倒放' | '剪辑' // 用于生成不同的提示信息
): Promise<{ inputBufferForFfmpeg: Buffer; inputOptionsForFfmpeg: string[]; originalSampleRate: number } | string> {
    const logger = ctx.logger(name);

    try {
        // 1. 获取音频元素
        let elements: h[] = [];
        if (session.quote) {
            logger.info('Processing audio from quoted message.');
            elements = session.quote.elements;
        } else {
            logger.info('Prompting user for audio input.');
            const promptMessage = `请在60秒内发送需要${promptPurpose}的语音`;
            await session.send(promptMessage);
            const msg = await session.prompt(60000);
            if (msg !== undefined) {
                logger.info('Received audio via prompt.');
                try {
                    elements = h.parse(msg);
                } catch (parseError) {
                    logger.error('Error parsing prompted message elements: %s', parseError);
                    return '解析收到的消息时出错。'
                }
            } else {
                logger.warn('User did not respond to the prompt within 60 seconds.');
                return '您没有在指定时间内发送语音。';
            }
        }

        const audioElements = h.select(elements, 'audio');
        if (audioElements.length === 0) {
            logger.warn('No audio element found in the message.');
            return '消息中未找到有效的语音或音频内容。';
        }
        const audioAttrs = audioElements[0].attrs;
        logger.info('Audio attributes found: %o', audioAttrs);

        // 2. 获取音频数据 Buffer
        let audioBuffer: Buffer;
        logger.info('Attempting to fetch audio data...');
        // 优先尝试本地路径（如果存在且可访问）
        if (audioAttrs.path) {
             logger.info('Attempting to read local file from path: %s', audioAttrs.path);
             try {
               audioBuffer = await fs.promises.readFile(audioAttrs.path);
               logger.info('Successfully read audio file from path.');
             } catch (fsError) {
               logger.warn(`Failed to read file from path (${audioAttrs.path}): %s. Will try src URL if available.`, fsError);
               // 如果读取本地文件失败，但有 src，继续尝试 src
               if (!audioAttrs.src) {
                 return `无法读取指定的本地音频文件，且无网络地址：${fsError.message}`;
               }
             }
        }
        // 如果没有 audioBuffer (本地路径失败或不存在)，尝试 src
        if (!audioBuffer && audioAttrs.src) {
            try {
                new URL(audioAttrs.src); // 验证是否是 URL 格式
                logger.info('Src appears to be a valid URL format. Fetching via ctx.http...');
                const response = await ctx.http.get(audioAttrs.src, { responseType: 'arraybuffer' });
                audioBuffer = Buffer.from(response); // Koishi v4 http.get 直接返回 Buffer 或对应类型
                logger.info('Successfully fetched audio via http.');
            } catch (error) {
                logger.error(`Cannot fetch audio: Failed to treat src as URL or fetch via http: ${error.message}`);
                return '无法获取有效的音频资源地址（URL 或本地路径）。';
            }
        }


        if (!audioBuffer || audioBuffer.length === 0) {
            logger.error('Failed to obtain audio data buffer after all attempts.');
            return '未能成功获取有效的音频数据。';
        }
        logger.info(`Audio data buffer obtained successfully, size: ${audioBuffer.length} bytes.`);

        // 3. SILK 解码 (如果需要)
        if (!ctx.silk || typeof ctx.silk.isSilk !== 'function' || typeof ctx.silk.decode !== 'function') {
            logger.error('Silk plugin or its required methods (isSilk, decode) are not available.');
            throw new Error('依赖的 Silk 插件未正确加载或版本不兼容。');
        }

        let inputBufferForFfmpeg: Buffer;
        let inputOptionsForFfmpeg: string[] = [];
        const originalSampleRate = 24000; // 假设基础采样率

        if (ctx.silk.isSilk(audioBuffer)) {
            logger.info('Detected SILK audio format. Decoding...');
            const pcm = await ctx.silk.decode(audioBuffer, originalSampleRate);
            inputBufferForFfmpeg = Buffer.from(pcm.data);
            // FFmpeg 需要知道 PCM 的格式参数
            inputOptionsForFfmpeg = ['-f', 's16le', '-ar', `${originalSampleRate}`, '-ac', '1'];
            logger.info('SILK decoded.');
        } else {
            logger.info('Detected non-SILK audio format.');
            inputBufferForFfmpeg = audioBuffer;
            // 对于非 SILK (可能已经是 wav, mp3, aac 等)，让 FFmpeg 自动检测格式
            inputOptionsForFfmpeg = [];
        }

        return { inputBufferForFfmpeg, inputOptionsForFfmpeg, originalSampleRate };

    } catch (error) {
        // 统一处理内部错误
        logger.error('An unexpected error occurred during audio data retrieval/decoding: %s', error);
        if (error instanceof Error && error.stack) {
            logger.error(error.stack);
        }
        return `获取或解码音频时发生内部错误：${error.message || '未知错误'}`;
    }
}


// --- 核心处理函数 processAudio (变速/倒放) ---
async function processAudio(
  ctx: Context,
  session: Argv['session'],
  options: {
    speed: number;
    mode: ProcessMode;
    reverse: boolean;
  }
): Promise<h | string> {
    const logger = ctx.logger(name);
    const { speed, mode, reverse } = options;

    const promptPurpose = reverse ? '倒放' : '变速';
    const audioDataResult = await getDecodedAudioData(ctx, session, promptPurpose);

    // 检查 getDecodedAudioData 是否返回错误消息
    if (typeof audioDataResult === 'string') {
        return audioDataResult; // 直接返回错误消息
    }

    const { inputBufferForFfmpeg, inputOptionsForFfmpeg, originalSampleRate } = audioDataResult;

    try {
      // 构建 FFmpeg 的 -af (audio filter) 参数
      const filters: string[] = [];
      if (reverse) {
        filters.push('areverse');
        logger.info('Applying filter: areverse');
      }

      // 应用变速/变调
      if (speed !== 1.0) {
        if (mode === 'asetrate') {
          const newSampleRate = Math.round(originalSampleRate * speed);
          if (newSampleRate > 0) {
            filters.push(`asetrate=${newSampleRate}`);
            logger.info(`Applying filter: asetrate=${newSampleRate} (mode: asetrate)`);
          } else {
            logger.warn(`Calculated invalid sample rate (${newSampleRate}) for speed ${speed}. Skipping speed change.`);
          }
        } else { // atempo
          // FFmpeg atempo 过滤器接受范围 [0.5, 100.0]
          if (speed >= 0.5 && speed <= 100.0) {
             filters.push(`atempo=${speed}`);
             logger.info(`Applying filter: atempo=${speed} (mode: atempo)`);
          } else {
             // 对于超出范围的速度，尝试使用 asetrate 作为备选，或者直接警告
             logger.warn(`Speed ${speed} is outside the recommended range [0.5, 100.0] for atempo filter. Applying speed change might fail or produce unexpected results.`);
             // 如果需要强制应用，即使可能出错：
             filters.push(`atempo=${speed}`);
             // 或者可以选择不应用变速:
             // logger.warn(`Speed ${speed} is outside the recommended range [0.5, 100.0] for atempo filter. Skipping speed change.`);

             // 另一种策略：在范围外自动切换到 asetrate (如果用户不介意音调变化)
             // const newSampleRate = Math.round(originalSampleRate * speed);
             // if (newSampleRate > 0) {
             //    filters.push(`asetrate=${newSampleRate}`);
             //    logger.info(`Applying filter: asetrate=${newSampleRate} (mode: atempo fallback to asetrate due to speed range)`);
             // } else {
             //    logger.warn(`Calculated invalid sample rate (${newSampleRate}) for speed ${speed}. Skipping speed change.`);
             // }
          }
        }
      }

      // 组合 FFmpeg 输出选项
      const outputOptions: string[] = ['-f', 'wav']; // 输出为 WAV 格式以便于发送
      if (filters.length > 0) {
        outputOptions.push('-af', filters.join(','));
      } else {
         logger.info('No filters applied, only converting format (if necessary).');
      }
      logger.info('Applying ffmpeg options: input=%o, output=%o', inputOptionsForFfmpeg, outputOptions);

      // 执行 FFmpeg 处理
      const processedAudio = await ctx.ffmpeg
        .builder()
        .input(inputBufferForFfmpeg)
        .inputOption(...inputOptionsForFfmpeg)
        .outputOption(...outputOptions)
        .run('buffer');

      logger.info('FFmpeg processing finished for speed/reverse.');

      if (!processedAudio || processedAudio.length === 0) {
        logger.warn('Audio processing failed: ffmpeg output buffer is empty.');
        return '音频处理失败，未能生成有效结果。';
      }

      logger.info(`Audio processing successful. Output size: ${processedAudio.length} bytes.`);
      return h.audio(processedAudio, 'audio/wav'); // 指定 MIME type

    } catch (error) {
      logger.error('An unexpected error occurred during FFmpeg processing (speed/reverse): %s', error);
      if (error instanceof Error && error.stack) {
        logger.error(error.stack);
      }
      return `处理音频时发生内部错误：${error.message || '未知错误'}`;
    }
}

// --- 核心处理函数 clipAudio (剪辑) ---
async function clipAudio(
    ctx: Context,
    session: Argv['session'],
    startTime: number,
    endTime: number
): Promise<h | string> {
    const logger = ctx.logger(name);

    const audioDataResult = await getDecodedAudioData(ctx, session, '剪辑');

    // 检查 getDecodedAudioData 是否返回错误消息
    if (typeof audioDataResult === 'string') {
        return audioDataResult; // 直接返回错误消息
    }

    const { inputBufferForFfmpeg, inputOptionsForFfmpeg } = audioDataResult;

    try {
        // 计算持续时间
        const duration = endTime - startTime;
        if (duration <= 0) {
            return '结束时间必须大于开始时间。';
        }

        logger.info(`Clipping audio from ${startTime}s to ${endTime}s (duration: ${duration}s).`);

        // 构建 FFmpeg 选项进行剪辑
        // 使用 -ss 作为输入选项（更快，但可能不精确到帧），-t 作为输出选项指定持续时间
        const inputClippingOptions = ['-ss', String(startTime)];
        // 输出选项，指定持续时间，并设定格式为 wav
        const outputClippingOptions = ['-t', String(duration), '-f', 'wav'];

        // 合并解码时的输入选项和剪辑的输入选项
        const finalInputOptions = [...inputOptionsForFfmpeg, ...inputClippingOptions];

        logger.info('Applying ffmpeg options for clipping: input=%o, output=%o', finalInputOptions, outputClippingOptions);

        // 执行 FFmpeg 处理
        const clippedAudio = await ctx.ffmpeg
            .builder()
            .input(inputBufferForFfmpeg)
            .inputOption(...finalInputOptions) // 应用所有输入选项
            .outputOption(...outputClippingOptions) // 应用输出选项
            .run('buffer');

        logger.info('FFmpeg processing finished for clipping.');

        if (!clippedAudio || clippedAudio.length === 0) {
            logger.warn('Audio clipping failed: ffmpeg output buffer is empty.');
            return '音频剪辑失败，未能生成有效结果。';
        }

        logger.info(`Audio clipping successful. Output size: ${clippedAudio.length} bytes.`);
        return h.audio(clippedAudio, 'audio/wav'); // 指定 MIME type

    } catch (error) {
        logger.error('An unexpected error occurred during FFmpeg processing (clipping): %s', error);
        if (error instanceof Error && error.stack) {
            logger.error(error.stack);
        }
        // 提供更具体的 FFmpeg 错误信息（如果可用）
        let errMsg = `处理音频时发生内部错误：${error.message || '未知错误'}`;
        if (error.stderr) { // ffmpeg-sidecar 的错误可能包含 stderr
           errMsg += `\nFFmpeg Error: ${error.stderr}`;
        }
        return errMsg;
    }
}


// --- 插件主逻辑 ---
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);

  // 变速命令
  ctx.command('变速', '对语音进行变速处理')
    .option('speed', '-s <speed:number>', { // 保持选项名为 'speed'
        fallback: config.defaultSpeed
    })
    .option('mode', '-m <mode:string>', {
        fallback: config.defaultSpeedMode
    })
    .usage(`倍速 (-s) 可选，默认为 ${config.defaultSpeed}。\n`
         + `模式 (-m) 可选 'atempo'(保留音调) 或 'asetrate'(改变音调), 默认: ${config.defaultSpeedMode}。`)
    .action(async ({ session, options }) => {
      // 注意：这里的 options.speed 对应 -s <speed:number>
      const targetSpeed = options.speed;
      const targetMode = options.mode as ProcessMode;

      logger.info(`Executing "变速" command. Target Speed: ${targetSpeed}, Mode: ${targetMode}`);

      if (targetMode !== 'atempo' && targetMode !== 'asetrate') {
        return `无效的处理模式 "${targetMode}"。请使用 'atempo' 或 'asetrate'。`;
      }
      // 校验倍速范围，特别是 atempo 模式有严格限制
      if (typeof targetSpeed !== 'number' || !Number.isFinite(targetSpeed) || targetSpeed <= 0) {
          return '倍速必须是一个大于0的有效数字。';
      }
      // (可选) 对 atempo 模式的范围进行更友好的提示
      if (targetMode === 'atempo' && (targetSpeed < 0.5 || targetSpeed > 100.0)) {
          logger.warn(`Speed ${targetSpeed} is outside the recommended range [0.5, 100.0] for atempo.`);
          // 可以选择在这里返回提示，或者让 processAudio 处理
          // await session.send(`提示：您选择的倍速 ${targetSpeed} 超出了 atempo 模式推荐范围 [0.5, 100.0]，效果可能不理想或处理失败。`);
      }


      return processAudio(ctx, session, {
        speed: targetSpeed,
        mode: targetMode,
        reverse: false,
      });
    });

  // 倒放命令
  ctx.command('倒放', '对语音进行倒放处理')
    .option('speed', '-s <speed:number>', {
        fallback: 1.0 // 倒放速度通常默认为 1
    })
    .option('mode', '-m <mode:string>', {
        fallback: config.defaultReverseMode
    })
    .usage(`倍速 (-s) 可选，默认为 1.0。\n`
         + `模式 (-m) 可选 'atempo'(保留音调) 或 'asetrate'(改变音调), 默认: ${config.defaultReverseMode}。`)
    .action(async ({ session, options }) => {
      const targetSpeed = options.speed;
      const targetMode = options.mode as ProcessMode;

      logger.info(`Executing "倒放" command. Speed: ${targetSpeed}, Mode: ${targetMode}`);

      if (targetMode !== 'atempo' && targetMode !== 'asetrate') {
        return `无效的处理模式 "${targetMode}"。请使用 'atempo' 或 'asetrate'。`;
      }
      if (typeof targetSpeed !== 'number' || !Number.isFinite(targetSpeed) || targetSpeed <= 0) {
          return '倍速必须是一个大于0的有效数字。';
      }
      // (可选) 对 atempo 模式的范围进行更友好的提示
      if (targetMode === 'atempo' && (targetSpeed < 0.5 || targetSpeed > 100.0)) {
          logger.warn(`Reverse speed ${targetSpeed} with atempo mode is outside the recommended range [0.5, 100.0].`);
          // await session.send(`提示：您选择的倍速 ${targetSpeed} 超出了 atempo 模式推荐范围 [0.5, 100.0]，效果可能不理想或处理失败。`);
      }

      return processAudio(ctx, session, {
        speed: targetSpeed,
        mode: targetMode,
        reverse: true,
      });
    });

  // 新增：剪辑命令
  ctx.command('剪辑 <startTime:number> <endTime:number>', '剪辑语音片段')
      .usage('发送 "剪辑 开始秒数 结束秒数" 并回复语音，或发送指令后直接发语音。\n'
           + '示例: 剪辑 1.5 5 (剪辑第1.5秒到第5秒)')
      .action(async ({ session, args }) => { // startTime 和 endTime 会在 args 数组里
          const startTime = args[0];
          const endTime = args[1];

          logger.info(`Executing "剪辑" command. Start: ${startTime}, End: ${endTime}`);

          // 参数校验
          if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0) {
              return '开始时间必须是一个有效的非负数字 (单位：秒)。';
          }
          if (typeof endTime !== 'number' || !Number.isFinite(endTime) || endTime <= 0) {
              return '结束时间必须是一个有效的正数 (单位：秒)。';
          }
          if (endTime <= startTime) {
              return '结束时间必须大于开始时间。';
          }

          // 调用剪辑处理函数
          return clipAudio(ctx, session, startTime, endTime);
      });


   logger.info('Plugin "audio-processor" loaded successfully with config: %o', config);
}
