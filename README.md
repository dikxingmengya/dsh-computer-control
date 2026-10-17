# @local/dsh-computer-control

让 DeepSeek Harness 直接操作本机 Windows 桌面：截屏、找图找色、OCR 取字定位、
鼠标、键盘、窗口、剪贴板、启动应用、条件等待、录制回放、系统操作。

插件在 Host 进程内运行，把全部原生能力交给**一个常驻 PowerShell 助手进程**执行；
助手启动时用 `Add-Type` 把 C# P/Invoke 层编译一次（约 160 ms，并缓存成 DLL 复用），
之后每个操作通过 stdin/stdout 上的 NDJSON 协议往返，鼠标键盘操作 5–20 ms。

---

## 1. 为什么这样实现

| 决策 | 原因 |
|---|---|
| 常驻助手进程，而不是每次调用起一个 | 每次 `Add-Type` 要 ~1 s，逐字符点击会拖垮自动化 |
| PowerShell + C# P/Invoke，而不是原生 npm 模块 | 零依赖：不受 pnpm、原生模块 ABI、prebuild 缺失、Node/Electron 版本影响；崩溃自动重启 |
| 助手自己 `SetProcessDpiAwarenessContext(PER_MONITOR_V2)` | **关键**。本机主屏物理分辨率 2560×1600、缩放 150%，而 DPI 不感知的进程只会看到 1707×1067 —— 不修则所有点击坐标都偏 1.5 倍 |
| 截图与坐标统一为「虚拟桌面物理像素」 | 主屏左上角为 (0,0)，位于其左侧/上方的显示器坐标为负；工具返回值始终给出 screen ↔ image 的换算 |
| 图片走 `ctx.attachments.saveImage` 变成真正的 image block | 模型如果声明支持图像输入就能**真的看见屏幕**；否则退回只给文件路径 |
| 工具返回值里报告按键实际送达的窗口 | 键盘只发给前台窗口，调用方一眼就能发现「打错窗口了」 |
| 屏幕提示用**对截屏 API 隐形**的分层窗口 | 提示框绝不能出现在截图里，否则模型会看到自己的提示框 |

## 2. 工具一览（15 个）

| 工具 | 作用 |
|---|---|
| `screen_info` | 显示器布局、工作区、DPI 缩放、虚拟桌面矩形、鼠标位置、前台窗口、可见窗口数 |
| `screen_capture` | 截屏：整屏 / 主屏 / 指定显示器 / 区域 / **最上方窗口** / 指定窗口；可缩放、PNG/JPEG、自动附图、**屏幕提示** |
| `find_image` | 屏幕找图（灰度金字塔由粗到细），返回每个匹配的坐标与相似度；`waitMs` 可轮询等待出现 |
| `find_color` | 找色（返回首个匹配坐标与总数）／取色（省略 `color` 时读取单点颜色） |
| `ocr_screen` | Windows 内置 OCR 读屏，返回全文与**每行的屏幕坐标**；`query` 可按相似度定位文字 |
| `mouse_control` | `position` `move` `click` `double_click` `right_click` `middle_click` `down` `up` `drag` `scroll` |
| `keyboard_control` | `type`（含中文/emoji，走 Unicode 注入，与键盘布局无关）`press` `down` `up` `hotkey` |
| `clipboard_control` | 读写剪贴板文本（长文本用 `set` + `ctrl+v` 比逐字输入可靠得多） |
| `window_list` | 按 Z 序列出顶层窗口：hwnd、标题、进程、矩形、状态；支持标题/进程/类名正则过滤 |
| `window_control` | `focus` `minimize` `maximize` `restore` `show` `move` `topmost` `wait` `close` |
| `app_control` | `launch`（程序/文档/URL）`list`（带窗口的进程）`activate` `kill` |
| `wait_for` | `sleep` / `window`（存在或获得焦点）/ `image`（出现或消失）/ `color`（像素或区域匹配） |
| `input_record` | `start` `stop` `status` `replay`：全局钩子录制真实鼠标键盘操作，带时间戳回放 |
| `system_control` | `volume-up/down` `mute` `show-desktop` `lock` `monitor-off` `screensaver` `sleep` |
| `computer_activity` | 查看本次会话的操作列表（截屏与读屏同样计入），支持 `kind`/`since` 过滤、磁盘历史与清空 |

## 3. 屏幕提示：让人知道机器正在做什么

自动化最怕的是「人在旁边随手动一下鼠标」。插件因此会在屏幕上给出两种提示，
它们都**点击穿透、从不抢焦点、不进入截图**，并且**全机只有一个主人**。

**截图范围提示**（`screen_capture`）：在目标区域画一圈 3px 蓝色边框，
左上角带一枚圆角小标签，写明这次截的是什么：

