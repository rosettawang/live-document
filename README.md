# Live document

Turns a static HTML document into one a small group can edit together — directly,
or by asking Claude to change it.

Built in a day for four friends planning a trip to Iceland for the August 2026
total eclipse, three days before they flew. That deadline shaped every trade-off
in here, and the [`specs/`](specs/index.html) folder says so out loud.

## What it does

Three ways to change the page, one operation underneath — *replace a block*:

- **Click the text and type.** No edit mode, no save button.
- **Hover any block, leave a comment.** "too expensive — find something cheaper".
  Claude rewrites that block.
- **Ask in a chat panel.** For adding things that don't exist yet.

Everything lands for everyone over one WebSocket, with presence, attribution and
undo. There is no build step for the client and no framework.

## How it works

A Cloudflare Worker with one **Durable Object per document**. The DO holds the
blocks in SQLite, owns every WebSocket, and is the only writer — so writes are
serialised by construction and there is no distributed-lock problem to solve.

The document is an **ordered list of blocks**, one per top-level element. Two
people editing different blocks never conflict, which is what buys the right to
skip CRDTs. Same-block collisions are caught by a compare-and-set on a revision
counter and surfaced as *keep mine / keep theirs* — never silently resolved.

Both AI paths share one contract: Claude returns block operations
(`replace` / `insert` / `delete` / `move`) via structured output, and never sees
or writes the whole document. Its system prompt carries the page's house style
and one rule that matters more than the rest — **never invent a fact**.

```
src/index.ts    gate, routing, multiple documents
src/room.ts     DocRoom — blocks, sockets, history, AI endpoints
src/claude.ts   the editing contract
src/sanitize.ts HTMLRewriter allowlist, applied on the way in
src/auth.ts     name gate + signed cookie
public/         client, styles, sign-in page
scripts/        source document → live shell + seed blocks
specs/          why it is built this way
```

## Running it

```bash
npm install
npm run build:shell     # source documents → public/*.html + seed/*.json
npx wrangler secret put DOC_PASSCODE       # "Name:match" pairs, comma separated
npx wrangler secret put ANTHROPIC_API_KEY  # optional; without it, direct editing still works
npm run deploy
```

**The source documents are not in this repo** — they held four people's flight
numbers. `build:shell` reads whatever you list in its `DOCS` array and emits a
shell plus a seed file per document; point it at your own HTML. Any page built
from `<details class="sec">` sections works.

Each Durable Object imports its seed **only into an empty document**, so a
rebuild can never overwrite live edits — and equally can't be used to push one.

## Notes worth keeping

A few things that cost real time to find:

- **Declaring a `routes` entry silently disables `workers.dev`.** For a few
  minutes there was no working URL at all. `"workers_dev": true` keeps the
  fallback alive.
- **Rotating the passcode secret invalidates every cookie**, and a page whose
  socket retries against gate HTML looks alive forever. API and socket paths
  return 401 and the client turns that into a visible "signed out".
- **Assets need content hashes.** A fixed `app.js` deployed while a browser kept
  running the old one. The shell links `app.js?v=<hash>`.
- The gate is deliberately weak — a name, prefix-matched. It stops crawlers, not
  friends. [`specs/access-and-identity.html`](specs/access-and-identity.html)
  covers the round trip through the stricter alternative and why it lost.

## Licence

MIT.
