# personal-brain

A local-first personal knowledge assistant that lets you search, chat with, and capture ideas from your Obsidian vault — plus a separate PWA interface for family. Built with Node.js + Express, vectra (local vector index), and SiliconFlow-hosted embeddings and LLMs.

## What it does

- **Semantic search** over your Markdown notes using BAAI/bge-m3 embeddings
- **Streaming chat** with DeepSeek-V3, grounded in your vault content
- **Web search augmentation**: optionally enriches answers with live Tavily results
- **File upload**: attach PDFs and images to a chat query for multimodal context
- **Weekly review** card: auto-summarizes recently modified notes into tags and a reflection question
- **Lab / idea capture**: quickly save fleeting thoughts with optional reminder dates
- **Imaginations**: a dedicated space for longer reflective writing, tied to your ideas
- **Conversation history**: all chats are persisted locally and resumable
- **Auto file watching**: vault changes are re-indexed automatically via chokidar
- **Mom PWA** (`/mom`): a separate installable interface for family — shows your status card, activity heatmap, recent public notes, and a milestone countdown; only surfaces notes with `public: true` in frontmatter, backed by a separate vector index
- **Mobile-friendly UI**: responsive single-page app served from `public/index.html`, tested on iOS Safari

## Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js + Express 5 |
| Vector index | vectra (local, file-based) |
| Embeddings | BAAI/bge-m3 via SiliconFlow |
| LLM | DeepSeek-V3 via SiliconFlow |
| Web search | Tavily Search API (optional) |
| Frontend | Vanilla JS + marked.js (no build step) |
| Mom PWA | Vanilla JS + Service Worker |

## Prerequisites

- Node.js >= 20.19.0
- A SiliconFlow API key
- An Obsidian vault (or any folder of Markdown files)
- A Tavily API key (optional — only needed for web search)

## Setup

```bash
git clone <your-repo>
cd personal-brain
npm install
```

Copy the persona template and fill in your own context:

```bash
cp persona.example.md persona.md
# then edit persona.md — describe who you are, your projects, preferred tone, etc.
```

Create a `.env` file in the project root:

```env
SILICONFLOW_API_KEY=your_key_here
VAULT_PATH=/absolute/path/to/your/obsidian/vault
INDEX_PATH=/absolute/path/to/store/vector/index

# Mom PWA (optional)
MOM_INDEX_PATH=/absolute/path/to/store/mom-vector-index
MOM_EXCLUDED_FOLDERS=private,journal   # comma-separated folders to skip when building mom index

# Web search (optional)
TAVILY_API_KEY=your_tavily_key_here

PORT=3000
```

## First-time indexing

Before starting the server, build the vector index:

```bash
npm run index
```

This walks every `.md` file in `VAULT_PATH`, chunks each file into ~500-character blocks, embeds them, and writes the index to `INDEX_PATH`. Depending on vault size this may take a few minutes.

If you're using the Mom PWA, trigger the mom index via the API after the server is running:

```bash
curl -X POST http://localhost:3000/api/mom-reindex
```

Or use the `/api/mom-reindex` button in the mom debug panel.

## Running

```bash
npm start
```

Open `http://localhost:3000` in your browser. On subsequent runs the file watcher picks up any vault changes and re-indexes them automatically — no need to run `npm run index` again.

The Mom PWA is at `http://localhost:3000/mom` — installable on iOS/Android via "Add to Home Screen."

## Mom PWA: public notes

Notes are visible to mom only when their frontmatter contains:

```yaml
---
public: true
---
```

All other notes are excluded from the mom index. Folders listed in `MOM_EXCLUDED_FOLDERS` are skipped entirely regardless of frontmatter.

## Project structure

