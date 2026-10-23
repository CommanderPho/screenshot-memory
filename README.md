<div align="center">

# screenshot-memory

<img src="ssm.png" width="600" alt="screenshot-memory">

## Search screenshots by what's in them.

</div>


All your screenshots.

```
Screenshot 2024-01-15 at 10.32.41.png
Screenshot 2024-01-15 at 10.33.02.png
Screenshot 2024-01-14 at 09.15.33.png
...4,844 more
```

Now you can.

```bash
$ ssm find "that stripe error"

Found 1 result · 34ms

1. Screenshot 2024-01-15 at 10.32.41.png · 89%
   "Error: Your card was declined. Insufficient funds."
   2 weeks ago
```

## What is this

A CLI that searches your screenshots by what's *in* them. Text, images, anything.

- **OCR** extracts text from screenshots
- **AI vision** describes photos (local, runs on your machine)
- **Semantic search** finds things by meaning, not just keywords, using a local SQLite index

No cloud. No API keys. Everything runs locally.

## Install

### macOS / Linux

```bash
git clone https://github.com/memvid/screenshot-memory.git
cd screenshot-memory
./setup.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/memvid/screenshot-memory.git
cd screenshot-memory
.\setup.ps1
```

The setup script handles everything - Bun, Ollama, the AI model, all of it.

To uninstall:

```bash
./setup.sh --remove     # macOS/Linux
.\setup.ps1 -Uninstall  # Windows
```

## Try it out

We included sample screenshots to test with:

```bash
# Index the examples
ssm index ./examples

# Search for stuff
ssm find "connection error"
ssm find "stripe"
ssm find "404"
```

## Usage

```bash
# Index your screenshots once
ssm index ~/Screenshots

## Pre-scan to produce a filelist for index to process:
ssm scan "E:\Dropbox (Personal)\Screenshots\ShareX Screenshots" --out 2026-10-07_files.txt --rejected 2026-10-07_rejected.txt
ssm index --files "2026-10-07_files.txt"


# Find stuff
ssm find "kubernetes error"
ssm find "that figma mockup"
ssm find "slack conversation with john"

# Photos work too
ssm find "red car"
ssm find "sunset at the beach"

# Watch for new screenshots
ssm watch
```

### Windows tray (Scan and Index)

On Windows you can keep a tray icon that runs the same scan-then-index flow from a menu:

1. Double-click [`scripts/windows/Start-SsmTray.vbs`](scripts/windows/Start-SsmTray.vbs), or use **Start Menu → screenshot-memory → Scan and Index (tray)** after `setup.ps1`.
2. Right-click the tray icon → **Scan and Index**.
3. A console opens with the live progress bar. **Show Progress** focuses that window (or opens the latest run log). **Open Lists Folder** opens `%LOCALAPPDATA%\screenshot-memory\Data\lists`, where dated `*_files.txt`, `*_rejected.txt`, and `*_run.log` are written.

The scan uses the first directory from your ssm config (same as `ssm scan` with no path). Only one run at a time; Exit is blocked while indexing.

## The photo thing

If you want to search photos by what's in them (not just text), you need Ollama running locally:

```bash
brew install ollama
ollama pull llava-phi3
ollama pull nomic-embed-text # CPU embedding support
ollama pull llama3.2-vision # biggest 7.8GB
ollama serve
```

First search takes ~6 seconds (model loading). After that it's ~1 second.

## Commands

| Command | What it does |
|---------|-------------|
| `ssm index <dir>` | Index screenshots from a directory |
| `ssm find <query>` | Search for screenshots |
| `ssm watch` | Auto-index new screenshots |
| `ssm stats` | Show index info |
| `ssm ocr <image>` | Test OCR on an image |
| `ssm caption <image>` | Test AI description on an image |

## Options

```bash
ssm index ~/Screenshots --force    # Re-index everything
ssm index ~/Screenshots -w 8       # More OCR workers = faster

ssm find "error" --mode lex        # Exact text match
ssm find "error" --mode sem        # Semantic/meaning match
ssm find "error" -k 10             # More results
ssm find "error" --open            # Open first result
ssm find "error" --json            # JSON output
```

## How fast

| What | Time |
|------|------|
| Index 1 screenshot | ~2s |
| Index 1 photo (with AI) | ~1s (warm) / ~6s (cold) |
| Search | <100ms |

"Cold" = first run after starting Ollama. Keep it warm with `OLLAMA_KEEP_ALIVE=3600`.

## How it works

```
Screenshot → OCR → Text ────────────┐
                                    ├→ Embeddings → Index
Photo → AI Vision → Description ────┘
                                          ↓
              Query → Search → Results
```

All stored in a local SQLite file next to your screenshot library: full text, a keyword index, and embeddings.

## Config

Lives at `~/.config/screenshot-memory/config.json`:

```json
{
  "directories": ["~/Screenshots"],
  "ocr": { "workers": 4 },
  "search": { "defaultMode": "auto", "defaultLimit": 5 }
}
```

## Troubleshooting

**"No screenshots indexed"** → Run `ssm index ~/Screenshots` first

**OCR is slow** → Use more workers: `ssm index -w 8`

**No image preview** → `brew install chafa` / `sudo apt install chafa`

**Photos not being described** → Make sure Ollama is running: `ollama serve`

**Semantic index/search failed** → Embeddings come from a local Ollama model. Run `ollama serve`, then `ollama pull nomic-embed-text`. If an existing index was built with a different model, rebuild it with `ssm index --force`.

## License

MIT

---

Search runs locally in SQLite. Nothing is uploaded.
