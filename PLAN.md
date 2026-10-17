# 方案文档（已被 README.md 取代）

本文件是开工前的方案与商议记录。**实现完成后的权威文档是 [README.md](README.md)**，
其中包含工具清单、配置项、安全模型、坐标约定、实机验证结果与排错表。

## 最终确认的选择

| 议题 | 决定 |
|---|---|
| 功能范围 | P0 + P1 + P2 全量（14 个工具） |
| 工具粒度 | 专用工具，不做巨型 action 工具 |
| 引擎 | PowerShell 常驻助手 + C# P/Invoke，**零 npm 依赖** |
| 截图交模型 | 自动判断（模型声明 image 输入则附图，否则只给路径） |
| dry-run | 默认关闭，配置可开 |
| 交付方式 | 直接 `install_bundle` 装入当前 profile 并实机验证 |

## 与方案的差异

- **`Config` 导出**：最终没有导出 schemastery 的 `Config`，改由插件在激活时自行校验并抛出
  带字段名的错误。原因是 `Config` 校验失败会直接让整行激活失败，而自行校验能给出更精确的信息，
  也不会因 schemastery 版本差异产生风险。
- **`toolkit.js`**：`defineTool` 优先使用官方 `@deepseek-ai/dsh-tools`；若该内部包解析不到，
  自动退回到本地等价实现（同一套作者词汇表 + 结构校验），插件因此不会因解析问题整体失效。
- **`computerUse` seam**：默认不注册（`registerComputerUseSeam: false`），
  避免把 Host 上唯一的 provider 槽位锁死、让官方 Cua Driver 实现无法注册。
- **键盘工具返回值**：实机验证时发现按键可能送错窗口，因此每次调用都回传 `foreground`。
- **`app_control kill`**：pid 已退出时不再报错，而是视为已达成；有进程名时回退按名处理
  （Win11 商店版记事本的启动器 pid 会立即退出）。

## 验证

`E:\Projects\DeepSeekPlugins\.tooling\e2e.mjs`：真实桌面端到端场景，**31/31 通过**。
详见 README 第 7 节。

## 未决事项

**需要重启一次 DSH**：Harness 的模块 HMR 是 opt-in 的，已加载的 JS 模块按 URL 缓存，
因此验证期间修复的代码要等下次启动才会生效；重启后 14 个工具与屏幕提示全部可用。

## 追加需求（第二轮）

用户追加：截屏与窗口捕捉时显示范围提示；调用鼠标键盘时显示不影响观感的悬浮提示以防误操作。
实现见 README 第 3 节——`native/overlay.cs` 提供两个分层、点击穿透、不抢焦点的窗口，
用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 让它们对截屏 API 隐形；
不支持该能力的系统退化为「先显示→收起→再截」，保证截图永远干净。
验证：`overlay-test.mjs` 用像素计数证明提示框确实渲染、且开启隐形后在同一区域截图中为 0 像素；
自动隐藏定时器另有专项校验。端到端用例增至 32 项，全绿。
