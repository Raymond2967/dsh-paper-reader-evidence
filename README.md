# dsh-paper-reader-evidence

DeepSeek Harness 的论文阅读插件：在原生 PDF 阅读器旁边提问，答案里的名称、数字和图上标签可以直接点击回原文并框选；每条答案下方还有可展开的「查证过程」。

基于 [`@ggboy123/dsh-paper-reader`](https://github.com/GGboya/dsh-paper-reader) v1.12.0（MIT）扩展，保留原文献库、PDF 阅读器、翻译、笔记和伴读能力。

## 功能

- **PDF 阅读器**：文献库、连续滚动/翻页、缩放、搜索、笔记、翻译。
- **证据引用**：文本层、OCR 标签、整张表格和整幅图都有页码、原文和归一化坐标；点击答案中的链接，阅读器跳页并画框。
- **查证过程**：默认折叠；展开后按时间显示工具处理过的页、实际检索词、返回的证据、最终引用和额外读取。只记录本插件工具，模型内部思考不进入记录。
- **当前论文上下文**：论文会话通过 `dpr-...` 会话 ID 绑定论文，系统上下文会明确告诉模型“这篇文章”是哪一篇，不需要先猜目录或列文献。
- **工作区按专题**：同一专题只建一个 Harness 工作区，不再每上传一篇论文就多一项；工作区标题会作为该专题在论文伴读树里的显示名（重命名工作区后刷新/切回窗口即可看到）。需要旧行为可在 profile 配置 `workspaceScope: paper`。
- **失败如实显示**：空结果、失败、无坐标（「仅定位到页」）都会明确标注。

## 环境

- DeepSeek Harness `0.2.2-rc.1` 或兼容的 0.2.x。
- Node.js `^22.19.0 || >=24`（由 Harness 提供）。
- 普通文本层 PDF 不依赖额外组件。
- **图上标签/扫描件 OCR**：Windows + 简体中文 OCR 语言包。
- **坐标索引**：Python 3.11+ 与 `pymupdf`；缺依赖时仍可转录和按页跳转，但只能「仅定位到页」。

## 安装

### 从 npm（发布后）

```bash
dsh plugin --profile web add dsh-paper-reader-evidence
```

或在桌面端「插件 → 添加插件」里输入包名。

### 从本地包

```bash
dsh plugin --profile web add /path/to/dsh-paper-reader-evidence
```

桌面端也可以把打包后的 `.tgz` 交给插件管理器安装。

### 从源码

```bash
pnpm install
pnpm run build
```

## 使用

1. 打开侧栏底部的「📚 论文伴读」。
2. 新建专题并上传 PDF，或把 PDF 放入 `<dataDir>/<专题>/<文献名>/<文献名>.pdf`。
3. 点论文打开阅读器，在右侧原生对话里提问。
4. 答案中的工坊/设备/图表标签和「总数」句都是可点击证据链接。
5. 点击链接：跳页并框选；缩放后框仍按百分比对齐。
6. 展开答案底部的「查过 P…，取回…条证据，最终引用…处」，查看检索词、扫描页、返回证据和最终引用。

示例问题：`我们有哪些工坊？`

## 数据与缓存

- 文献库默认 `~/.dsh-paper-reader/data`，可在 profile 里配置 `dataDir`。
- 证据索引：`<文献>.evidence.json`，与 PDF 同目录。
- OCR 页图缓存：`.evidence-cache/`（隐藏目录）。
- 工具审计：`<dataDir>/.paper-reader/audit/<sessionId>.jsonl`，按会话和 turn 记录。
- 所有 OCR/索引都在本机完成；插件不会把 PDF 发到外部服务。

## 已知限制

- 证据框以**行级/标签级**为主，另有**整表/整图**块；跨行句子仍只框命中那一行。整表/整图依赖 PDF 版面与 `Table N:` / `Figure N:` 标题，多页表通常只框当前页。
- OCR 依赖 Windows 简体中文语言包；其他平台只能使用文本层。
- 没有可靠坐标时退回页码，并显示「仅定位到页」。
- 查证过程只覆盖本插件 PDF 工具，不记录其他工具或模型内部思考。
- 没有工具调用的回答不会显示过程面板。

## 开发

```bash
pnpm install
pnpm run build
pnpm run typecheck
```

`reader/` 和 `lib/` 是静态资源，`src/` 由 TypeScript 编译到 `dist/`。修改后重新构建并重启 Harness profile。

## License

MIT。原始项目版权归 GGboya；本扩展的修改部分归 Wang。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。


