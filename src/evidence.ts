// evidence.ts — page/line evidence index for the reader bridge.
//
// Coordinates are stored normalized to the rendered page (0..1), so a box
// stays aligned at every zoom level.  Text-layer geometry comes from PyMuPDF;
// raster-only labels come from the optional Windows OCR helper.  A missing
// helper is reported, never guessed.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PaperRef } from './library.ts'

export type EvidenceBox = [number, number, number, number]

export interface EvidenceChar {
  c: string
  b: EvidenceBox
}

export interface EvidenceRecord {
  id: string
  page: number
  text: string
  bbox: EvidenceBox
  chars: EvidenceChar[]
  source: 'text' | 'ocr' | 'layout'
  kind?: 'line' | 'table' | 'figure'
  label?: string
}

export interface EvidencePageMeta {
  page: number
  width: number
  height: number
  textLines: number
  ocrLinesKept: number
}

export interface EvidenceStats {
  pagesProcessed: number[]
  ocrPages: number[]
  textPages: number[]
  recordCount: number
  textRecords: number
  ocrRecords: number
  layoutRecords: number
  tables: number
  figures: number
  source: string
  warnings: Array<{ page: number; message: string }>
}

export interface EvidenceIndex {
  version: number
  documentId: string
  pdfPath: string
  builtAt: string
  pageCount: number
  pages: EvidencePageMeta[]
  records: EvidenceRecord[]
  stats: EvidenceStats
}

export interface EvidenceHit {
  id: string
  page: number
  text: string
  context: string
  bbox: EvidenceBox
  source: 'text' | 'ocr' | 'layout'
  kind: 'line' | 'table' | 'figure'
  label: string | null
  hasCoords: boolean
}

export interface EvidenceSearchResult {
  query: string
  documentId: string
  pageCount: number
  pagesIndexed: number[]
  pagesMatched: number[]
  hits: EvidenceHit[]
  stats: EvidenceStats
  totalMatches: number
}

const NORM_DROP = /[\s\u00ad\-_/\\.,，。、:：;；!?！？'"“”‘’()（）[\]【】{}<>《》〈〉|·•]+/gu
const MAX_INDEX_BYTES = 32 * 1024 * 1024

const buildInFlight = new Map<string, Promise<EvidenceIndex>>()

/** Cache lives beside the PDF so moving/renaming a paper moves its evidence too. */
export function evidenceIndexPath(ref: PaperRef): string {
  return join(dirname(ref.pdfPath), `${ref.name}.evidence.json`)
}

export function evidenceCacheDir(ref: PaperRef): string {
  return join(dirname(ref.pdfPath), '.evidence-cache')
}

function indexFresh(index: EvidenceIndex, ref: PaperRef): boolean {
  try {
    const st = statSync(ref.pdfPath)
    const built = Date.parse(index.builtAt)
    return Number.isFinite(built) && built >= st.mtimeMs - 1000 && index.version === 5 && index.pdfPath === ref.pdfPath
  } catch {
    return false
  }
}

async function readIndex(ref: PaperRef): Promise<EvidenceIndex | null> {
  const path = evidenceIndexPath(ref)
  if (!existsSync(path)) return null
  try {
    const st = statSync(path)
    if (st.size > MAX_INDEX_BYTES) return null
    const parsed = JSON.parse(await readFile(path, 'utf8')) as EvidenceIndex
    if (!parsed || parsed.version !== 5 || !Array.isArray(parsed.records)) return null
    return indexFresh(parsed, ref) ? parsed : null
  } catch {
    return null
  }
}

function helperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'evidence_index.py')
}

function pythonCommand(): string {
  const configured = process.env['DSH_EVIDENCE_PYTHON']?.trim()
  if (configured) return configured
  return process.platform === 'win32' ? 'python' : 'python3'
}

