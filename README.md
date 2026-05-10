# personal-brain

A local-first personal knowledge assistant that lets you search, chat with, and capture ideas from your Obsidian vault. Built with Node.js + Express, vectra (local vector index), and SiliconFlow-hosted embeddings and LLMs.

## What it does

- **Semantic search** over your Markdown notes using BAAI/bge-m3 embeddings
- **Streaming chat** with DeepSeek-V3.2, grounded in your vault content
- **Weekly review** card: auto-summarizes recently modified notes into tags and a reflection question
- **Lab / idea capture**: quickly save fleeting thoughts with optional reminder dates
- **Imaginations**: a dedicated space for longer reflective writing, tied to your ideas
- **Conversation history**: all chats are persisted locally and resumable
- **Auto file watching**: vault changes are re-indexed automatically via chokidar
- **Mobile-friendly UI**: a responsive single-page app served from `public/index.html`, tested on iOS Safari

## Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js + Express 5 |
| Vector index | vectra (local, file-based) |
| Embeddings | BAAI/bge-m3 via SiliconFlow |
| LLM | DeepSeek-V3.2 via SiliconFlow |
| Frontend | Vanilla JS + marked.js (no build step) |

## Prerequisites

- Node.js >= 20.19.0
- A SiliconFlow API key
- An Obsidian vault (or any folder of Markdown files)

## Setup

```bash
git clone <your-repo>
cd personal-brain
npm install
```

Create a `.env` file in the project root:

```env
SILICONFLOW_API_KEY=your_key_here
VAULT_PATH=/absolute/path/to/your/obsidian/vault
INDEX_PATH=/absolute/path/to/store/vector/index
PORT=3000
```

## First-time indexing

Before starting the server, build the vector index:

```bash
npm run index
```

This walks every `.md` file in `VAULT_PATH`, chunks each file into ~500-character blocks, embeds them, and writes the index to `INDEX_PATH`. Depending on vault size this may take a few minutes.

## Running

```bash
npm start
```

Open `http://localhost:3000` in your browser. On subsequent runs the file watcher picks up any vault changes and re-indexes them automatically — no need to run `npm run index` again.

## Project structure

```
personal-brain/
├── public/
│   └── index.html        # Single-page UI
├── src/
│   ├── server.js         # Express routes
│   ├── searcher.js       # Embedding + streaming LLM query
│   ├── indexer.js        # Vault walker and vectra index writer
│   ├── watcher.js        # chokidar file watcher
│   ├── reviewer.js       # Weekly review summary generator (cached 24h)
│   ├── lab.js            # Idea capture and Lab note management
│   ├── imaginations.js   # Imagination note read/write
│   ├── reminders.js      # Simple reminder store (JSON)
│   └── conversations.js  # Conversation persistence (JSON per file)
├── data/                 # Runtime data — gitignored
│   ├── conversations/
│   └── reminders.json
├── cache/                # Review summary cache — gitignored
└── .env                  # Secrets — gitignored
```

## API overview

| Method | Path | Description |
|---|---|---|
| POST | `/api/ask` | SSE streaming chat with RAG |
| GET | `/api/review` | Weekly summary (24h cache) |
| GET/POST | `/api/lab` | List or create Lab ideas |
| PATCH | `/api/lab/:filename/discuss` | Append or remove a Q&A entry |
| POST | `/api/lab/:filename/rewrite` | AI-rewrite note body from conversation |
| GET/POST | `/api/imaginations` | List or create imagination notes |
| PATCH | `/api/imaginations/:filename` | Append essay text to an imagination |
| GET/POST | `/api/conversations` | List or save conversations |
| GET/DELETE | `/api/conversations/:id` | Fetch or delete a conversation |
| GET/POST | `/api/reminders` | List due reminders or create one |
| PATCH | `/api/reminders/:id` | Snooze or mark done |
| POST | `/api/capture` | Quick-save an idea to Lab |
| POST | `/api/save-memory` | Save a Q&A pair to vault as a note |
| GET | `/api/note` | Read any vault note by relative path |
| POST | `/api/reindex` | Trigger a full re-index |

## Notes

- All data (conversations, reminders, cache) is stored locally — nothing leaves your machine except API calls to SiliconFlow.
- The vector index lives at `INDEX_PATH` and is not committed to git.
- The weekly review summary is cached in `cache/review.json` and regenerated when the vault file count changes or the cache is older than 24 hours.
