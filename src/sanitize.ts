/**
 * Server-side HTML allowlist, built on HTMLRewriter.
 *
 * Runs at the Durable Object on the way IN, not on render. Block HTML arrives
 * from two untrusted-ish places: contenteditable (the browser emits whatever it
 * likes, and people will paste from Airbnb and Gmail) and Claude (which will
 * happily emit a <script> if something it read told it to). A client-side
 * sanitiser only protects the client that runs it; this protects everyone the
 * DO later hands the block to.
 *
 * Using HTMLRewriter rather than a regex or a bundled sanitiser library because
 * it is the platform's own HTML parser — it cannot be fooled by the malformed
 * markup that defeats hand-rolled parsers.
 */

// Everything the trip document actually uses, and nothing else.
const ALLOWED = new Set([
  "p", "div", "span", "br", "hr",
  "h3", "h4", "h5",
  "strong", "b", "em", "i", "u", "s", "small", "code", "sup", "sub",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "a", "blockquote", "figure", "figcaption", "img", "details", "summary",
]);

// Removed with their contents, rather than unwrapped.
const NUKE = new Set(["script", "style", "iframe", "object", "embed", "form",
  "input", "button", "textarea", "select", "link", "meta", "base", "svg", "math"]);

const ALLOWED_ATTRS = new Set(["href", "class", "id", "colspan", "rowspan",
  "style", "src", "alt", "title", "open"]);

function safeHref(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s.startsWith("https://") || s.startsWith("mailto:") ||
    s.startsWith("tel:") || s.startsWith("#") || s.startsWith("/");
}

function safeSrc(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s.startsWith("https://") || s.startsWith("/");
}

/**
 * Inline style survives, filtered. The trip document leans on it
 * (`style="margin-bottom:0"` on a dozen lists), so stripping it outright would
 * visibly break the layout on the first AI rewrite. The filter blocks the two
 * things inline style can actually do to you: fetch a URL, and escape the
 * document flow to cover the page.
 */
function safeStyle(v: string): boolean {
  const s = v.toLowerCase();
  return !/url\s*\(|expression|javascript:|@import|position\s*:\s*(fixed|sticky)|z-index/.test(s);
}

export async function sanitize(html: string): Promise<string> {
  if (!html) return "";

  const rewritten = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();

        if (NUKE.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED.has(tag)) {
          // Unknown-but-harmless wrapper: drop the tag, keep the words.
          el.removeAndKeepContent();
          return;
        }

        // Snapshot before mutating — removing during iteration skips entries.
        const attrs = [...el.attributes];
        for (const [name, value] of attrs) {
          const n = name.toLowerCase();
          if (!ALLOWED_ATTRS.has(n) || n.startsWith("on")) {
            el.removeAttribute(name);
            continue;
          }
          if (n === "href" && !safeHref(value)) el.removeAttribute(name);
          if (n === "src" && !safeSrc(value)) el.removeAttribute(name);
          if (n === "style" && !safeStyle(value)) el.removeAttribute(name);
        }

        // Any link that survives goes to a new tab without leaking a referrer.
        if (tag === "a" && el.getAttribute("href")) {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html" } }));

  return (await rewritten.text()).trim();
}