async function runIndexer(ref: PaperRef, signal?: AbortSignal): Promise<EvidenceIndex> {
  const helper = helperPath()
  if (!existsSync(helper)) throw new Error(`证据索引脚本缺失：${helper}`)
  const out = evidenceIndexPath(ref)
  const python = pythonCommand()
  const args = [helper, '--pdf', ref.pdfPath, '--out', out]
  const logDir = join(dirname(out), '.evidence-cache')
  mkdirSync(logDir, { recursive: true })
  const stdoutPath = join(logDir, 'index.stdout.log')
  const stderrPath = join(logDir, 'index.stderr.log')
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    // Use regular files rather than pipes: command sandboxes on Windows deny
    // Node child_process pipe creation (EPERM), while inherited file handles
    // work in both the Host process and the sandboxed test runner.
    let stdoutFd: number
    let stderrFd: number
    try {
      stdoutFd = openSync(stdoutPath, 'w')
      stderrFd = openSync(stderrPath, 'w')
    } catch (error) {
      reject(error)
      return
    }
    let child
    try {
      child = spawn(python, args, {
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      closeSync(stdoutFd)
      closeSync(stderrFd)
      reject(error)
      return
    }
    let settled = false
    const finish = () => {
      try { closeSync(stdoutFd) } catch { /* already closed */ }
      try { closeSync(stderrFd) } catch { /* already closed */ }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      finish()
      reject(new Error('证据索引超时（>180s）。可先只转录文本，稍后重试。'))
    }, 180_000)
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      finish()
      reject(new Error('证据索引已取消'))
    }
    if (signal) signal.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
      reject(new Error(
        `无法启动 Python（${python}）：${error.message}。证据坐标需要 Python + PyMuPDF；` +
        `也可设置 DSH_EVIDENCE_PYTHON 指向可用的 Python。`,
      ))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abort)
      finish()
      const read = (path: string) => {
        try { return readFileSync(path, 'utf8').slice(-20000) } catch { return '' }
      }
      resolve({ code: code ?? -1, stdout: read(stdoutPath), stderr: read(stderrPath) })
    })
  })

  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
  let summary: { ok?: boolean; error?: string } = {}
  try { summary = JSON.parse(line) as { ok?: boolean; error?: string } } catch { /* non-JSON stdout */ }
  if (result.code !== 0 || summary.ok === false) {
    throw new Error(summary.error || result.stderr.trim() || `证据索引失败（退出码 ${result.code}）`)
  }
  const index = JSON.parse(await readFile(out, 'utf8')) as EvidenceIndex
  if (!index || index.version !== 5 || !Array.isArray(index.records)) throw new Error('证据索引格式无效')
  return index
}

/** Build once, reuse across tool calls until the PDF mtime changes. */
export async function ensureEvidenceIndex(ref: PaperRef, opts: { signal?: AbortSignal; force?: boolean } = {}): Promise<EvidenceIndex> {
  if (!opts.force) {
    const cached = await readIndex(ref)
    if (cached) return cached
  }
  const key = `${ref.pdfPath}\0${opts.force ? 'force' : 'auto'}`
  const running = buildInFlight.get(key)
  if (running) return running
  const job = runIndexer(ref, opts.signal)
  buildInFlight.set(key, job)
  try {
    return await job
  } finally {
    buildInFlight.delete(key)
  }
}

export async function readEvidenceIndex(ref: PaperRef): Promise<EvidenceIndex | null> {
  return readIndex(ref)
}

function normalizeChar(char: string): string {
  const normalized = char.normalize('NFKC').toLocaleLowerCase()
  return normalized.replace(NORM_DROP, '')
}

function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeChar(text[i] ?? '')
    if (!piece) continue
    for (const ch of piece) {
      norm += ch
      map.push(i)
    }
  }
  return { norm, map }
}

export function normalizeEvidenceQuery(query: string): string {
  return [...query].map(normalizeChar).join('')
}

function boxUnion(boxes: readonly EvidenceBox[]): EvidenceBox {
  if (!boxes.length) return [0, 0, 0, 0]
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ]
}

function boxForRange(record: EvidenceRecord, start: number, end: number): EvidenceBox {
  const boxes = record.chars.slice(start, end).map((char) => char.b)
  return boxes.length ? boxUnion(boxes) : record.bbox
}

function hasArea(box: EvidenceBox): boolean {
  return box[2] - box[0] > 0.0005 && box[3] - box[1] > 0.0005
}

