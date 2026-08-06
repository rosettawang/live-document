/**
 * Turns the original static pages into (a) live shells and (b) seed blocks.
 *
 * Two documents live on one site:
 *   /          the trip plan       (iceland-eclipse-2026.html)
 *   /packing   the packing list    (packing/packing-list.html)
 *
 * The chrome — hero, sticky section bar, all the CSS, the footer — is lifted
 * verbatim so the live pages look identical to the ones Rosetta already made.
 * Only the section bodies become editable blocks.
 *
 * Run:  npm run build:shell
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const DOCS = [
  {
    slug: "iceland",
    src: "iceland-eclipse-2026.html",
    out: "index.html",
    /** Link to the sibling document, dropped into the sticky section bar. */
    sibling: { href: "/packing", label: "Packing list →" },
  },
  {
    slug: "packing",
    src: "packing/packing-list.html",
    out: "packing.html",
    sibling: { href: "/", label: "← Trip plan" },
  },
];

const EDITOR_UI = `
<!-- ===================== live-document surface ===================== -->
<div id="statusbar" aria-live="polite">
  <span class="dot" id="conn" title="connection"></span>
  <span id="whoami">{{WHO}}</span>
  <span class="sep">·</span>
  <span id="presence"></span>
  <span class="spacer"></span>
  <button type="button" id="undoBtn" title="Undo the last change by anyone">Undo</button>
  <a href="/signout" id="signout">sign out</a>
</div>

<div id="blockmenu" hidden>
  <button type="button" data-act="comment" title="Ask Claude to change this">💬</button>
  <button type="button" data-act="add"     title="Add a block below">＋</button>
  <button type="button" data-act="up"      title="Move up">↑</button>
  <button type="button" data-act="down"    title="Move down">↓</button>
  <button type="button" data-act="del"     title="Delete">✕</button>
</div>

<div id="commentbox" hidden>
  <div class="cb-head">Comment on this block <span id="cb-target"></span></div>
  <textarea id="cb-text" rows="3" placeholder="too expensive — find something cheaper&#10;add Ed and Ben's flights once known&#10;turn this into a table"></textarea>
  <div class="cb-actions">
    <button type="button" id="cb-cancel">Cancel</button>
    <button type="button" id="cb-send">Send to Claude</button>
  </div>
</div>

<button type="button" id="chatToggle" title="Ask Claude to change the plan">Ask Claude</button>

<aside id="chat" hidden>
  <header>
    <strong>Ask Claude</strong>
    <span id="budget"></span>
    <button type="button" id="chatClose" aria-label="Close">✕</button>
  </header>
  <div id="log">
    <div class="msg bot">
      <p>I can change this page. Try:</p>
      <ul>
        <li>"Add a Reykjavík lodging section with three options under $400"</li>
        <li>"Ed lands Aug 9 at 06:30 on FI614 — add him to the flights table"</li>
        <li>"Cut anything over $300 a person from the activity list"</li>
      </ul>
      <p><strong>Or send a photo.</strong> Screenshot the confirmation email, paste it in here, and I'll read the numbers off it and put them where they go. Faster than typing a booking reference, and harder to get wrong.</p>
      <p class="dim">Everything I change appears for everyone, instantly. Undo is in the bar at the bottom.</p>
    </div>
  </div>
  <div id="chatTray" hidden></div>
  <form id="chatForm">
    <input type="file" id="chatFile" accept="image/*" multiple hidden>
    <button type="button" id="chatAttach" title="Attach a photo — or just paste one">📷</button>
    <textarea id="chatInput" rows="2" placeholder="Change something, or paste a screenshot…"></textarea>
    <button type="submit" id="chatSend">Send</button>
  </form>
</aside>

<script src="/app.js?v=__APPV__" defer></script>
`;

mkdirSync(join(root, "public"), { recursive: true });
mkdirSync(join(root, "seed"), { recursive: true });