> DeepSeek Harness 截屏 · 窗口 "记事本" 1906×1112

它是**两段式**的，因为「看得见」和「读得清」是两个不同的要求：

```
亮出边框 → 停 captureIndicatorLeadMs（默认 700 ms）→ 收起
        → 停 captureIndicatorSettleMs（90 ms）→ 按下快门
        → 边框再来一次，停 captureIndicatorLingerMs（默认 1600 ms）→ 消失
```

前一段让人知道「要截这里了」；后一段发生在快门之后，**不占用任何时间**，
所以可以给足时长去读那行标签。

**操作悬浮窗**：屏幕底部中央出现一枚药丸，左侧呼吸圆点，右侧写明正在发生什么。
它覆盖**每一次会动这台机器的调用**，截屏与读屏也算：

> ● 正在控制鼠标 · 点击 (1140, 700) · 请暂停操作鼠标键盘
> ● 正在截屏 · 窗口 记事本
> ● 正在控制键盘 · 输入 33 个字符

一轮自动化的**第一条**提示会带上「请暂停操作鼠标键盘」，之后的刷新只显示动作本身。
最后一次操作后 `inputIndicatorHoldMs`（默认 3500 ms）消失——这个时长是按「读完一整行」
而不是「瞥见一眼」定的，看不清就调大它。

纯读取类调用（`screen_info`、`window_list`、`mouse_control position`、`computer_activity`）
刻意不提示，否则自动化会被自己的提示淹没。

### 全机只有一个提示窗

提示窗是**屏幕级资源**，两个进程各画一个就会在同一点叠成两层（浅色与深色叠在一起，
看起来像「一蓝一白两个悬浮窗」）。因此原生层用命名互斥量
（`Global\DshComputerControlOverlay`）做了独占：第一个进程取得所有权，
其余进程的 `overlay.start` 返回 `available:false`，
`reason: "another process already owns the on-screen indicators"`，不画任何东西。

配套的**孤儿看门狗**：助手进程带 `-ParentPid`，每 2 秒检查一次父进程是否还在，
不在就自行退出。否则一个被强杀的 Harness 会留下助手，它的提示窗会一直挂在屏幕上，
还会通过互斥量挡住真正的所有者。

### 两套黑白配色，跟随 DSH 主题

提示窗是一对**纯黑白**样式，没有彩色点缀：

| | 药丸 | 描边 | 圆点 | 文字 |
|---|---|---|---|---|
| 浅色 | `#FFFFFF` | `#D5D9E0` | `#1B1F27` | `#1B1F27` |
| 深色 | `#16181D` | `#3B414D` | `#FFFFFF` | `#FFFFFF` |

只有截图边框保留品牌蓝（`#4D6BFE`）——它要在任意画面内容上都看得清。
`indicatorTheme: auto`（默认）按这个顺序解析：

1. **DSH 的主题设置** —— 即设置页里 `light` / `dark` / `system` 那一项。它由
   `dsh-client-ui-theme` 的 `preference` 字段持有，Host 的 `settings.describe()` 能读到，
   插件每 5 秒最多重读一次，所以在设置里切换主题**不需要重启**就能反映到提示框上。
2. `system`（DSH 的默认值）→ 交给 **Windows 应用主题**
   （`HKCU\...\Themes\Personalize\AppsUseLightTheme`），由原生层在每次绘制时读取。
3. 都读不到 → 深色。

想固定一套配色就设 `indicatorTheme: light` 或 `dark`，此时不再查询上面两级。

## 4. 操作列表：本次会话到底做了什么

`computer_activity` 列出**这一次会话对机器做过的每一件事**，最新在后：

```
9 of 9 operation(s), oldest first:
  #1 20:20:22 [读取] 查看屏幕信息 - 完成 (2218 ms)
  #2 20:20:25 [输入] 鼠标 · move (900, 700) - 完成 (11 ms)
  #3 20:20:26 [截屏] 截屏 · 区域 700x420 - 完成 (2528 ms)
  #4 20:20:27 [输入] 键盘 · 输入 33 个字符 - 完成 (612 ms)
  #5 20:20:29 [系统] 系统 · monitor-off - 被拒绝 - the system action ... allowRisky: false
```