function hitFromRange(record: EvidenceRecord, start: number, end: number): EvidenceHit {
  const text = record.text.slice(start, end).trim() || record.text.trim()
  const bbox = boxForRange(record, start, end)
  return {
    id: `${record.id}#${start}-${end}`,
    page: record.page,
    text,
    context: record.text.trim(),
    bbox,
    source: record.source,
    kind: record.kind ?? 'line',
    label: record.label ?? null,
    hasCoords: hasArea(bbox),
  }
}

function hitForRecord(record: EvidenceRecord): EvidenceHit {
  return {
    id: record.id,
    page: record.page,
    text: record.text.trim(),
    context: record.text.trim(),
    bbox: record.bbox,
    source: record.source,
    kind: record.kind ?? 'line',
    label: record.label ?? null,
    hasCoords: hasArea(record.bbox),
  }
}

/** Look up a stable evidence id (`<record>` or legacy `<record>#<start>-<end>`). */
export async function lookupEvidence(ref: PaperRef, id: string): Promise<EvidenceHit | null> {
  const index = await ensureEvidenceIndex(ref)
  const raw = String(id || '').trim()
  if (!raw) return null
  const hash = raw.lastIndexOf('#')
  const recordId = hash >= 0 ? raw.slice(0, hash) : raw
  const range = hash >= 0 ? raw.slice(hash + 1) : ''
  const record = index.records.find((candidate) => candidate.id === recordId)
  if (!record) return null
  if (!range) return hitForRecord(record)
  const match = /^(\d+)-(\d+)$/.exec(range)
  if (!match) return hitForRecord(record)
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > record.text.length) {
    return null
  }
  return hitFromRange(record, start, end)
}

/** Search normalized line text and return the exact matched span plus page box. */
export async function searchEvidence(
  ref: PaperRef,
  query: string,
  opts: { k?: number; page?: number; signal?: AbortSignal } = {},
): Promise<EvidenceSearchResult> {
  const index = await ensureEvidenceIndex(ref, opts.signal ? { signal: opts.signal } : {})
  const needle = normalizeEvidenceQuery(query)
  // Chinese workshop labels occur both as “工坊” and in prose as “工作坊”.
  // Treat the two as search variants so one query finds both the map labels and
  // the sentence stating the total, without inventing a second tool call.
  const needles = [...new Set([
    needle,
    needle.includes('工作坊') ? needle.replaceAll('工作坊', '工坊') : '',
    needle.includes('工坊') ? needle.replaceAll('工坊', '工作坊') : '',
  ].filter(Boolean))]
  const k = Math.max(1, Math.min(opts.k ?? 16, 30))
  const hits: Array<EvidenceHit & { score: number }> = []
  let totalMatches = 0
  if (needles.length) {
    for (const record of index.records) {
      if (opts.page && record.page !== opts.page) continue
      const { norm } = normalizeWithMap(record.text)
      if (!norm) continue
      let count = 0
      let score = 0
      for (const part of needles) {
        let from = 0
        let partCount = 0
        for (;;) {
          const at = norm.indexOf(part, from)
          if (at < 0) break
          partCount++
          from = at + Math.max(1, part.length)
        }
        count += partCount
        score += partCount * Math.max(2, part.length)
      }
      if (count > 0) {
        const hit = hitForRecord(record)
        // Whole-table/figure evidence wins ties against the caption line or a
        // single cell; the reader asked for the semantic object, not a value.
        const boost = hit.kind === 'table' || hit.kind === 'figure' ? 20 : 1
        hits.push({ ...hit, score: score * boost })
        totalMatches += count
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.page - b.page || a.bbox[1] - b.bbox[1])
  const selected = hits.slice(0, k).sort((a, b) => b.score - a.score || a.page - b.page || a.bbox[1] - b.bbox[1])
  return {
    query,
    documentId: index.documentId,
    pageCount: index.pageCount,
    pagesIndexed: index.stats.pagesProcessed,
    pagesMatched: [...new Set(selected.map((hit) => hit.page))].sort((a, b) => a - b),
    hits: selected.map(({ score: _score, ...hit }) => hit),
    stats: index.stats,
    totalMatches,
  }
}

export function evidenceDocumentId(ref: PaperRef): string {
  try {
    return createHash('sha256').update(ref.pdfPath).digest('hex').slice(0, 16)
  } catch {
    return 'unknown'
  }
}




