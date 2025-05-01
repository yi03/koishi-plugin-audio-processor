# Koishi Plugin - Audio Processor (语音处理)

提供简单的语音处理功能，包括变速、倒放、剪辑和合并。

[![Koishi Plugin](https://img.shields.io/npm/v/koishi-plugin-audio-processor?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-audio-processor)
[![Koishi Plugin](https://img.shields.io/npm/dm/koishi-plugin-audio-processor?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-audio-processor)

本插件在 [audio-reverse](https://github.com/windbullet/koishi-plugin-audio-reverse) 和 [audio-speed-changer](https://github.com/windbullet/koishi-plugin-audio-speed-changer) 插件的基础上改的。

## ✨ 功能

*   **变速**: 调整语音速度，可选保调/变调。
*   **倒放**: 倒播语音，可变速。
*   **剪辑**: 截取语音片段。
*   **合并**: 合并两条语音。

## 🚀 使用方法

使用 `help 语音处理` 可查看所有子命令。

**通用操作方式:**

1.  **回复**: 对着**语音/音频**消息发送指令。
2.  **直接发送**: (变速/倒放/剪辑) 直接发指令，按提示发送语音。

---

### 1. 变速

*   **指令**: `变速 [-s 倍速] [-m 模式]`
    *   `-s`: 速度 (默认 2.0)。
    *   `-m`: `atempo`(保调) / `asetrate`(变调) (默认 asetrate)。
*   **示例**:
    *   (回复语音) `变速`
    *   (回复语音) `变速 -s 1.5 -m atempo`

---

### 2. 倒放

*   **指令**: `倒放 [-s 倍速] [-m 模式]`
    *   `-s`: 倒放速度 (默认 1.0)。
    *   `-m`: `atempo`(保调) / `asetrate`(变调) (默认 atempo)。
*   **示例**:
    *   (回复语音) `倒放`
    *   (回复语音) `倒放 -s 2`

---

### 3. 剪辑

*   **指令**: `剪辑 <开始秒> <结束秒>`
*   **示例**:
    *   (回复语音) `剪辑 0 5` (剪辑前 5 秒)
    *   (回复语音) `剪辑 1.5 4` (剪辑 1.5 秒至 4 秒)

---

### 4. 合并语音 (两步)

1.  回复**第一条**语音，发送 `合并语音`。
2.  在提示后 (默认 60 秒内)，回复**第二条**语音，发送 `确认合并`。
