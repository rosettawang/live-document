/**
 * DocRoom — one Durable Object per document.
 *
 * Holds the blocks (SQLite), every live WebSocket, and the only writer. Because
 * all writes funnel through one object, there is no second writer to race with
 * and no distributed-lock problem to solve — which is most of why the design in
 * specs/live-doc-core.html is buildable in an afternoon rather than a week.
 */

import { sanitize } from "./sanitize";
import { edit, type Op } from "./claude";
import SEED_ICELAND from "../seed/iceland.json";
import SEED_PACKING from "../seed/packing.json";

type SeedBlock = { id: string; section: string; html: string; layout: string | null };

/** One Durable Object per document; each seeds itself from its own export. */
const SEEDS: Record<string, SeedBlock[]> = {
  iceland: SEED_ICELAND as SeedBlock[],
  packing: SEED_PACKING as SeedBlock[],
};

export interface Env {
  DOC: DurableObjectNamespace;
  ASSETS: Fetcher;
  DOC_PASSCODE: string;
  ANTHROPIC_API_KEY: string;
}

interface BlockRow {
  /** SqlStorage's generic wants an index signature; every field below fits it. */
  [key: string]: SqlStorageValue;
  id: string;
  section: string;
  ord: number;
  html: string;
  /** "grid2" for the side-by-side cards; null otherwise. Layout the client re-wraps. */
  layout: string | null;
  rev: number;
  updated_at: number;
  updated_by: string | null;
}

/** AI calls per person per day. A leaked link should cost embarrassment, not an unbounded bill. */
const AI_DAILY_LIMIT = 30;

export class DocRoom implements DurableObject {
  private sql: SqlStorage;

