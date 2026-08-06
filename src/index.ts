/**
 * iceland.rosettawang.org — the front door.
 *
 * Every request passes the passcode gate before anything is served, including
 * the WebSocket upgrade. A gate on the HTML that leaves the socket open is not
 * a gate, and that is the standard way this gets built wrong.
 */

import { DocRoom, type Env } from "./room";
import { whoIs, mintCookie, clearCookie, readCookie } from "./auth";

export { DocRoom };

/**
 * Two documents on one site. Each is its own Durable Object, so the packing
 * list and the trip plan can be edited at the same time without one blocking
 * the other, and a bad edit to one can never reach the other.
 */
const DOCS: Record<string, { shell: string; title: string }> = {
  iceland: { shell: "/index.html", title: "Trip plan" },
  packing: { shell: "/packing.html", title: "Packing list" },
};

function docForPath(pathname: string): string {
  if (pathname === "/packing" || pathname === "/packing/" || pathname === "/packing.html") return "packing";
  return "iceland";
}

/** A trip plan holding four people's flight numbers has no business in a search index. */
function harden(res: Response): Response {
  const r = new Response(res.body, res);
  r.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "no-referrer");
  return r;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (!env.DOC_PASSCODE) {
      return harden(
        new Response(
          "DOC_PASSCODE is not set on this Worker. Run: npx wrangler secret put DOC_PASSCODE",
          { status: 503, headers: { "Content-Type": "text/plain" } },
        ),
      );
    }

    // --- sign in ---------------------------------------------------------
    if (url.pathname === "/auth" && request.method === "POST") {
      const form = await request.formData();
      const typed = String(form.get("passcode") ?? "");

      // One word per person: the word both admits you and names you, so there
      // is no separate name to pick and nothing to mismatch.
      const name = whoIs(typed, env.DOC_PASSCODE);

      // Fixed delay on every attempt, matched success or failure, so response
      // time doesn't say whether a word was close.
      await new Promise((r) => setTimeout(r, 400));

      if (!name) {
        return harden(Response.redirect(new URL("/?bad=1", url.origin).toString(), 303));
      }

      // Land back where they were, so a link to /packing survives signing in.
      const next = form.get("next") === "/packing" ? "/packing" : "/";
      return harden(
        new Response(null, {
          status: 303,
          headers: { Location: next, "Set-Cookie": await mintCookie(name, env.DOC_PASSCODE) },
        }),
      );
    }

    if (url.pathname === "/signout") {
      return harden(
        new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearCookie() } }),
      );
    }

    // --- the gate --------------------------------------------------------
    const who = await readCookie(request, env.DOC_PASSCODE);
    if (!who) {
      // Machine endpoints must say "unauthenticated" in a way a machine can
      // read. Serving them the gate HTML with a 200 is what turns an expired
      // cookie into a page that looks alive and silently never syncs again:
      // the socket keeps retrying against HTML, and fetches JSON.parse it and
      // report "couldn't reach Claude". Rotating DOC_PASSCODE invalidates every
      // cookie, so this is not a rare path — it happened twice on Aug 5, 2026.
      if (url.pathname === "/ws") {
        return harden(new Response("unauthenticated", { status: 401 }));
      }
      if (url.pathname.startsWith("/api/")) {
        return harden(
          Response.json({ error: "unauthenticated", signIn: true }, { status: 401 }),
        );
      }

      if (url.pathname === "/doc.css" || url.pathname === "/gate.css") {
        return harden(await env.ASSETS.fetch(new Request(new URL("/doc.css", url.origin))));
      }
      const gate = await env.ASSETS.fetch(new Request(new URL("/gate.html", url.origin)));
      const html = (await gate.text())
        .replace("{{BAD}}", url.searchParams.has("bad") ? "block" : "none")
        .replace("{{NEXT}}", docForPath(url.pathname) === "packing" ? "/packing" : "/");
      return harden(
        new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      );
    }

    // --- past the gate ---------------------------------------------------
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      // The client says which document it means; anything unrecognised falls
      // back to the trip plan rather than spinning up a stray empty DO.
      const slug = url.searchParams.get("doc") ?? "iceland";
      const doc = DOCS[slug] ? slug : "iceland";
      const room = env.DOC.get(env.DOC.idFromName(`doc:${doc}`));

      const forwarded = new Request(request);
      forwarded.headers.set("X-Who", who);
      forwarded.headers.set("X-Doc", doc);
      return room.fetch(forwarded);
    }

    const slug = docForPath(url.pathname);
    const isDocPage =
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/packing" ||
      url.pathname === "/packing/" ||
      url.pathname === "/packing.html";

    if (isDocPage) {
      const res = await env.ASSETS.fetch(new Request(new URL(DOCS[slug].shell, url.origin)));
      const html = (await res.text()).replace("{{WHO}}", who);
      return harden(
        new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      );
    }

    return harden(await env.ASSETS.fetch(request));
  },
};
