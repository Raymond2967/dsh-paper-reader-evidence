# dsh-paper-reader-evidence

A DeepSeek Harness plugin for evidence-grounded PDF reading. Ask next to the
native PDF reader; names, numbers and labels in the answer are clickable and
jump back to the exact source line, with a verification panel under each answer.

Based on [`@ggboy123/dsh-paper-reader`](https://github.com/GGboya/dsh-paper-reader)
v1.12.0 (MIT). The library, reader, translation, notes and study coach are
retained; the evidence index, clickable citations and verification panel are
new.

## Features

- PDF library and native reader (scroll/paged, zoom, find, notes, translation).
- Evidence IDs with page, text and normalized boxes from the PDF text layer and
  optional Windows OCR labels.
- Click a citation: jump to the page and draw a box; the box stays aligned after
  zoom.
- Collapsible “verification process”: indexed pages, search terms, returned
  evidence, final citations and extra reads. Only this plugin's PDF tools are
  recorded.
- Honest fallbacks: empty results, failures and “page only” evidence are shown.

## Requirements

- DeepSeek Harness 0.2.x.
- Node `^22.19.0 || >=24` (provided by Harness).
- Optional OCR: Windows + Simplified Chinese OCR language pack.
- Optional coordinates: Python 3.11+ with `pymupdf`. Without it, the reader
  still transcribes and jumps by page, but cannot draw boxes.

## Install

```bash
dsh plugin --profile web add dsh-paper-reader-evidence
```

From source:

```bash
pnpm install
pnpm run build
```

## Use

1. Open **📚 Paper Reader** at the bottom of the sidebar.
2. Upload a PDF, or place it at `<dataDir>/<topic>/<name>/<name>.pdf`.
3. Ask a question in the native chat beside the reader.
4. Click any evidence link in the answer to jump and box the source.
5. Expand the verification summary under the answer.

## Data

- Library: `~/.dsh-paper-reader/data` by default.
- Evidence index: `<paper>.evidence.json` beside the PDF.
- OCR cache: `.evidence-cache/`.
- Audit ledger: `<dataDir>/.paper-reader/audit/<sessionId>.jsonl`.
- OCR and indexing are local; the plugin does not upload PDFs.

## Limitations

- Boxes are line/label level, not paragraph level.
- OCR requires Windows and the Chinese language pack.
- Missing coordinates fall back to page-only with a visible notice.
- The panel records only this plugin's PDF tools.

## License

MIT. Upstream copyright GGboya; modifications copyright Wang. See `LICENSE` and
`NOTICE`.