/**
 * Content hashes for the two assets the shell links.
 *
 * Without these the browser keeps a cached app.js indefinitely — Cloudflare
 * serves the new file, the tab keeps running the old one, and the bug you just
 * fixed is still on someone's screen. That matters here specifically because
 * this is a page four people leave open for eleven days across a trip; they
 * will not think to hard-refresh, and a stale client against a current server
 * is the hardest kind of report to act on.
 */
const hash = (f) =>
  createHash("sha256").update(readFileSync(join(root, "public", f))).digest("hex").slice(0, 8);
const V = { app: hash("app.js"), css: hash("doc.css") };
console.log(`assets   → app.js?v=${V.app}  doc.css?v=${V.css}`);

const manifest = {};

for (const spec of DOCS) {
  const doc = parse(readFileSync(join(root, spec.src), "utf8"), {
    comment: true,
    blockTextElements: { script: true, style: true },
  });

  const blocks = [];

  for (const sec of doc.querySelectorAll("details.sec")) {
    const section = sec.getAttribute("id");
    if (!section) continue;

    const body = sec.querySelector(".secbody");
    if (!body) continue;

    let n = 0;

    // `.grid2` is a pure layout wrapper holding side-by-side cards. Treating it
    // as one block would mean two people can't edit "Locked in" and "Still
    // open" at the same time — precisely the pair most likely to be edited at
    // once. Descend one level, and carry the layout forward so the client can
    // re-wrap the run. `.tw` looks similar but is NOT a layout wrapper: it's
    // the horizontal-scroll shell a table needs on a phone.
    const children = [];
    for (const child of body.childNodes) {
      if (child.nodeType !== 1) continue; // elements only; whitespace and comments are chrome
      if (child.classList?.contains("grid2")) {
        for (const inner of child.childNodes) {
          if (inner.nodeType === 1) children.push({ node: inner, layout: "grid2" });
        }
      } else {
        children.push({ node: child, layout: null });
      }
    }

    for (const { node: child, layout } of children) {
      const html = child.outerHTML.trim();
      if (!html) continue;

      // Reuse the id the original already carries where there is one — that is
      // what keeps #flights the same anchor before and after the migration, so
      // the section nav and any link already sent to a friend keep working.
      const existing = child.getAttribute("id");
      const id = existing || `${section}-${String(++n).padStart(2, "0")}`;
      blocks.push({ id, section, html, layout });
    }

    body.set_content(`<div class="blocks" data-section="${section}"></div>`);
  }

  doc
    .querySelector("head")
    .insertAdjacentHTML(
      "beforeend",
      `\n<meta name="x-doc" content="${spec.slug}">\n<link rel="stylesheet" href="/doc.css?v=${V.css}">\n`,
    );

  // Cross-link the two documents from the sticky section bar, before the
  // collapse-all button so it reads as navigation rather than an action.
  const bar = doc.querySelector(".secbar-inner");
  if (bar) {
    const spacer = bar.querySelector(".spacer");
    const link = `<a class="doclink" href="${spec.sibling.href}">${spec.sibling.label}</a>`;
    if (spacer) spacer.insertAdjacentHTML("beforebegin", link);
    else bar.insertAdjacentHTML("beforeend", link);
  }

  doc.querySelector("body").insertAdjacentHTML("beforeend", EDITOR_UI.replace("__APPV__", V.app));

  writeFileSync(join(root, "public", spec.out), doc.toString(), "utf8");
  writeFileSync(join(root, "seed", `${spec.slug}.json`), JSON.stringify(blocks, null, 1), "utf8");

  manifest[spec.slug] = blocks.length;
  console.log(`${spec.slug.padEnd(8)} → public/${spec.out}  ·  seed/${spec.slug}.json  (${blocks.length} blocks)`);

  const bySection = blocks.reduce((m, b) => ((m[b.section] = (m[b.section] ?? 0) + 1), m), {});
  for (const [s, n] of Object.entries(bySection)) console.log(`           ${String(n).padStart(3)}  ${s}`);
}