```
personal-brain/
├── public/
│   ├── index.html            # Main single-page UI
│   └── mom/
│       ├── index.html        # Mom PWA shell
│       ├── manifest.json     # PWA manifest
│       └── sw.js             # Service worker
├── src/
│   ├── server.js             # Express routes
│   ├── searcher.js           # Embedding + streaming LLM query
│   ├── indexer.js            # Vault walker and vectra index writer
│   ├── mom-indexer.js        # Public-notes-only index for mom
│   ├── web-search.js         # Tavily web search helper
│   ├── watcher.js            # chokidar file watcher
│   ├── reviewer.js           # Weekly review summary generator (cached 24h)
│   ├── lab.js                # Idea capture and Lab note management
│   ├── imaginations.js       # Imagination note read/write
│   ├── reminders.js          # Simple reminder store (JSON)
│   └── conversations.js      # Conversation persistence (JSON per file)
├── persona.example.md        # Persona template — copy to persona.md and fill in
├── persona.md                # Your persona and rules — gitignored, loaded at startup
├── data/                     # Runtime data — gitignored
│   ├── conversations/
│   └── reminders.json
├── cache/                    # Review summary cache — gitignored
├── mom-index/                # Mom vector index — gitignored, built via /api/mom-reindex
└── .env                      # Secrets — gitignored
```

## API overview

### Core

| Method | Path | Description |
|---|---|---|
| POST | `/api/ask` | SSE streaming chat with RAG |
| POST | `/api/ask-with-file` | Chat with attached PDF/image files |
| GET | `/api/review` | Weekly summary (24h cache) |
| POST | `/api/reindex` | Trigger a full re-index |
| GET | `/api/status` | Server + index health |
| GET | `/api/health` | Detailed health check |

### Lab & ideas

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/lab` | List or create Lab ideas |
| GET | `/api/lab/:filename` | Fetch a single Lab note |
| PATCH | `/api/lab/:filename/discuss` | Append or remove a Q&A entry |
| POST | `/api/lab/:filename/rewrite` | AI-rewrite note body from conversation |
| PATCH | `/api/lab/:filename/move` | Move note to a different folder |
| DELETE | `/api/lab/:filename` | Delete a Lab note |
| GET/POST | `/api/lab-folders` | List or create Lab folders |

### Imaginations & conversations

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/imaginations` | List or create imagination notes |
| GET | `/api/imaginations/:filename` | Fetch one imagination note |
| PATCH | `/api/imaginations/:filename` | Append essay text |
| GET/POST | `/api/conversations` | List or save conversations |
| GET/DELETE | `/api/conversations/:id` | Fetch or delete a conversation |

### Reminders & notes

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/reminders` | List due reminders or create one |
| PATCH | `/api/reminders/:id` | Snooze or mark done |
| DELETE | `/api/reminders/:id` | Delete a reminder |
| GET | `/api/note` | Read any vault note by relative path |
| POST | `/api/capture` | Quick-save an idea to Lab |
| POST | `/api/save-memory` | Save a Q&A pair to vault as a note |

### Mom PWA

| Method | Path | Description |
|---|---|---|
| GET | `/api/mom-status` | Read Zia's current status card |
| POST | `/api/mom-status` | Update the status card |
| GET | `/api/mom-activity` | Activity heatmap data |
| GET | `/api/mom-notes` | Recent public notes |
| GET | `/api/mom-milestones` | Countdown milestones |
| POST | `/api/mom-reindex` | Rebuild the mom vector index |
| POST | `/api/mom-ask` | SSE streaming chat grounded in public notes |
| GET | `/api/mom-health` | Mom index health check |
| GET | `/api/mom-debug` | Request log (debug) |

## Importing from Claude (optional)

If you want to import your [Claude.ai conversation history](https://support.anthropic.com/en/articles/8914208-how-do-i-export-my-claude-ai-data) into the vault, use the one-time migration script:

1. Request a data export from Claude.ai and download the zip file.
2. Add the path to your `.env`:

```env
CLAUDE_EXPORT_DIR=/absolute/path/to/extracted/export-folder
```

3. Run the import:

```bash
node src/import-claude.js
```

This reads `memories.json`, `conversations.json`, and any `projects/` from the export, writes them as Markdown notes into `<VAULT_PATH>/claude-import/`, then triggers a full re-index. The script is idempotent — safe to run again if you get a newer export.

## Notes

- All data (conversations, reminders, cache) is stored locally — nothing leaves your machine except API calls to SiliconFlow and (optionally) Tavily.
- The vector index lives at `INDEX_PATH` and is not committed to git. The mom index lives at `MOM_INDEX_PATH` (default: `./mom-index/`).
- The weekly review summary is cached in `cache/review.json` and regenerated when the vault file count changes or the cache is older than 24 hours.
