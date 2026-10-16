# audiobook-butler

Takes your messy audiobook downloads and shelves them like a proper librarian:
correct metadata, proper tags, series-organized folders, ready for
[Audiobookshelf](https://www.audiobookshelf.org/).

```
qBittorrent (on-download hook)  →  butler.js  →  Author/Series/## - Title/  →  Audiobookshelf
```

Zero npm dependencies. One file. Bring your own Ollama.

## Why this instead of m4b-tool / beets / FileBot?

Those tools parse filenames with regex and hope. Butler runs a **metadata
cascade** instead:

1. **ASIN in the filename?** Straight to the [Audnexus](https://audnex.us/) API.
2. **No ASIN?** A local LLM (Qwen via Ollama) reads the filename, the
   qBittorrent torrent name, any NFO, and the existing audio tags, and emits
   structured metadata (title, author, series, book number, narrator).
3. **Fast path:** filenames already in `Series - ## - Title` format skip the
   LLM entirely — the regex doesn't lie.
4. **Enrichment:** Audnexus → iTunes Search → Google Books fill in cover art,
   description, genres, year.
5. **Multi-book detection:** one download folder with ten books in it gets
   split into ten properly-shelved books.

Every step degrades gracefully. No Ollama running? The fast path and the
public APIs still work. No API keys? The LLM and filename parsing still work.

## Requirements

- Node.js 18+
- `exiftool` (tags m4b/m4a) and `mid3v2` from `python-mutagen` (tags mp3)
- Optional: [Ollama](https://ollama.ai/) with any instruct model
  (`qwen2.5:14b` is the tested default; smaller models work for easy names)
- Optional: Google Books API key (higher rate limits for enrichment)

## Quick start

```bash
cp .env.example .env        # fill in your paths
node butler.js --dry-run --batch /path/to/downloads
```

`--dry-run` resolves everything and prints the shelving plan without writing
a single file. When the plan looks right:

```bash
node butler.js --batch /path/to/downloads
```

Result:

```
library/
└── Matt Dinniman/
    └── Dungeon Crawler Carl/
        └── 01 - Dungeon Crawler Carl/
            ├── 01 - Dungeon Crawler Carl.m4b
            └── cover.jpg
```

## qBittorrent hook

qBittorrent → Options → Downloads → "Run external program on torrent
completion":

```
node /path/to/butler.js --batch "%F"
```

Butler also reads the torrent name and file list from the qBittorrent API as
extra metadata context (set `QB_URL`, `QB_USER`, `QB_PASS`).

## Configuration

Everything is an environment variable (see `.env.example`):

| Variable | Default | What |
|---|---|---|
| `AUDIOBOOK_LIB_DIR` | `./library` | Where shelved books land |
| `LOG_FILE_PATH` | `./butler.log` | Log file |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:14b` | Model for metadata extraction |
| `QB_URL` / `QB_USER` / `QB_PASS` | `http://127.0.0.1:8080` | qBittorrent for torrent context |
| `GOOGLE_BOOKS_API_KEY` | *(empty)* | Enrichment rate limits |
| `EXIFTOOL_PATH` | `exiftool` | Tag writer for m4b/m4a |

Flags: `--batch <dir>` (or `--dir`, `--torrent`), `--force` (reprocess
already-shelved books), `--dry-run` (plan only, write nothing).

Processed folders get a `.abs-processed` manifest so reruns skip finished
books unless `--force` is given. Files are staged through the local temp dir
before tagging, so the source and library mounts are never modified in place.

## License

MIT — see [LICENSE](LICENSE).