- 每条带序号、时间、种类、耗时与结果：`完成` / `被拒绝`（风控拦下）/ `失败` / `演练`（dryRun）/ `已中止`
- **截屏与读屏同样计入**——「看过你的屏幕」和「点过你的鼠标」一样需要留痕
- `kind` 可过滤：`read` `capture` `input` `window` `app` `record` `wait` `system` `activity`
- `since` 可以增量读取（只取某个序号之后的），`history` 读磁盘镜像（重启后仍在），`clear` 清空
- 记录是**集中式**的：所有工具在注册处被同一层包装，所以不存在「某个工具忘了记录」
- 剪贴板内容只记长度、键盘输入只记字符数——日志不是密钥仓库
- 内存环形缓冲（`activityLogLimit` 条）为主，同时镜像到
  `<artifactDir>/<session>/operations.jsonl`。**不写进会话事件流**：`Session.append`
  无法给自定义事件打 `ignorable` 标记，带这种事件的会话会打不开。

### 一个实现，三个调用方

| 调用方 | 入口 |
|---|---|
| 模型 | `computer_activity` 工具 |
| 人（输入框） | `/computer-activity` 斜杠命令 |
| 人（图形界面） | 设置 → 插件 → 「操作记录」页 |

三者的数据都出自同一个 `ActivityLog`。官方插件指南明确要求「一个操作实现一次，
UI 与工具不要各写一套」，这条就是照着它做的：页面不自己读文件、不自己算，
而是通过 **Host 命令**（`ctx.remote.commands.execute`）调用同一个方法，
命令带 `--json` 时返回页面用的结构化数据，不带时返回给人读的表格。

## 5. 设置页：在界面里直接翻看

会话顶部会多出一个视图：**对话 | 轨迹 | 操作记录**。

- 六列：序号、时间、类型、操作、结果、耗时
- 结果按语义着色：`完成` / `被拒绝`（风控拦住）/ `失败` / `演练`（dryRun）/ `已中止`
- 顶部按类型筛选（全部 / 读取 / 截屏 / 输入 …），右侧刷新按钮
- 跟随当前打开的会话；换会话自动重新加载

界面在哪里、Client 怎么调用 Host，都不是猜的：

- 挂载点 `conversation.view`（"Registered Conversation target Views, rendered one at
  a time"），注册参数 `{ id, order, label }`，用**自己的** id `computer-control`，
  这个槽位 `replaceRisk: none`，所以是**并列新增**而不是遮挡官方的对话/轨迹
- 视图由 owner 直接交付 `sessionId`，页面以它为准；`useSessions` 选择器只作兜底
  （避免"视图拿到的会话"和"选择器推断的会话"不一致时去读错会话的记录）
- 同一个包里加 Client 半边：`package.json` 声明 `exports["./client"]` 与
  `dsh.client`，`client.js` 用 `window.__ModuleLoader__.load` 注册惰性工厂
  （模块表提供 React，无需构建步骤）
- **全部可见文案走 Client locale 服务**（`ctx.locale.register` / `bind` /
  `subscribe`），不读浏览器语言；在设置里换语言，页面无需刷新即跟随

> **改动 Client 半边必须重启 DSH。** `dsh-client-modules` 在启动时扫描一次
> `dsh.client` 声明并把结果缓存进 `pkgMeta`，该 Map 全文只有写入、没有删除，
> 源码里也写明 *"Scanning is incremental per package — there is no full-rescan code
> path."* 所以「事后给 package.json 加上 `dsh.client`」这件事，
> 重载插件行和刷新浏览器都不会被发现；启动之后**编辑** `client.js` 才会被
> HMR 比较并热替换。

## 6. 提示框为什么不会出现在截图里

窗口用 `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST`
创建：半透明、点击穿透、不抢焦点、不进任务栏。真正要解决的是「既让人看见、又不进截图」这一对矛盾。

**默认做法是不用任何系统级排除**，而是在快门之前把提示收起来
（见上面第 3 节的两段式时序）。鼠标键盘的悬浮窗同样在每次截屏/OCR/找图前临时收起、事后恢复。

