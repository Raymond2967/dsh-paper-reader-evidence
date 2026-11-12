// audit.ts — append-only verification ledger for the PDF tools.
//
// Only this plugin's tools are recorded.  The Client renders exactly these
// entries and labels the boundary, rather than implying that the model's
// internal reasoning or unrelated tools were observed.

import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const AUDIT_SCOPE_NOTE =
  '记录范围：仅本插件的 PDF 工具（转录、检索、证据查询）。模型内部思考、未调用本插件工具的读取不计入。'

export interface AuditEvidence {
  id: string
  page: number
  text: string
  context?: string
  bbox?: [number, number, number, number] | null
  source?: 'text' | 'ocr' | 'layout'
  kind?: 'line' | 'table' | 'figure'
  label?: string | null
  hasCoords?: boolean
}

export interface AuditEntry {
  v: 1
  sessionId: string
  turn: number
  tool: string
  callId: string
  at: string
  durationMs: number
  kind: 'index' | 'search' | 'read' | 'error'
  query?: string
  args?: Record<string, unknown>
  pagesProcessed?: number[]
  pagesScanned?: number[]
  pagesMatched?: number[]
  ocrPages?: number[]
  evidence?: AuditEvidence[]
  hits?: Array<{ page: number | null; text: string }>
  totalChunks?: number
  pageCount?: number
  chars?: number
  source?: string
  error?: string
  scope: string
}

export interface VerificationPayload {
  sessionId: string
  turn: number
  entries: AuditEntry[]
  scopeNote: string
}

export function auditDir(dataDir: string): string {
  return join(dataDir, '.paper-reader', 'audit')
}

function safeSessionId(value: string): string {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)
}

function auditPath(dataDir: string, sessionId: string): string {
  return join(auditDir(dataDir), `${safeSessionId(sessionId)}.jsonl`)
}

/** Append one JSONL entry; failures are swallowed by callers so tools stay usable. */
export async function appendAudit(dataDir: string, entry: AuditEntry): Promise<void> {
  const dir = auditDir(dataDir)
  await mkdir(dir, { recursive: true })
  await appendFile(auditPath(dataDir, entry.sessionId), JSON.stringify(entry) + '\n', 'utf8')
}

export async function readVerification(dataDir: string, sessionId: string, turn: number): Promise<VerificationPayload> {
  const path = auditPath(dataDir, sessionId)
  const empty: VerificationPayload = { sessionId, turn, entries: [], scopeNote: AUDIT_SCOPE_NOTE }
  if (!existsSync(path)) return empty
  try {
    const info = await stat(path)
    if (info.size > 8 * 1024 * 1024) return empty
    const raw = await readFile(path, 'utf8')
    const entries: AuditEntry[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as AuditEntry
        if (!value || value.v !== 1) continue
        if (Number(value.turn) !== Number(turn)) continue
        entries.push(value)
      } catch { /* a broken line must not hide the rest */ }
    }
    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    return { sessionId, turn, entries, scopeNote: AUDIT_SCOPE_NOTE }
  } catch {
    return empty
  }
}

export function truncate(value: string, limit = 320): string {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