  constructor(private ctx: DurableObjectState, private env: Env) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id          TEXT PRIMARY KEY,
        section     TEXT NOT NULL,
        ord         REAL NOT NULL,
        html        TEXT NOT NULL,
        layout      TEXT,
        rev         INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        updated_by  TEXT
      );
      CREATE INDEX IF NOT EXISTS blocks_section_ord ON blocks(section, ord);

      CREATE TABLE IF NOT EXISTS history (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id  TEXT NOT NULL,
        section   TEXT,
        ord       REAL,
        layout    TEXT,
        prev_html TEXT,
        kind      TEXT NOT NULL,
        at        INTEGER NOT NULL,
        by        TEXT
      );
      CREATE INDEX IF NOT EXISTS history_at ON history(at DESC);

      CREATE TABLE IF NOT EXISTS ai_usage (
        who   TEXT NOT NULL,
        day   TEXT NOT NULL,
        n     INTEGER NOT NULL,
        PRIMARY KEY (who, day)
      );
    `);
  }

  // ---------------------------------------------------------------- routing

  /**
   * First-run import. The seed lives in the bundle rather than behind an admin
   * endpoint so there is no manual step and no second secret to hand around —
   * and it fires only into an empty document, which is the guard that matters:
   * re-running a seed over eleven days of real planning is the one way to lose
   * work here that nothing else can undo.
   */
  private async ensureSeeded(docSlug: string) {
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM blocks").toArray()[0].n;
    if (n > 0) return;
    await this.seedFrom(SEEDS[docSlug] ?? []);
  }

  private async seedFrom(rows: SeedBlock[]) {
    const now = Date.now();
    let i = 0;
    for (const b of rows) {
      const clean = await sanitize(b.html);
      if (!clean) continue;
      this.sql.exec(
        "INSERT OR REPLACE INTO blocks (id, section, ord, html, layout, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, 'the original plan')",
        b.id,
        b.section,
        ++i,
        clean,
        b.layout ?? null,
        now,
      );
    }
    return i;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const who = request.headers.get("X-Who") || "someone";
    const docSlug = request.headers.get("X-Doc") || "iceland";
    await this.ensureSeeded(docSlug);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      // Hibernation: four friends will leave this tab open for eleven days
      // across two continents. acceptWebSocket lets the DO evict from memory
      // while the sockets stay open, so idle cost is the storage rows rather
      // than wall-clock duration billing for a document nobody is touching.
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ who });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    switch (url.pathname) {
      case "/api/seed":
        return this.handleSeed(request);
      case "/api/chat":
        return this.handleAI(request, who, false);
      case "/api/comment":
        return this.handleAI(request, who, true);
      case "/api/undo":
        return this.handleUndo(who);
      case "/api/export":
        return this.handleExport();
      default:
        return new Response("not found", { status: 404 });
    }
  }

  // ------------------------------------------------------------- websockets

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;

    const who = (ws.deserializeAttachment()?.who as string) ?? "someone";
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      switch (msg.t) {
        case "hello":
          ws.send(JSON.stringify({ t: "sync", blocks: this.allBlocks(), you: who }));
          this.broadcastPresence();
          break;

        case "edit": {
          const applied = await this.applyEdit(msg.id, msg.html, msg.baseRev, who);
          if (applied === "stale") {
            const cur = this.getBlock(msg.id);
            ws.send(JSON.stringify({ t: "reject", id: msg.id, rev: cur?.rev, html: cur?.html }));
          }
          break;
        }

        case "insert":
          await this.applyInsert(msg.section, msg.afterId ?? null, msg.html ?? "<p><br></p>", who);
          break;

        case "delete":
          this.applyDelete(msg.id, who);
          break;

        case "move":
          this.applyMove(msg.id, msg.section, msg.afterId ?? null, who);
          break;

        case "ping":
          ws.send(JSON.stringify({ t: "pong" }));
          break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ t: "error", message: String(err) }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket) {
    this.broadcastPresence();
  }

  private broadcast(payload: unknown, except?: WebSocket) {
    const s = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(s);
      } catch {
        /* socket is going away; close handler will tidy up */
      }
    }
  }

  private broadcastPresence() {
    const here = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment()?.who;
      if (who) here.add(who as string);
    }
    this.broadcast({ t: "presence", here: [...here] });
  }

  // ----------------------------------------------------------------- blocks

  private allBlocks(): BlockRow[] {
    return this.sql
      .exec<BlockRow>("SELECT * FROM blocks ORDER BY section, ord")
      .toArray();
  }

  private getBlock(id: string): BlockRow | null {
    return this.sql.exec<BlockRow>("SELECT * FROM blocks WHERE id = ?", id).toArray()[0] ?? null;
  }

  /**
   * Fractional index. Inserting between 3.0 and 4.0 writes 3.5 — one INSERT,
   * no other row moves, so no broadcast storm and no race with whoever is
   * editing the rows below.
   */
  private ordAfter(section: string, afterId: string | null): number {
    const rows = this.sql
      .exec<{ ord: number; id: string }>(
        "SELECT id, ord FROM blocks WHERE section = ? ORDER BY ord",
        section,
      )
      .toArray();

    if (afterId === null) return rows.length ? rows[0].ord - 1 : 1;

    const i = rows.findIndex((r) => r.id === afterId);
    if (i === -1) return (rows.at(-1)?.ord ?? 0) + 1;
    if (i === rows.length - 1) return rows[i].ord + 1;
    return (rows[i].ord + rows[i + 1].ord) / 2;
  }

  private newId(section: string): string {
    return `${section}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private logHistory(kind: string, b: BlockRow | null, who: string, id?: string) {
    this.sql.exec(
      "INSERT INTO history (block_id, section, ord, layout, prev_html, kind, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      b?.id ?? id ?? "",
      b?.section ?? null,
      b?.ord ?? null,
      b?.layout ?? null,
      b?.html ?? null,
      kind,
      Date.now(),
      who,
    );
  }

  /**
   * Compare-and-set on rev. Last-write-wins would be simpler and is not
   * acceptable here: the AI paths rewrite whole blocks, so a silent overwrite
   * of someone's typing by a rewrite computed against a two-minute-old version
   * is exactly the failure that makes people stop trusting a shared document.
   */
  private async applyEdit(
    id: string,
    html: string,
    baseRev: number,
    who: string,
  ): Promise<"ok" | "stale" | "gone"> {
    const cur = this.getBlock(id);
    if (!cur) return "gone";
    if (baseRev !== undefined && baseRev !== null && cur.rev !== baseRev) return "stale";

    const clean = await sanitize(html);
    if (clean === cur.html) return "ok";

    this.logHistory("edit", cur, who);
    const rev = cur.rev + 1;
    this.sql.exec(
      "UPDATE blocks SET html = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      clean,
      rev,
      Date.now(),
      who,
      id,
    );
    this.broadcast({
      t: "block",
      id,
      html: clean,
      section: cur.section,
      ord: cur.ord,
      layout: cur.layout,
      rev,
      by: who,
    });
    return "ok";
  }

  private async applyInsert(
    section: string,
    afterId: string | null,
    html: string,
    who: string,
    forceId?: string,
  ): Promise<string> {
    const id = forceId ?? this.newId(section);
    const ord = this.ordAfter(section, afterId);
    const clean = await sanitize(html);
    const now = Date.now();

    this.sql.exec(
      "INSERT INTO blocks (id, section, ord, html, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)",
      id,
      section,
      ord,
      clean,
      now,
      who,
    );
    this.logHistory("insert", null, who, id);
    this.broadcast({ t: "block", id, html: clean, section, ord, layout: null, rev: 1, by: who, isNew: true });
    return id;
  }

  private applyDelete(id: string, who: string) {
    const cur = this.getBlock(id);
    if (!cur) return;
    this.logHistory("delete", cur, who);
    this.sql.exec("DELETE FROM blocks WHERE id = ?", id);
    this.broadcast({ t: "gone", id, by: who });
  }

  private applyMove(id: string, section: string, afterId: string | null, who: string) {
    const cur = this.getBlock(id);
    if (!cur) return;
    const ord = this.ordAfter(section, afterId);
    this.logHistory("move", cur, who);
    this.sql.exec(
      "UPDATE blocks SET section = ?, ord = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      section,
      ord,
      Date.now(),
      who,
      id,
    );
    this.broadcast({ t: "moved", id, section, ord, by: who });
  }

  // --------------------------------------------------------------- undo

  private async handleUndo(who: string): Promise<Response> {
    const last = this.sql
      .exec<{
        seq: number;
        block_id: string;
        section: string;
        ord: number;
        layout: string | null;
        prev_html: string;
        kind: string;
      }>("SELECT * FROM history ORDER BY seq DESC LIMIT 1")
      .toArray()[0];

    if (!last) return Response.json({ ok: false, message: "Nothing to undo." });

    if (last.kind === "delete") {
      this.sql.exec(
        "INSERT INTO blocks (id, section, ord, html, layout, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        last.block_id,
        last.section,
        last.ord,
        last.prev_html,
        last.layout,
        Date.now(),
        who,
      );
      this.broadcast({
        t: "block",
        id: last.block_id,
        html: last.prev_html,
        section: last.section,
        ord: last.ord,
        layout: last.layout,
        rev: 1,
        by: who,
        isNew: true,
      });
    } else if (last.kind === "insert") {
      this.sql.exec("DELETE FROM blocks WHERE id = ?", last.block_id);
      this.broadcast({ t: "gone", id: last.block_id, by: who });
    } else if (last.kind === "edit" || last.kind === "move") {
      const cur = this.getBlock(last.block_id);
      if (cur) {
        const rev = cur.rev + 1;
        this.sql.exec(
          "UPDATE blocks SET html = ?, section = ?, ord = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?",
          last.prev_html,
          last.section,
          last.ord,
          rev,
          Date.now(),
          who,
          last.block_id,
        );
        this.broadcast({
          t: "block",
          id: last.block_id,
          html: last.prev_html,
          section: last.section,
          ord: last.ord,
          rev,
          by: who,
        });
      }
    }

    this.sql.exec("DELETE FROM history WHERE seq = ?", last.seq);
    return Response.json({ ok: true, kind: last.kind });
  }

  // ---------------------------------------------------------------- AI path

  private aiBudgetLeft(who: string): number {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.sql
      .exec<{ n: number }>("SELECT n FROM ai_usage WHERE who = ? AND day = ?", who, day)
      .toArray()[0];
    return AI_DAILY_LIMIT - (row?.n ?? 0);
  }

  private spendAI(who: string) {
    const day = new Date().toISOString().slice(0, 10);
    this.sql.exec(
      "INSERT INTO ai_usage (who, day, n) VALUES (?, ?, 1) ON CONFLICT(who, day) DO UPDATE SET n = n + 1",
      who,
      day,
    );
  }

  private async handleAI(request: Request, who: string, isComment: boolean): Promise<Response> {
    if (!this.env.ANTHROPIC_API_KEY) {
      return Response.json({
        reply:
          "No Anthropic API key is set on this Worker yet, so I can't edit anything. Direct editing still works — click any line.",
        ops: [],
      });
    }

    const left = this.aiBudgetLeft(who);
    if (left <= 0) {
      return Response.json({
        reply: `That's ${AI_DAILY_LIMIT} AI edits today for ${who} — the daily cap. Direct editing still works, and the cap resets at midnight UTC.`,
        ops: [],
      });
    }

    const body = (await request.json()) as { instruction: string; blockId?: string };
    const instruction = (body.instruction ?? "").slice(0, 4000).trim();
    if (!instruction) return Response.json({ reply: "Nothing to do.", ops: [] });

    const blocks = this.allBlocks();

    // Outline is always the whole document, so Claude can target an insert into
    // a section it isn't editing. Context is scoped: a hover comment only needs
    // its own section, which keeps that path roughly a tenth the cost of chat.
    const outline = this.buildOutline(blocks);
    const focus = body.blockId ? blocks.find((b) => b.id === body.blockId) : undefined;
    const visible =
      isComment && focus ? blocks.filter((b) => b.section === focus.section) : blocks;
    const context = visible
      .map((b) => `<!-- block id="${b.id}" section="${b.section}" -->\n${b.html}`)
      .join("\n\n");

    this.spendAI(who);

    let result;
    try {
      result = await edit({
        apiKey: this.env.ANTHROPIC_API_KEY,
        instruction,
        outline,
        context,
        who,
        focusId: focus?.id,
      });
    } catch (err) {
      return Response.json({
        reply: `Claude call failed: ${String(err).slice(0, 200)}`,
        ops: [],
      });
    }

    const applied = await this.applyOps(result.ops, "claude");
    return Response.json({ reply: result.reply, applied, budgetLeft: left - 1 });
  }

  private buildOutline(blocks: BlockRow[]): string {
    const bySection = new Map<string, BlockRow[]>();
    for (const b of blocks) {
      if (!bySection.has(b.section)) bySection.set(b.section, []);
      bySection.get(b.section)!.push(b);
    }
    return [...bySection.entries()]
      .map(([section, rows]) => {
        const lines = rows.map((r) => {
          const text = r.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
          return `  - ${r.id}: ${text}`;
        });
        return `### ${section}\n${lines.join("\n")}`;
      })
      .join("\n\n");
  }

  private async applyOps(ops: Op[], who: string): Promise<number> {
    let n = 0;
    for (const op of ops.slice(0, 40)) {
      try {
        if (op.op === "replace") {
          const cur = this.getBlock(op.id);
          if (!cur) continue;
          // Claude's ops carry no baseRev — they were computed against whatever
          // the DO held a few seconds ago. Passing the current rev makes the
          // write unconditional on purpose: the alternative is an AI edit that
          // silently no-ops because someone fixed a typo mid-request.
          await this.applyEdit(op.id, op.html, cur.rev, who);
        } else if (op.op === "insert") {
          await this.applyInsert(op.section, op.afterId, op.html, who);
        } else if (op.op === "delete") {
          this.applyDelete(op.id, who);
        } else if (op.op === "move") {
          this.applyMove(op.id, op.section, op.afterId, who);
        }
        n++;
      } catch {
        /* one bad op shouldn't sink the rest */
      }
    }
    return n;
  }

  // ------------------------------------------------------------------ seed

  private async handleSeed(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      blocks: { id: string; section: string; html: string }[];
      force?: boolean;
    };

    const existing = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM blocks").toArray()[0].n;

    // The single most likely way to lose real planning work in this project is
    // re-running the seed over a document four people have been editing.
    // Hard guard in code, not a note in a README.
    if (existing > 0 && !body.force) {
      return Response.json(
        { ok: false, message: `Refusing to seed: ${existing} blocks already exist. Pass force to overwrite.` },
        { status: 409 },
      );
    }

    this.sql.exec("DELETE FROM blocks");
    this.sql.exec("DELETE FROM history");

    const docSlug = request.headers.get("X-Doc") || "iceland";
    const seeded = await this.seedFrom((body.blocks as SeedBlock[]) ?? SEEDS[docSlug] ?? []);
    this.broadcast({ t: "sync", blocks: this.allBlocks() });
    return Response.json({ ok: true, seeded });
  }

  private handleExport(): Response {
    const blocks = this.allBlocks();
    return Response.json({ blocks, exportedAt: new Date().toISOString() });
  }
}
