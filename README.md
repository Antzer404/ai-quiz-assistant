# AI 自动答题助手（自定义版 v2）

在原项目 [rehuan/AI-ANSWER-ASSISTANT](https://github.com/rehuan/AI-ANSWER-ASSISTANT) 基础上重构的浏览器扩展。

- **不包含任何内置模型/中转服务**，只使用你自己配置的 OpenAI 兼容 API
- **不发送统计上报**，API Key 只保存在本机 `chrome.storage.local`
- 支持**自动下一题**：同页滚动 + 分页翻页
- 默认**不自动提交**：检测到“提交/交卷”按钮时停下，交给你检查
- 站点模板优先，模板不匹配时回退到 AI 分析页面结构

## 安装

1. 打开 Chrome，进入 `chrome://extensions/`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目文件夹 `ai-quiz-assistant`
5. 点击浏览器工具栏中的扩展图标，打开侧边栏

## 配置模型

1. 侧边栏右上角点击“模型管理”（齿轮图标）
2. 点击“添加自定义模型”
3. 填写：
   - **模型名称**：任意，仅用于区分
   - **Base URL**：只填到 `/v1` 这一级，例如 `https://api.deepseek.com/v1`
   - **API Key**：你的 Key
   - **模型 ID**：例如 `deepseek-chat`
4. 点击“测试连接”，确认返回“连接成功”
5. 保存并选中该模型

> 插件只支持 OpenAI 格式的 `/chat/completions` 接口。Anthropic 原生 `/v1/messages`、Gemini 原生接口不兼容。

常用 Base URL：

| 服务 | Base URL | 模型 ID 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 你的接入点 ID |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |
| LM Studio | `http://127.0.0.1:1234/v1` | 本地模型名 |
| one-api / new-api | `http://你的地址:3000/v1` | 渠道里的模型名 |

## 使用

1. 打开题目页面
2. 侧边栏点击“扫描页面题目”
3. 点击“开始自动答题”
4. 需要停止时点击“停止答题”

### 自动下一题

在“答题设置”中配置：

- **翻页模式**
  - `自动判断`：同页多题就滚动，分页就点“下一题/下一页”
  - `仅分页翻页`：只处理“下一题/下一页”
  - `仅同页滚动`：只滚动到下一题，不点击翻页
- **每题间隔 / 翻页等待**：避免操作过快
- **最大页数 / 最长运行时间**：防止死循环
- **有未完成题目时停止翻页**：默认开启，避免跳过失败题目
- **失败重试次数**
- **下一题/提交按钮 CSS 选择器**：站点按钮文字不常见时使用
- **按钮文字**：可自定义匹配词，例如 `下一题,下一页,继续`

### 提交

**不会自动提交。** 检测到“提交/交卷”按钮时，只会在日志中提示并停止，由你手动检查后提交。

## 工作原理

1. 优先尝试站点模板（`templates/*.json`）扫描题目
2. 没有模板或模板失败时，把精简后的页面 HTML 发给 AI 分析题目结构
3. 逐题请求答案，校验答案是否落在选项内，再点击/填写
4. 当前页完成后：
   - 同页模式：滚动到下一题
   - 分页模式：点击“下一题/下一页”，等待页面变化，重新扫描并继续
5. 整页刷新的站点：会话状态保存在 `chrome.storage.session`，新页面会自动恢复

## 项目结构

```
background.js              # 网络请求、超时/重试、会话状态
content.js                 # 扫描、答题、自动翻页控制器
modules/settings.js        # 答题设置（默认值/规范化/存储）
modules/navigation.js      # 下一题/提交按钮识别、页面变化等待
modules/site-matcher.js    # 站点模板匹配
modules/template-manager.js# 模板加载/保存
modules/scanner-enhanced.js# 模板扫描器
templates/                 # 站点模板
popup.html/js/css          # 侧边栏 UI
```

## 已知限制

- **iframe**：当前只在顶层页面运行。题目在跨域 iframe 中时可能扫描不到，可在目标 iframe 的地址上直接使用，或后续增加 `all_frames` 适配。
- **Shadow DOM**：按钮识别会尝试开放 shadow root，但题目扫描不穿透 shadow DOM。
- **验证码/滑块**：检测到后停止，不会尝试绕过。
- **提交**：不会自动提交。
- **站点差异**：通用识别不可能覆盖所有页面；优先给目标站点写模板（`templates/*.json`）或在设置里指定 CSS 选择器。
- **API 兼容性**：只支持 OpenAI 兼容的 `/chat/completions`，不支持 Azure 的 `?api-version=` 形式（Base URL 不能带查询参数）。

## 隐私

- 页面精简 HTML、题干、选项会发送到你配置的模型 API
- API Key 保存在本机 `chrome.storage.local`，不会同步到云端
- 本版本已移除原项目的统计上报和内置中转服务

## 来源与修改声明

本项目是 [rehuan/AI-ANSWER-ASSISTANT](https://github.com/rehuan/AI-ANSWER-ASSISTANT) 的修改版（衍生作品），遵循原项目的 **GNU General Public License v3.0**。原始许可证文本完整保留在 [LICENSE](./LICENSE)，未作任何修改。

- **原项目**：https://github.com/rehuan/AI-ANSWER-ASSISTANT
- **修改开始日期**：2026-10-26
- **修改内容**：移除内置中转服务、统计上报和未使用的 `declarativeNetRequest` 权限；改为只使用用户自配的 OpenAI 兼容 API；新增答题设置与自动下一题（同页滚动/分页翻页），默认不自动提交；增加答案校验、失败重试、验证码检测；重构 `background.js`、`content.js`、`popup.*`，新增 `modules/settings.js`、`modules/navigation.js`。
- 被修改的文件顶部均带有修改日期说明；详细变更见 [NOTICE](./NOTICE)。

## License

[GPL-3.0](./LICENSE)，与原项目一致。你可以自由使用、修改和再分发本项目，但再分发时须同样遵循 GPL-3.0 并提供完整源码。
