/**
 * The Claude editing contract.
 *
 * Both AI surfaces — the chat box and the hover comment — reduce to the same
 * thing: a list of block operations against the document. Defining it once here
 * means the hover comment is a three-line wrapper rather than a second
 * integration, and the client only needs one code path to apply results.
 *
 * Claude never sees or writes the whole 55KB document. It gets the outline plus
 * the blocks that matter, and returns ops. That keeps the request small, keeps
 * the blast radius of a bad response to the blocks it named, and means a
 * rewrite of one card can't silently reformat the eclipse clock.
 */

import Anthropic from "@anthropic-ai/sdk";

export type Op =
  | { op: "replace"; id: string; html: string }
  | { op: "insert"; section: string; afterId: string | null; html: string }
  | { op: "delete"; id: string }
  | { op: "move"; id: string; section: string; afterId: string | null };

export interface EditResult {
  reply: string;
  ops: Op[];
}

/**
 * Structured output. Without it the model returns prose-wrapped JSON perhaps
 * 95% of the time, and the 5% is a failed edit in front of four friends.
 */
const OPS_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description:
        "One or two sentences to the group, in the chat panel. Say what you changed and flag anything you were unsure about. No preamble.",
    },
    ops: {
      type: "array",
      description: "The edits. Empty if the message was a question, not a change request.",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace"] },
              id: { type: "string", description: "Existing block id" },
              html: { type: "string", description: "Full replacement HTML for that block" },
            },
            required: ["op", "id", "html"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["insert"] },
              section: { type: "string", description: "Section slug to insert into" },
              afterId: {
                type: ["string", "null"],
                description: "Insert after this block id; null means first in the section",
              },
              html: { type: "string" },
            },
            required: ["op", "section", "afterId", "html"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["delete"] },
              id: { type: "string" },
            },
            required: ["op", "id"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["move"] },
              id: { type: "string" },
              section: { type: "string" },
              afterId: { type: ["string", "null"] },
            },
            required: ["op", "id", "section", "afterId"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["reply", "ops"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are editing a shared trip-planning document for four friends — Rosetta, Kenya, Ed and Ben — travelling to Iceland from 8 to 19 August 2026 for the total solar eclipse on 12 August and the Iceland Eclipse Festival.

You return block operations against the document. You never return the whole document.

## The document

It is a static HTML page split into nine sections, each holding an ordered list of blocks. A block is one top-level element: a <div class="card">, a table wrapped in <div class="tw">, a <p>, a <div class="flag">, an <h3>, a <ul>. You are given the section outline and the full HTML of the blocks relevant to the request.

## House style — match it, do not invent your own

The page has an established visual language. Reuse these classes; do not write inline colours or new class names.

- <div class="card"> — a bordered panel. Most content lives in one.
- <div class="flag">, <div class="flag gold">, <div class="flag teal"> — a called-out note. Coral (default) = warning, gold = act soon, teal = good to know. First child should be a <strong>.
- <div class="tw"><table><thead><tr><th>…</th></tr></thead><tbody>…</tbody></table></div> — every table needs the .tw wrapper or it breaks on phones.
- <span class="pill p-book">, .p-soon, .p-walk, .p-no, .p-done, .p-open — status chips. Use the existing vocabulary.
- <h3> for a sub-heading inside a section, <h4> for a heading inside a card.
- <small> and class="dim" for secondary text; class="mono" for figures and codes.

## Rules

1. **Prefer replace over delete-plus-insert.** Rewriting a block in place keeps its identity, its position, and its edit history. Only delete when something is genuinely being removed.
2. **Only touch blocks you were given.** If a request needs a block you cannot see, say so in your reply and make no op for it. Do not guess an id.
3. **Return complete, valid HTML for a block** — the whole element, opening tag to closing tag, not a fragment or a diff.
4. **Never invent a fact.** No prices, opening hours, availability, addresses or flight numbers that were not in the document or the user's message. If a change implies a fact you do not have, write the change with the gap visible — "price not checked" — and flag it in your reply. This document already has a section about what could not be confirmed; do not quietly add to the pile.
5. **Preserve what you were not asked to change.** Rewriting a table row does not license reformatting the table.
6. **Match the document's voice**: plain, specific, a bit dry. It says "Reykjavík hotels are reportedly over $1,000/night in eclipse week", not "Reykjavík offers a range of exciting accommodation options!"
7. Dates as "12 August", times as 24-hour, prices with the currency as written nearby.
8. **A question is not an edit.** If the user is asking rather than instructing, answer in \`reply\` and return an empty \`ops\` array.

Keep \`reply\` to one or two sentences. The group reads it in a narrow chat panel, not a report.`;

interface EditRequest {
  apiKey: string;
  /** What the user typed. */
  instruction: string;
  /** Section slug -> ordered block ids, so Claude can target inserts. */
  outline: string;
  /** Full HTML of the blocks Claude may edit, already id-labelled. */
  context: string;
  /** Who is asking — lets Claude write "Ben asked for…" naturally. */
  who: string;
  /** Set when the request came from a hover comment on one specific block. */
  focusId?: string;
}

export async function edit(req: EditRequest): Promise<EditResult> {
  const client = new Anthropic({ apiKey: req.apiKey });

  const focus = req.focusId
    ? `\n\n${req.who} left this comment on block \`${req.focusId}\`. Act on it. Edit that block unless the comment clearly asks for something elsewhere.`
    : `\n\n${req.who} sent this from the chat panel. It may touch any block you can see.`;

  // `output_config` is current API surface but not yet in this SDK release's
  // types, so the params object is cast. Remove the cast when the types land.
  const params = {
    model: "claude-opus-5",
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      // medium: this is short-form editing against a fixed style guide, not a
      // reasoning problem. Opus 5 at medium is well ahead of what this needs,
      // and it keeps the round trip inside a few seconds — which matters when
      // four people are watching the block spin.
      effort: "medium",
      format: { type: "json_schema", schema: OPS_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `## Document outline\n\n${req.outline}\n\n## Blocks you can edit\n\n${req.context}\n\n## Request${focus}\n\n${req.instruction}`,
      },
    ],
  };

  const message = await client.messages.create(params as never);

  if (message.stop_reason === "refusal") {
    return { reply: "I can't help with that one.", ops: [] };
  }

  const text = message.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    return { reply: "Claude returned nothing usable. Try rephrasing?", ops: [] };
  }

  let parsed: EditResult;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return { reply: "Claude's response didn't parse. Nothing was changed.", ops: [] };
  }

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "Done.",
    ops: Array.isArray(parsed.ops) ? parsed.ops : [],
  };
}
