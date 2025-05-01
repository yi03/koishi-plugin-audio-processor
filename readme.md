# koishi-plugin-audio-processor

提供简单易用的语音处理功能，包括变速、倒放和剪辑。

[![Koishi Plugin](https://img.shields.io/npm/v/koishi-plugin-audio-processor?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-audio-processor)
[![Koishi Plugin](https://img.shields.io/npm/dm/koishi-plugin-audio-processor?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-audio-processor)

本插件在 [audio-reverse](https://github.com/windbullet/koishi-plugin-audio-reverse) 和 [audio-speed-changer](https://github.com/windbullet/koishi-plugin-audio-speed-changer) 插件的基础上改的。

**依赖:**

*   `koishi-plugin-ffmpeg`: 用于音频处理核心。
*   `koishi-plugin-silk`: 用于解码 QQ/微信等平台的 SILK 语音。

请确保已安装并启用了上述依赖插件。

## 功能

*   **语音变速**: 调整语音消息的播放速度，可选保留或改变原始音调。
*   **语音倒放**: 将语音消息反向播放，也可同时调整速度。
*   **语音剪辑**: 提取语音消息的指定时间段。

## 使用方法

本插件的所有命令都支持两种使用方式：

1.  **回复**: 对着一条包含语音/音频的消息，发送相应的指令。
2.  **等待发送**: 直接发送指令，机器人会提示你在 60 秒内发送需要处理的语音/音频消息。

---

### 1. 变速

调整语音的播放速度。

**指令格式:** `变速 [-s 倍速] [-m 模式]`

*   **`-s <倍速>`**: （可选）指定播放速度。
    *   `<倍速>` 是一个大于 0 的数字，例如 `2` (两倍速), `0.5` (半速)。
    *   如果不指定，将使用配置文件中的 `defaultSpeed` (默认为 `2.0`)。
*   **`-m <模式>`**: （可选）指定处理模式。
    *   `atempo`: **保留**原始音调进行变速 (推荐用于大多数情况，但速度范围建议在 0.5 到 100.0 之间)。
    *   `asetrate`: 变速的同时会**改变**音调 (速度越快声音越尖锐，速度越慢声音越低沉)。
    *   如果不指定，将使用配置文件中的 `defaultSpeedMode` (默认为 `asetrate`)。

**示例:**

*   `变速` (回复语音): 使用默认倍速 (2.0) 和默认模式 (asetrate) 处理语音。
*   `变速 -s 3` (回复语音): 以 3 倍速处理语音，使用默认模式。
*   `变速 -m atempo` (回复语音): 使用默认倍速，但保留原始音调。
*   `变速 -s 0.8 -m atempo` (回复语音): 以 0.8 倍速处理语音，并保留原始音调。
*   发送 `变速 -s 1.5`，然后按提示发送语音消息。

---

### 2. 倒放

将语音反向播放。

**指令格式:** `倒放 [-s 倍速] [-m 模式]`

*   **`-s <倍速>`**: （可选）指定倒放时的播放速度。
    *   `<倍速>` 是一个大于 0 的数字。
    *   如果不指定，默认为 `1.0` (即原速倒放)。
*   **`-m <模式>`**: （可选）指定处理模式，同 `变速` 命令。
    *   如果不指定，将使用配置文件中的 `defaultReverseMode` (默认为 `atempo`)。

**示例:**

*   `倒放` (回复语音): 以原速倒放语音，使用默认模式 (atempo)。
*   `倒放 -s 2` (回复语音): 以 2 倍速倒放语音，使用默认模式。
*   `倒放 -m asetrate` (回复语音): 以原速倒放语音，但使用 asetrate 模式 (音调会变化)。
*   发送 `倒放`，然后按提示发送语音消息。

---

### 3. 剪辑

提取语音的指定时间片段。

**指令格式:** `剪辑 <开始秒数> <结束秒数>`

*   **`<开始秒数>`**: (必需) 剪辑片段的起始时间点 (从 0 开始计算，可以是小数，例如 `1.5`)。
*   **`<结束秒数>`**: (必需) 剪辑片段的结束时间点 (必须大于开始秒数，可以是小数，例如 `5.2`)。

**示例:**

*   `剪辑 1 5` (回复语音): 提取语音从第 1 秒到第 5 秒的内容。
*   `剪辑 0.5 3.8` (回复语音): 提取语音从第 0.5 秒到第 3.8 秒的内容。
*   发送 `剪辑 2 4.5`，然后按提示发送语音消息。

## 配置项

可以在 Koishi 的插件配置中调整以下选项：

*   `defaultSpeed`: `变速` 命令未指定 `-s` 时的默认倍速 (默认: `2.0`)。
*   `defaultSpeedMode`: `变速` 命令未指定 `-m` 时的默认模式 (默认: `asetrate`)。
*   `defaultReverseMode`: `倒放` 命令未指定 `-m` 时的默认模式 (默认: `atempo`)。
