# dsh-model-avail

DSH（DeepSeek Harness）插件：真实探测每个模型能不能完成一次请求，然后按「**可用模型数**」把模型选择器里的提供商从上到下重排。

展开选择器看到的效果：

```
qwen-token-plan-cn · 16/20
Our Free Model + 自动识图 · 12/32
Our Free Model · 11/32
…
opencode2dsh · 0/8
DeepSeek Account · 0/2
```

点进去，每个模型名按判定结果上色：**可用=绿色**（`#2ea043`）、**不可用=红色**（`#d1242f`）、**待验证=灰色**；不可用的模型还会沉到组尾并标注 `(不可用)`。

## 为什么需要它

选择器里的模型列表来自 `listModels` / `resolveModelInfo`，这只能证明**提供商的元数据接口**通了，并不能证明某个模型真的能跑。上游下线、额度用尽、凭证失效的模型照样会出现在列表里 —— 选中它，然后失败。

本插件对每个模型发一次**最小真实请求**（一条 `ping` 消息 + 1 个输出 token），按终结 `finish` 块判定：

| 状态 | 含义 | 后续 |
| --- | --- | --- |
| `available` | 请求成功（拿到输出或正常结束） | 计入可用数 |
| `unavailable` | 明确不可用：无凭证、模型不存在、被禁、额度耗尽等 | 沉到组尾并标注 |
| `unknown` | 途中失败：限流、超时、网络抖动、上游报错原因不明 | **不判死**，下一轮重试 |

宁可少标也不可错标：只有明确的拒绝才算不可用。

## 安装

要求：DSH 桌面版或 CLI（Web UI 形态），Node.js ≥ 20。插件**没有运行时依赖**，不需要 `npm install`。

### 方式一：DSH 插件面板（推荐）

1. 打开 DSH Web UI，左侧栏进 **插件 / Plugins** 页；
2. 点 **安装**，填入下面任一形式：
   - Git 仓库：`github:Shino113-1/dsh-model-avail`
   - 本地目录：克隆后的绝对路径，例如 `D:\tools\dsh-model-avail`
   - npm 包名（如果已发布到 npm）：`dsh-model-avail`
3. 安装完成后**重启 DeepSeek Harness**（客户端插件清单在宿主启动时下发，刷新页面不生效）。

面板会在 profile 的 `dsh.profile.bundles` 里登记本插件，并走 pnpm 拉取依赖 —— 这条路径需要能访问 GitHub 或 npm。

### 方式二：安装脚本（离线、无需 pnpm）

```bash
git clone https://github.com/Shino113-1/dsh-model-avail.git
cd dsh-model-avail

node scripts/install.mjs --list      # 看看本机有哪些 profile
node scripts/install.mjs --dry-run   # 预览要改什么
node scripts/install.mjs             # 自动检测唯一的 profile 并安装
```

脚本只做两件事：把包复制进 `<profile>/node_modules/dsh-model-avail`，把包名追加进 profile `package.json` 的 `dsh.profile.bundles`。它**不动依赖条目**，所以不会让 pnpm 锁文件失配、也不会触发联网重装。

指定 profile：

```bash
node scripts/install.mjs --profile "C:\Users\<你>\.dsh\profiles\desktop"
```

也可以用环境变量 `DSH_PROFILE_DIR`（完整路径）或 `DSH_PROFILE`（profile 名）。装在哪个 profile，只影响哪个 profile 的会话。

### 方式三：手动

1. 把整个目录复制到 `<profile>/node_modules/dsh-model-avail`；
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组末尾加上 `"dsh-model-avail"`；
3. 重启 DSH。

## 确认是否生效

- **选择器**：提供商标题带 `· 可用/总数`，并按可用数降序。第一次启动宿主会在几秒后自动开跑探测，探测完成前列表保持原顺序（不会闪来闪去）。
- **控制台**：每次快照版本变化会打一行 `[model-avail] N providers decorated; top: …`；展开某个提供商、模型名真的上了色之后，还会打一行 `[model-avail] painted N model names by availability (可用 …、不可用 …、待验证 …); 可用色 rgb(46, 160, 67)、不可用色 rgb(209, 36, 47)` —— 连浏览器算出来的颜色一起报，样式没生效一眼可见。
- **接口**：`curl http://127.0.0.1:<端口>/dsh-model-avail/state` 返回快照，含 `probing`、`progress`、每个模型的 verdict。端口就是 Web UI 的端口（默认按 DSH 启动参数）。

如果只看到统计、却没按可用数排序，通常是探测还没跑完（`probing: true`）。

## 工作原理

```
lib/index.js     宿主半侧：探测模型、缓存结果、提供 HTTP 接口
lib/client.js    浏览器半侧：读写 modelDirectories.catalog.store 里的 groups
cordis.patch.yml bundle 补丁（插入 id: model-avail）
```

