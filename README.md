<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/hero.svg" alt="Paper Evidence Reader — every claim, back to the page" width="100%"/>
</p>

<p align="center">
  <a href="https://github.com/Raymond2967/dsh-paper-reader-evidence/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Raymond2967/dsh-paper-reader-evidence/actions/workflows/ci.yml/badge.svg"/></a>
  <a href="https://github.com/Raymond2967/dsh-paper-reader-evidence/releases/tag/v1.1.4"><img alt="release 1.1.4" src="https://img.shields.io/badge/release-1.1.4-0f766e"/></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness 0.2.x" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-1d4ed8"/></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-64748b"/></a>
</p>

<p align="center"><sub>CI = GitHub Actions build · release = plugin version · harness = runtime compatibility · MIT = license</sub></p>

<h1 align="center">dsh-paper-reader-evidence</h1>

<p align="center"><strong>Every claim in a paper answer links back to the exact line, table, or figure in the PDF.</strong></p>

This is not just a page number. Each citation carries an evidence ID, page, source text, and normalized box. Click it and the reader jumps to the page and draws the box; every answer also has an expandable verification trail.

> Built on [`@ggboy123/dsh-paper-reader`](https://github.com/GGboya/dsh-paper-reader) v1.12.0 (MIT). The library, reader, translation, notes, and study coach remain; evidence indexing, clickable citations, and the verification panel are new.

## Why

A page number still makes the reader hunt for the right table header or sentence. That is not traceable.

| Ordinary answer | Paper Evidence Reader |
| --- | --- |
| “Table 3 shows Drop is the most expensive (p. 14)” | Click **Table 3** → jump to p14 and box the caption + whole table |
| “Keep has a 2.50× worst case (p. 14)” | Click **2.50×** → box the matching table row/cell |
| “Figure 2 explains the churn effect” | Click **Figure 2** → box the figure + caption |
| Reader checks it manually | Expand **Verification**: pages scanned, queries, returned evidence, final citations |

## Highlights

- **Clickable evidence**: body lines, OCR labels, whole tables, and whole figures can all carry an evidence ID.
- **Zoom-stable boxes**: coordinates are normalized to 0–1 and re-projected onto the actual rendered canvas after zoom, page changes, or re-render.
- **Whole table / whole figure**: `Table N:` and `Figure N:` produce object-level evidence, not a single number.
- **Verification trail**: collapsed by default; shows indexed pages, search terms, returned evidence, final citations, extra reads, failures, and empty results.
- **Current-paper context**: a paper session is bound to a paper via its `dpr-...` session ID, so the model does not guess which paper “this paper” means.
- **Topic-scoped workspaces**: one Harness workspace per topic; the workspace title becomes the topic alias in the paper tree.
- **Honest fallbacks**: no reliable box means a page jump with an explicit “page only” notice; no fake coordinates.

## How it works

```text
PDF
 ├─ text layer ───────────┐
 ├─ OCR (optional) ───────┤
 └─ table/figure layout ──┤
                         ▼
              evidence index: id / page / text / bbox
                         │
question ──► model retrieves evidence ──► citation URL with page + ev
                         │
                         ▼
              reader jumps and draws the box
                         │
                         ▼
              verification trail under the answer
```

The model does not compute coordinates or draw boxes. It selects evidence from tool results and copies the `page` + `ev` URL; the plugin resolves the box and renders it.

## Install

### From source

```bash
git clone https://github.com/Raymond2967/dsh-paper-reader-evidence.git
cd dsh-paper-reader-evidence
pnpm install
pnpm run build
dsh plugin --profile web add .
```

### From a local package

```bash
dsh plugin --profile web add /path/to/dsh-paper-reader-evidence
```

The desktop app can also install a packed `.tgz` through its plugin manager.

### From npm (after release)

```bash
dsh plugin --profile web add dsh-paper-reader-evidence
```

## Use

1. Open **📚 Paper Reader** at the bottom of the sidebar.
2. Create a topic and upload a PDF, or place it at `<dataDir>/<topic>/<name>/<name>.pdf`.
3. Open the paper and ask in the native chat on the right.
4. Click an evidence link: the reader jumps and boxes the source; the box stays aligned after zoom.
5. Expand the summary under the answer: “scanned pages, returned evidence, final citations”.

Example questions:

```text
What is the paper's main contribution?
What does the experiment in Table 3 show?
How should I interpret the trend in Figure 2?
Why do the authors consider Keep insufficient?
How does this paper differ from prior work?
```

For whole-table/whole-figure questions the model prefers object-level evidence; for a single number it uses line/cell evidence.

## Requirements

- DeepSeek Harness `0.2.x` (verified on `0.2.2-rc.1`)
- Node.js `^22.19.0 || >=24` (provided by Harness)
- Plain text-layer PDFs work out of the box
- **OCR labels**: Windows + Simplified Chinese OCR language pack
- **Coordinate index**: Python 3.11+ with `pymupdf`

Without OCR/Python the reader still transcribes, searches, and jumps by page; labels baked into images fall back to “page only”.

## Data and privacy

- Library: `~/.dsh-paper-reader/data`
- Evidence index: `<paper>.evidence.json`
- OCR page cache: `.evidence-cache/`
- Audit ledger: `<dataDir>/.paper-reader/audit/<sessionId>.jsonl`
- OCR, layout detection, and indexing are local; the plugin does not upload PDFs.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-paper-reader-evidence
  name: dsh-paper-reader-evidence
  config:
    dataDir: 'D:\papers'
    # topic (default) = one workspace per topic; paper = one workspace per paper
    workspaceScope: topic
```

## Known limits

- Evidence is primarily line/label level; a wrapped sentence only boxes the matching line.
- Whole-table/whole-figure detection depends on PDF layout and `Table N:` / `Figure N:` captions; borderless tables and uncaptioned figures may fall back to line evidence.
- Multi-page tables usually box only the current page.
- OCR requires Windows and the Simplified Chinese language pack.
- Verification records only this plugin's PDF tools, not internal model reasoning or other tools.
- Answers that use no PDF tools show no verification panel.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
```

`src/` is TypeScript; `lib/`, `reader/`, and `runtime/` are runtime assets. Rebuild and restart the Harness profile after changes.

## License

MIT. Upstream copyright GGboya; modifications copyright Raymond. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