**为什么不用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`？** 这个 Windows 10 2004+
的 API 名义上正是为此设计的：窗口对用户可见、对截屏 API 不存在。但在部分显示管线上
（本机即如此）它**调用成功、截图里也确实没有，可窗口同时也从显示器上消失了**——
因为屏幕截图读的就是 DWM 合成结果，也就是显示器显示的内容。那样提示框就对人隐形了，
恰好废掉了它存在的唯一意义。因此它被降级为**显式可选项**：

```yaml
indicatorCaptureExcluded: true   # 默认 false
```

打开后提示框会在快门期间一直停留（`mode: "during"`），代价是可能对人也隐形。
判断方法很简单：打开它，触发一次截图，如果你看不见边框，就保持默认的 false。

`screen_capture` 的返回值始终给出这次用了哪条路：
`indicator: { shown, mode: "during" | "before" | "off", excludedFromCapture }`。

关闭提示：配置里把 `captureIndicator` 或 `inputIndicator` 设为 `false`；
提示文字语言由 `indicatorLanguage` 控制（`auto` 跟随系统区域）。

## 7. 当前安装状态

已通过 `plugin_manager` 安装并启用（`link:E:/Projects/DeepSeekPlugins/dsh-computer-control`）：

```json
// C:\Users\HONOR\.dsh\profiles\desktop\package.json
"dependencies": { "@local/dsh-computer-control": "link:E:/Projects/DeepSeekPlugins/dsh-computer-control" },
"dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-computer-control" ] } }
```

> **重要**：Harness 的模块 HMR 是 opt-in 的（base 配置里 `hmr.root: []`），
> 已加载的 JS 模块按 URL 缓存。插件安装后**修改过 `index.js` / `lib/*.js` / `native/*`，必须重启一次 DSH**
> 才会加载新代码（只改 `cordis.patch.yml` 的配置会热重载）。重启后 14 个工具与屏幕提示即全部可用。

卸载：`plugin_manager` → `remove_bundle`，target 传 `@local/dsh-computer-control`。

## 8. 配置

编辑 `C:\Users\HONOR\.dsh\profiles\desktop\cordis.patch.yml`，覆盖 `computer-control` 行即可
（patch 会**整体替换**该行的 `config`，所以要把想保留的字段一并写上）：

```yaml
- id: computer-control
  name: '@local/dsh-computer-control'
  config:
    dryRun: false               # true = 只演练，不注入任何输入，返回 wouldRun
    allowRisky: false           # true = 允许关窗口/杀进程/锁屏/息屏/睡眠
    attachImages: auto          # auto | always | never
    maxImageDim: 1568           # 附图最长边；0 = 原始分辨率
    jpegQuality: 85
    artifactDir: ''             # 空 = $DSH_HOME/cache/computer-control
    typingDelayMs: 0            # 逐字延迟，慢应用可调大
    helperTimeoutMs: 20000
    captureTimeoutMs: 60000
    groups:                     # 设为 false 可把整组工具移出模型上下文
      core: true
      find: true
      ocr: true
      record: true
      system: true
    disabledTools: []           # 按名字单独禁用，例如 [input_record, system_control]
    promptSection: true         # 是否向系统提示注入坐标约定段落
    registerComputerUseSeam: false  # 见第 12 节

    # 屏幕提示（第 3 节）
    captureIndicator: true          # 截屏前框出范围
    captureIndicatorLeadMs: 700     # 快门之前亮多久
    captureIndicatorLingerMs: 1600  # 快门之后再来一次，供从容阅读标签
    captureIndicatorSettleMs: 90    # 收起后等多久再截
    inputIndicator: true            # 每次操作都显示悬浮窗（截屏、读屏也算）
    inputIndicatorHoldMs: 3500      # 最后一次操作后停留多久（够读完一整行）
    indicatorCaptureExcluded: false # true = 用 WDA 让提示框留在快门期间（可能对人也隐形）
    indicatorLanguage: auto         # auto | zh | en
    indicatorTheme: auto            # auto（跟随 DSH 主题）| light | dark
    indicatorClaimScreen: true      # 独占全机提示窗；只有诊断脚本才该关掉

    # 操作列表（第 4 节）
    activityLogLimit: 300           # 每个会话保留多少条
    activityLogToFile: true         # 镜像到 operations.jsonl，重启后仍可查
```

配置在插件激活时校验，错误信息会直接指出字段名并出现在安装/启用结果里。

## 9. 安全模型

- **dryRun**：所有会改变机器状态的操作（鼠标、键盘、窗口、剪贴板、系统、启动/杀进程）
  只返回 `{dryRun: true, wouldRun: {...}}`，不注入任何输入。录制的钩子与屏幕提示也不会启动。
- **allowRisky**：`window_control close`、`app_control kill`、
  `system_control` 的 `lock` / `monitor-off` / `screensaver` / `sleep` 在开关关闭时直接拒绝，
  错误信息里点名 `allowRisky`。
- **人在回路**：第 3 节的两种提示让操作者随时知道机器要截哪里、正在点哪里、正在敲什么。
- **坐标校验**：鼠标目标点必须落在虚拟桌面内，否则报错并给出合法范围，而不是默默点错地方。
- **焦点透明**：`keyboard_control` 的每次结果都带 `foreground`（hwnd/标题/进程），
  告诉调用方按键究竟送进了哪个窗口。
- **审计**：抓图与录制都落盘，路径写在返回值里；助手进程的 stderr 保留最近 200 行供诊断。
- **边界**：本插件直接调用 Win32 注入输入，**不经过 DSH 的文件沙箱**——这是能力本身决定的。
  只有 `danger-full-access` 或明确批准的会话才应加载它。

## 10. 坐标与 DPI 约定

- 所有坐标都是**虚拟桌面的物理像素**：主屏左上角 `(0,0)`，位于其左侧/上方的显示器为负。
- `screen_capture` 的返回值同时给出：
  - `originX/originY`：截取区域在屏幕上的左上角
  - `scaleToScreen`：屏幕像素 ÷ 图像像素
  - `mapping`：两句可直接代入的换算公式
- 因此「在图上看到按钮在 (ix,iy)」→ `x = originX + ix * scaleToScreen`。
- 窗口截图用 `PrintWindow(PW_RENDERFULLCONTENT)`，**被遮挡也能截到**；
  若返回全黑则自动回退 BitBlt 窗口 DC，再回退按窗口矩形截屏区域，回退结果记录在 `source` 字段。
- 最小化的窗口没有有效矩形，工具会明确要求先 `window_control {action:"restore"}`。

### `target=window` 与 `target=region` 不是一回事

这是最容易用错的一处，代价是拿到一张「看起来对、其实截错了窗口」的图：

| | 取的是什么 | 被遮挡时 | 用途 |
|---|---|---|---|
| `target=window` | 那**一个**窗口自己渲染的内容（PrintWindow） | **仍然截到它**，与它在不在前台无关 | 想知道某个程序长什么样 |
| `target=region` | 该屏幕矩形**最上层**的像素（BitBlt 屏幕） | 截到的是盖在它上面的窗口 | 想知道用户此刻**看到**什么 |

实测（第 8 节）：把一个记事本放在 DSH 窗口后面完全遮挡，对**同一块屏幕矩形**分别截图——
`window` 得到记事本的真实内容，`region` 得到覆盖它的 DSH 窗口。

## 11. 实机验证结果

**`E:\Projects\DeepSeekPlugins\.tooling\activity-test.mjs`：操作列表与提示文案，19/19 通过。**

覆盖：截屏被记录且被公告、鼠标记录坐标、纯读取不公告、风控拒绝标记为 `refused`、
dryRun 标记为 `dry-run`、序号严格递增、`kind` 与 `since` 过滤、渲染可读、
磁盘镜像可回读、`clear` 生效；公告文案（`正在截屏 · 区域 260x160`、
`正在控制鼠标 · click (100, 200)`、输入只报字符数）单独做了断言。

**`E:\Projects\DeepSeekPlugins\.tooling\overlay-ownership-test.mjs`：提示窗独占与孤儿回收，4/4 通过。**

- 第一个进程取得所有权（`ownsScreen: true`）
- 第二个进程被拒绝：`reason: "another process already owns the on-screen indicators"`，不画任何东西
- 诊断脚本用 `claim: false` 仍可绘制，不影响真正的所有者
- **看门狗**：父进程活着时助手存活，父进程被杀后助手自行退出（exit code 0）

**`E:\Projects\DeepSeekPlugins\.tooling\theme-logic-test.mjs`：主题解析顺序，8/8 通过。**

**`E:\Projects\DeepSeekPlugins\.tooling\command-test.mjs`：`/computer-activity` 命令，8/8 通过。**

覆盖：命令注册、`--json` 的结构化输出、不加参数时的可读表格、`--kind` 过滤，
以及**错误参数必须报用法而不是默默回答另一个问题**（拼错的旗标、未知的 kind、
非数字的 limit 三种都验证了）。

**`E:\Projects\DeepSeekPlugins\.tooling\client-test.mjs`：设置页无浏览器渲染，18/18 通过。**

在一台没人能替 agent 开浏览器的机器上，这是验证客户端半边的办法：用最小 React
（含 hook 索引与 effect 依赖语义）加一个假的 Client 上下文，把页面真的渲染成元素树再断言。

- 模块以包名为 id 注册惰性工厂，声明 `slots` / `remote.commands` / `locale`
- 两份字典**键完全一致、无空串、占位符一致**（这三条都是容易悄悄出错的地方）
- 槽位注册到 `settings.plugins.tab`，用自己的 id `computer-control`
- 中英两轮渲染：标题、筛选按钮、六个表头、结果文案、`2495 毫秒` / `2495 ms` 插值
  全部正确产出
- **切换语言后无需重新挂载即跟随**（同一组件再次渲染即变英文）
- 反查源码：不含 `navigator.language`，注释外没有裸中文串——确保文案真的都走了 locale 服务

**`E:\Projects\DeepSeekPlugins\.tooling\e2e.mjs`：真实桌面端到端场景，32/32 通过。**

场景：清空残留记事本 → 启动 → 聚焦 → 输入 → 剪贴板粘贴 → 截窗口 → 找图 → 点击拖拽 →
录制 → 风控校验 → 清理。

- 截屏：整屏 2560×1600 → 1568×980、原生分辨率、窗口、区域；附图返回 `text,image` 两个 block
- 找图：从实屏裁下的 420×60 模板在 580×220 搜索区内**精确复现在 (503,552)，score 1**
- 找色/取色：`#333333` 全屏 36 万个匹配像素，首个在 (0,0)
- OCR：Windows 内置引擎，语言包 `zh-Hans-CN`，96–103 行，坐标经换算后与实际位置一致
- 键鼠：点击/移动坐标分毫不差；`type` 33 字符全部落入指定窗口；
  `ctrl+a` + `ctrl+v` 把剪贴板内容粘进记事本（25 个字符）
- 等待：窗口存在 13 ms、图像出现、颜色匹配、sleep
- 录制：注入自身输入被 `dwExtraInfo` 标记过滤，录制到 **0** 个事件；回放按时间戳执行
- 风控：`allowRisky: false` 时关窗口/息屏被拒；`dryRun` 下三类操作都只返回 `wouldRun`

**指定窗口截图矩阵（Harness 实机，记事本 1906×1111 被 DSH 窗口完全遮挡）：**

| 用例 | 结果 |
|---|---|
| `target=window` 按 hwnd，窗口**被遮挡** | 截到记事本真实内容（含刚输入的 43 个字符） |
| `target=region` 对**同一块屏幕矩形** | 截到覆盖它的 DSH 窗口 —— 证明两者取的不是同一个东西 |
| `target=window` 按标题正则 `Notepad` | 正确解析到该窗口并截图 |
| `target=window` 窗口**最小化**时 | 报错并给出确切修复命令：`window_control {action:"restore", window:"0x461126"}` |
| `restore` 后重截 | 成功 |
| 每次返回值的 `mapping` | 屏幕 ↔ 图像换算公式，用它算出的关闭按钮坐标 (2312,293) 一击命中 |

**主题跟随：`theme-test.mjs`（配色渲染）+ `theme-logic-test.mjs`（解析顺序，8/8）。**

- 不指定时原生层自读 Windows 应用主题 → 本机解析为 `light`
- 两套配色各自渲染截图核对：浅色为近白药丸 + 深色文字，深色为深灰药丸 + 白字，品牌蓝边框与圆点两套一致
- 解析顺序：显式 `indicatorTheme` > DSH 的 `ui-theme.preference` > Windows 主题；
  `preference: system` 与「读不到设置」都安全退化为跟随 Windows；5 秒内的重复读取走缓存

**提示框可见性：`visibility-test.mjs` + `visibility-analyze.ps1`。**

关键推理：屏幕截图读的是 DWM 合成结果，**也就是显示器显示的内容**。所以「普通截图里有 = 人看得见」，
「插件自己的截图里没有 = 工具产出的画面依然干净」。对同一块 420×320 区域测像素：

| 截图 | 品牌蓝像素 | 深色药丸像素 | 结论 |
|---|---|---|---|
| 提示框亮着，普通截屏 | **5152** | 6220 | 边框与悬浮窗确实在屏幕上 |
| 同一区域，经 `screen_capture` | **0** | 0 | 快门之前已收起，截图干净 |

**独立观察者验证（`badge-observer.mjs` / `frame-observer.mjs`）。**
另起一个进程轮询屏幕并拍照，同时由 Harness 触发动作：

- 触发 `mouse_control` 后拍到徽标条带内 **3940** 个悬浮窗像素 → ![徽标](.tooling/badge-observed.png)
- 触发 `screen_capture` 后拍到屏幕边缘 **2100** 个边框像素 → ![边框](.tooling/frame-observed.png)

**`overlay-test.mjs` + `overlay-analyze.ps1`：`WDA_EXCLUDEFROMCAPTURE` 的行为验证，5/5 通过。**
它证明了「调用成功、截图里为 0」——但正是这一现象掩盖了它同时对人也隐形的事实，见第 3 节。
该模式现在是显式可选项，不再是默认。

验证过程中发现并修复的真实缺陷（按发现顺序）：

1. `$args` 是 PowerShell 自动变量，被当作函数参数名导致**全部参数解析静默失效**；
2. hwnd 比较的大小写不一致（`0X` vs `0x`），按句柄选窗口永远失败；
3. 截图映射文案里的占位符 `ix/iy` 被当成变量插值，任何截图都抛 `ReferenceError`；
4. 低对比模板时同分候选被截断，找图结果每次不同 → 改为确定性排序并扩大候选集；
5. 杀一个已退出的进程会报错而不是视为已达成（Win11 商店版记事本的启动器 pid 会先退出）；
6. 按 pid 找不到进程时不再回退按进程名处理，导致 `kill {pid, name}` 什么都杀不掉；
7. **`app_control launch` 在同一进程已有窗口时会选错窗口**（Win11 记事本把所有未保存文档
   放在一个进程里，启动时会恢复上次的全部标签页）→ 改为只认「启动前不存在的窗口」；
8. 覆盖层两个窗口共用一个窗口类时没有区分句柄，悬浮窗会被当成边框绘制；
9. **`wait_for` 的 window 模式返回了 `undefined` 字段**——只在真实注册表下暴露，因为本地
   兜底的 `defineTool` 不做输出校验。已让本地实现也按「lossless JSON + 输出 schema」校验，
   这类缺陷以后在安装前就会失败；
10. **`app_control launch` 无法定位打包应用的窗口**（计算器等 UWP 应用的顶层窗口属于
    `ApplicationFrameHost.exe`，进程名对不上）→ 无同名窗口且只多出一个新窗口时认它；
11. **`window_list` 把 owned 窗口全部过滤掉了**——而模态对话框正是 owned 窗口
    （保存确认、文件选择器），模型会完全看不见 → 改为保留形如对话框的 owned 窗口并标记 `dialog: true`；
12. **DLL 缓存用固定文件名覆盖式写入**：另一个助手进程已加载该 DLL 时文件被占用，重建必然失败
    → 改为按源码内容哈希命名，各代互不干扰，并清理不再被引用的旧代；
13. **`WDA_EXCLUDEFROMCAPTURE` 让提示框对人也隐形**（第 5 节）→ 默认不再使用，改为快门之前收起；
14. **两个助手进程会把两个悬浮窗叠在同一点**（用户看到「一蓝一白重叠」）→
    提示窗改为命名互斥量独占，并给助手加 `-ParentPid` 看门狗，父进程消失就自行退出；
15. **提示窗配色只有一套彩色**（用户要求黑白跟随主题）→ 改为纯黑白两套，
    蓝色只保留在截图边框上，因为那个必须在任意画面内容上可见。

## 12. 与 Host 既有 seam 的关系

Host 已预留 `computerUse` 服务（`ctx.computerUse.register(name)`，**全进程唯一占用**），
官方另有实验实现 `dsh-experimental-computer-use-cua-driver-{mcp,native}`（依赖外部 Cua Driver）。
本插件默认**不占用**该 seam（`registerComputerUseSeam: false`），以免锁死官方提供方；
需要时打开即可让本插件成为该 seam 的提供者。

## 13. 已知限制

- 仅 Windows。协议与坐标模型与平台无关，但原生层是 Win32。
- 需要 `powershell.exe`（Windows PowerShell 5.1，系统自带）或 `pwsh`；
  可用 `DSH_COMPUTER_CONTROL_PWSH` 环境变量指定解释器路径。
- 提示框默认在快门之前收起，所以**边框不会出现在照片里**——它出现是为了告诉你「将要截这里」。
  想要「快门期间一直停留」可以打开 `indicatorCaptureExcluded`，但请先确认在你机器上它对人可见。
- `screen_capture target=region` 截的是**屏幕最上层**的内容；即使目标窗口被遮挡也能截到，
  请改用 `target=window`（走 PrintWindow，与该窗口是否在前台无关）。
- 关闭一个有未保存改动的窗口会弹出保存确认，它现在会出现在 `window_list` 里（`dialog: true`），
  调用方需要显式处理它。
- OCR 用的是 Windows 内置引擎：拉丁文字准确，中文识别质量一般且依赖系统语言包。
- 找图是灰度匹配，对缩放/主题变化敏感；`template` 必须来自**同一缩放比例**的截图。
- 输入注入会被 UIPI 拦截：前台窗口若是更高完整性级别（以管理员运行的程序），
  `SendInput` 会失败并报出 Win32 错误码，此时需以相同权限运行 DSH。
- 录制记录的是真实用户输入，注入的输入会被过滤掉；回放按原始时间戳执行，`speed` 可加速。
- 键盘输入后应用是异步消费的，紧接着读屏可能读到旧内容——用 `wait_for` 而不是立即读屏。
  刚启动的打包应用（Win11 记事本）可能在窗口出现后仍短暂丢弃按键，需给它一点时间。
- 提示框是屏幕上真实存在的窗口，会短暂出现在录屏/投屏里——它只对截屏 API 隐形。

## 14. 目录结构

```
dsh-computer-control/
  package.json          # dsh.bundle.patch 指向 cordis.patch.yml；无依赖
  cordis.patch.yml      # 插入 computer-control 行 + 全部可调配置（带注释）
  index.js              # 插件入口：配置校验、工具分组注册、系统提示、生命周期
  lib/
    bridge.js           # 常驻助手进程：PS 宿主探测回退、NDJSON 分帧、超时、中止、崩溃重启
    toolkit.js          # defineTool（优先用 @deepseek-ai/dsh-tools，失败则本地等价实现）
    config.js           # 配置默认值与校验
    artifacts.js        # 落盘目录、图片附件提交、模型图像能力判定
    indicator.js        # 屏幕提示：截图边框与输入悬浮窗的时序、避让、文案
    geometry.js         # 显示器/区域/窗口解析、hwnd 归一化、坐标钳制
    tools/screen.js     # screen_info screen_capture find_image find_color ocr_screen
    tools/input.js      # mouse_control keyboard_control clipboard_control
    tools/window.js     # window_list window_control app_control
    tools/misc.js       # wait_for input_record system_control
  native/
    agent.ps1           # 助手主程序：初始化、OCR、op 分发、NDJSON 主循环
    native.cs           # C# P/Invoke：DPI、截屏、取色、找色、金字塔找图、窗口、
                        # SendInput、剪贴板、系统操作、全局钩子录制
    overlay.cs          # C# 覆盖层：截图边框与输入悬浮窗（分层、穿透、不抢焦点）
    .cache/             # Add-Type 编译产物缓存（按源码内容哈希命名，各代互不冲突）
  locale/{en,zh}.json   # Plugin Manager 显示文案
  icon.svg
```

## 15. 排错

| 现象 | 处理 |
|---|---|
| 插件行激活失败，错误含字段名 | 按信息改 `cordis.patch.yml` 里对应的配置值 |
| 工具调用报 `no PowerShell host could start the native helper` | 设 `DSH_COMPUTER_CONTROL_PWSH` 指向可用的 `powershell.exe`/`pwsh.exe` |
| 报 `native helper did not answer ... within N ms` | 大区域找图或原生分辨率截屏较慢，调大 `captureTimeoutMs` |
| 点击位置偏移 | 确认没有第二个 DPI 不感知的进程在换算坐标；本插件的助手始终是 per-monitor-v2 |
| 按键没反应 | 看结果里的 `foreground`；用 `window_control {action:"focus"}` 先取得焦点；刚启动的应用要等一会儿 |
| **看不见提示框** | 确认 `captureIndicator` / `inputIndicator` 不是 false，且 `indicatorCaptureExcluded` 是 false。若打开过排除却看不见边框，说明你的显示管线会把被排除的窗口对人也隐藏，保持 false |
| 提示框留在了屏幕上 | 自动隐藏由助手内的定时器兜底；若真的卡住，重载插件行（`set_plugin` 关再开）会重建助手进程。看门狗与互斥量保证孤儿助手不会长期占屏 |
| **看到两个悬浮窗叠在一起** | 说明有第二个助手进程在画。互斥量已让多数情况不可能；用 `powershell -File .tooling/overlay-scan.ps1` 列出所有覆盖层窗口及其属主进程，杀掉非当前 Harness 的那个。改过 `lib/bridge.js`（`-ParentPid`）需要重启 DSH 才会启用看门狗 |
| 悬浮窗颜色不跟随主题 | 看 `indicatorTheme`（`auto` = 跟随 DSH 主题）；DSH 自身选 `system` 时跟随 Windows 应用主题。显式设 `light` / `dark` 可固定 |
| 截图里出现了提示框 | 正常路径下不会：快门之前已收起。若确实出现，看返回值里的 `indicator.mode` 和 `excludedFromCapture` |
| 改了 `native/*.cs` 想生效 | C#/PS 代码在**助手进程启动时**从磁盘读取，重载插件行即可重建，无需重启 DSH；改了 `lib/*.js` 则必须重启 DSH |
| 分不清哪个窗口能点 | 先 `screen_capture target=window`（PrintWindow，被遮挡也能截），别用 `region` 去截被遮挡的窗口 |
| 不想看到任何提示 | `captureIndicator: false` 与 `inputIndicator: false` |
| 提示文字是英文 | `indicatorLanguage: zh`（`auto` 跟随系统区域） |
| 报 `SendInput injected 0 of N events` | 前台是管理员权限程序，UIPI 拦截；以相同权限运行 DSH |
| 需要看助手内部错误 | 助手 stderr 保留在 bridge 诊断里；也可手工跑 `powershell -File native/agent.ps1` 并喂 JSON 行 |
| 需要确认提示框是否真的画出来了 | 用 `.tooling/frame-observer.mjs` / `badge-observer.mjs` 这类独立进程轮询屏幕并拍照——它读的就是显示器显示的内容 |
