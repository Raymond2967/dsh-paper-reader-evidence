// dsh-paper-reader — Cordis 插件壳。
// 壳保持薄：agent 循环/模型层交给 dsh 框架，本插件只注册工具和 HTTP 路由。
// 核心逻辑（转录/检索）是 src/ 下不依赖 Cordis 的纯函数模块，方便日后迁移。

import type { Context } from '@deepseek-ai/cordis'
import { registerTools, paperFromSessionId, type PluginConfig } from './tools.ts'
import { registerRoutes } from './host.ts'
import { resolveDataDir, resolvePaper } from './library.ts'

export const name = 'dsh-paper-reader-evidence'

// 等宿主的工具注册服务（ctx.tools）就绪后再运行。
export const inject = ['tools', 'agents']

export function apply(ctx: Context, config: PluginConfig = {}) {
  registerTools(ctx, config)
  console.log(`[dsh-paper-reader-evidence] registered tools: list_papers, transcribe_pdf, search_paper, search_pdf_evidence, open_pdf_evidence, study_progress, study_update`)

  // Evidence-citation contract.  This is a normal prompt section so it also
  // reaches sessions that use the default preset (the optional paper-reader
  // preset carries the same instructions in its persona).
  ctx.inject(['systemPrompt'], (pctx) => {
    pctx.systemPrompt.section({
      name: 'dpr-evidence-citations',
      order: 60,
      text: [
        '【PDF 证据引用工作流】',
        '当当前会话绑定了一篇 PDF，或用户正在阅读器里提问时：',
        '1. 回答任何可核对的事实、名称、数字、图上标签之前，先调用 search_pdf_evidence（query 用原文里的短关键词，如“工坊”“六个工作坊”）。地图、工坊/设备标签、图表标题等图上文字必须用它；search_paper 只能补充上下文，不能替代。',
        '2. 每个可核对项都要写成 Markdown 链接，URL 直接复制证据结果里的 url 字段。不要自己拼 ev 参数，也不要只写“(第 N 页)”纯文本。',
        '3. 名单类问题：每个名称一条证据链接；再单独引用说明总数/完整性的原句（如“六个工作坊”）。同一答案引用多处时逐条给链接。',
        '4. 如果证据的 url 为 null 或 hasCoords=false，就退回只带 page 的阅读器链接，并在文字中明确写“仅定位到页”。',
        '5. 不要在回答里复述工具 JSON 或内部推理；查证过程面板会自动从实际工具调用生成。',
        '6. 找不到证据时如实说没找到，不要编造页码或坐标。',
        '7. 讨论“整个表/整张图/实验结果表”时，优先引用 kind=table/figure 的整表/整图证据；只有单个数值或单元格才引用行级证据。',
      ].join('\n'),
    })

    // A paper-reader session is bound to exactly one paper by its dpr-<base64>
    // session id. The topic-scoped workspace intentionally no longer exposes
    // that identity through cwd, so inject it into model context explicitly.
    // Without this, the model sees a topic folder, opens list_papers/glob and
    // starts guessing which PDF "this paper" means.
    pctx.systemPrompt.context({
      name: 'dpr-current-paper',
      order: 15,
      text: (assembly) => {
        try {
          const agentId = (assembly as unknown as { agent?: { id?: string } }).agent?.id
          const paper = paperFromSessionId(agentId)
          if (!paper) return ''
          const ref = resolvePaper(resolveDataDir(config.dataDir), paper)
          return [
            '【当前绑定论文】',
            `本会话已绑定：《${ref.topic}/${ref.name}》`,
            `PDF：${ref.pdfPath}`,
            '用户说“这篇文章 / 本篇 / 这篇论文”时，默认就是这篇。',
            '不要先用 list_papers、working_directory、glob 或修改时间去猜“哪篇”；这些工具只在用户明确提到另一篇论文时才用。',
            '当前阅读器范围是“本篇”还是“全部”只影响检索范围，不改变“这篇文章”仍指当前绑定论文。',
          ].join('\n')
        } catch {
          return '' // deleted/moved paper or non-paper session: no false binding
        }
      },
    })
  })

  // webServer 是可选服务（web profile 有，headless 没有）：出现时再挂路由。
  // connection/sessionController/workspaceController/workspaceRegistry 同属 web profile（cordis 要求访问前先声明 inject）。
  // agentDefaultModel + llm 用于「全文翻译默认跟随 Harness」：只读当前选择并调用，不写宿主配置。
  ctx.inject(['webServer', 'connection', 'sessionController', 'workspaceController', 'workspaceRegistry', 'agentDefaultModel', 'llm'], (rctx) => {
    registerRoutes(rctx, config)
  })
}