**宿主**：启动 4 秒后自动开跑，之后监听 `llm/adapters-updated`；缓存写在 `$DSH_HOME/dsh-model-avail/state.json`，TTL 6 小时，重启复用。

> 重启后适配器可能比插件晚注册完，第一轮目录会是空的。这时插件会在 25 秒后自己再补一轮，不需要手动刷新。

**浏览器**：先把自己看到的 roster（每个 provider 及其模型 id）POST 给宿主，再拉取 `/dsh-model-avail/state`，给每个 provider 组算「可用数」，重排并把标签写进组名。装饰是幂等的 —— 先剥掉自己的标签再重算，所以多次刷新不会叠成 `· 3/8 · 3/8`。页面启动立即拉一次，之后每 15 秒复查。

> 为什么 roster 由浏览器上报：模型选择器里可能出现宿主 `llm.listModels` 列不出来的路由（例如只写在设置里的自定义 provider，适配器能应答但目录为空）。这类 provider 以前会显示成 `0/0` 或者完全没有标签，现在以选择器实际渲染的内容为准，宿主只负责逐个探测「这条路由到底答不答」。

**上色**：选择器是第三方插件 `dsh-reasoning-effort` 渲染的，模型名节点没有暴露可用性字段，所以颜色只能在 DOM 上做 —— 给每个 `.dsh-reasoning-model__option-name` 打一个 `data-model-avail="available|unavailable|unknown"`，再往 `document.head` 注入一条按属性选择器上色的样式表。弹层每次打开都是新节点，因此用 `MutationObserver`（120ms 防抖）盯住 `document.body` 重画。只在选择器用这套类名时生效，换别的选择器实现就不上色（但排序与统计照旧）。

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-model-avail/state` | 当前快照 |
| GET | `/dsh-model-avail/state?refresh=1&force=1` | 触发一轮探测（`force` 忽略缓存） |
| POST | `/dsh-model-avail/roster` | `{"providers":[{"id":"…","name":"…","models":[{"id":"…","name":"…"}]}]}` 浏览器上报选择器里的 roster |
| POST | `/dsh-model-avail/probe` | `{"provider":"…","model":"…"}` 单点立刻复测 |

### 预算

- 每 provider 最多探测 60 个模型；每轮最多 80 次探测；并发 3；单次超时 20s。
- 一轮没探完且**确有进展**时，30 秒后自动续下一轮；全是 `unknown` 时不会空转。

这些常量目前写死在 `lib/index.js` 顶部，改完重启 DSH 生效。

## 已知限制

- 只回答「能不能跑」，不测质量、速度、上下文长度、工具调用能力。
- 探测确实发请求（每次 1 个输出 token）。计费敏感可把 `MAX_PROBES_PER_CYCLE` 调小、`TTL_MS` 调长。
- `deepseek-account` / `deepseek-official` 由 DSH 核心固定置顶，本插件不抢这两个位置 —— 所以「可用数最多」的那个不一定排在最上面。
- 浏览器半侧只对 Web UI 生效；TUI 的选择器不受影响。
- 提供商统计包含 DSH 里按视觉能力拆分出来的变体组（如 `X + 自动识图`），它们各自有独立统计。
- 颜色只给「当前选择器」上：它由 `dsh-reasoning-effort` 插件渲染，类名变了本插件就安静地不上色（排序与标签不受影响）。

## 卸载

```bash
node scripts/install.mjs --uninstall
```

或在插件面板里移除，然后重启 DSH。

## 开发

```bash
node --test test/client.test.mjs test/host.test.mjs
```

客户端测试用桩 `window.__ModuleLoader__` 载入真实的 `lib/client.js`；宿主测试用假 `ctx` / 假 `webServer` 走一遍真实路由处理函数。全部只用 Node 内置模块，CI 里也是这条命令（`.github/workflows/test.yml`）。

## 仓库

<https://github.com/Shino113-1/dsh-model-avail>

克隆、改动、再推回去：

```bash
git clone https://github.com/Shino113-1/dsh-model-avail.git
```

如果想发到 npm，`npm publish` 直接可用（无需构建，`files` 已列全）。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

## English

A DSH plugin that probes every model with one real 1-token request, marks what actually answers, and reorders the model picker's providers by how many models each one really serves (`Provider · 8/12`).

Install: open **Plugins** in the DSH Web sidebar and install `github:<you>/dsh-model-avail`, or clone and run `node scripts/install.mjs`, then **restart DeepSeek Harness**. Requires Node.js ≥ 20 and no runtime dependencies.

Verdicts: `available`, `unavailable` (explicit refusal: bad credentials, missing model, quota), `unknown` (transient — never marked dead). Cached at `$DSH_HOME/dsh-model-avail/state.json` for 6 h. Endpoint: `GET /dsh-model-avail/state`.