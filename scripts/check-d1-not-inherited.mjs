#!/usr/bin/env node
/**
 * Refuse to deploy while wrangler.jsonc is bound to a D1 database that is not
 * this project's own.
 *
 * WHY THIS EXISTS
 *
 * Measured 2026-11-02: `database_id` d555f8ce-77c9-4c82-be80-de95b8d9c003 is the
 * account's spend-governor database — core-guardian's production D1, holding
 * billable_usage, alert_rules, cf_billing_*, workers_ai_daily_neurons,
 * ai_routing_decisions, spend_rollup and about 115 more tables (123 tables,
 * 400.2 MB). Cloudflare still lists it under the name it was created with,
 * core-template-cfw-assets-astro-shadcn, because a template created it and
 * core-guardian adopted it. wrangler's `database_name` is cosmetic; the uuid is
 * what binds. That is why five Workers pointed at this one database while each
 * `wrangler.jsonc` claimed a different `database_name`.
 *
 * THE RULES — two, because two different mistakes put a foreign uuid here.
 *
 * 1. NEVER a known-foreign database, whatever this project is called. A copy that
 *    reverts wrangler.jsonc, or pastes an old id back, is caught by identity, not
 *    by inference. This is the rule that would have caught the live bug.
 *
 * 2. A template must carry a placeholder, not a uuid. While package.json's `name`
 *    is still a `core-template*` name, any uuid-shaped `database_id` is refused:
 *    a copy pasting a real id while still wearing the template's identity is
 *    almost certainly pasting the id it inherited. Renaming the package is the
 *    first thing anyone does to a copy, so it is the signal that separates "still
 *    the template" from "a real app".
 *
 * ponytail: FOREIGN is a short denylist rather than an ownership lookup because
 * nothing offline can prove which Worker owns a uuid. Add an entry when a shared
 * database is found; an API call at deploy time would need a token this check
 * must not require.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Databases no project in this ecosystem may bind. */
export const FOREIGN = [
  {
    id: "d555f8ce-77c9-4c82-be80-de95b8d9c003",
    what:
      "core-guardian's PRODUCTION database (123 tables, 400.2 MB on 2026-11-02; " +
      "Cloudflare lists it as core-template-cfw-assets-astro-shadcn)",
  },
];

/** wrangler.jsonc is JSON with comments and trailing commas; strip both. */
export function parseJsonc(text) {
  const noComments = text.replace(
    /"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith('"') ? m : " "),
  );
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

/** Both rules, in one place, so the self-check can drive them. */
export function verdict({ packageName, databases }) {
  const list = databases || [];
  const ids = (d) => [d.database_id, d.preview_database_id].filter(Boolean).map((x) => String(x));

  const foreign = list.filter((d) =>
    ids(d).some((id) => FOREIGN.some((f) => f.id === id.toLowerCase())),
  );

  const isTemplate = /^core-template/.test(packageName || "");
  const inherited = isTemplate
    ? list.filter((d) => ids(d).some((id) => UUID.test(id)) && !foreign.includes(d))
    : [];

  return { ok: foreign.length === 0 && inherited.length === 0, foreign, inherited };
}

function describe(d) {
  const preview = d.preview_database_id ? `, preview ${d.preview_database_id}` : "";
  return `  ${d.binding} -> ${d.database_name} (${d.database_id}${preview})`;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const wrangler = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const result = verdict({ packageName: pkg.name, databases: wrangler.d1_databases });
  if (result.ok) {
    console.log("check-d1-not-inherited: ok");
    return 0;
  }
  const lines = ["check-d1-not-inherited: refusing to deploy."];
  if (result.foreign.length > 0) {
    lines.push(
      "",
      "wrangler.jsonc binds a database that belongs to another project:",
      ...result.foreign.map(describe),
      "",
      ...FOREIGN.map((f) => `  ${f.id} is ${f.what}`),
    );
  }
  if (result.inherited.length > 0) {
    lines.push(
      "",
      `This project still calls itself "${pkg.name}", so it is still the template, ` +
        "but wrangler.jsonc binds a real D1 database:",
      ...result.inherited.map(describe),
      "",
      "If you ARE the template, that id belongs in wrangler.jsonc as a placeholder.",
    );
  }
  lines.push(
    "",
    "Give this project its own database:",
    "  npx wrangler d1 create <your-app-name>",
    "then put the returned name and uuid in wrangler.jsonc (and rename this package",
    "if it is still a core-template* copy).",
  );
  console.error(lines.join("\n"));
  return 1;
}

function selfCheck() {
  const guardian = FOREIGN[0].id;
  const mine = "11111111-2222-3333-4444-555555555555";
  const pkgName = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;
  const cases = [
    // [what, input, expected ok]
    [
      "guardian's database is refused however this project is named — the live bug",
      { packageName: "mcp-r2-sql", databases: [{ database_id: guardian }] },
      false,
    ],
    [
      "guardian's database is refused as a preview id too",
      { packageName: "some-app", databases: [{ database_id: mine, preview_database_id: guardian }] },
      false,
    ],
    [
      "an uppercase spelling of guardian's id is the same database",
      { packageName: "some-app", databases: [{ database_id: guardian.toUpperCase() }] },
      false,
    ],
    [
      "a template carrying any real uuid is refused",
      { packageName: "core-template-cf-reui", databases: [{ database_id: mine }] },
      false,
    ],
    [
      "the plural template name is a template too",
      { packageName: "core-templates-cf-astro-shadcn-mainline", databases: [{ database_id: mine }] },
      false,
    ],
    [
      "one real id among placeholders is still refused",
      {
        packageName: "core-template-x",
        databases: [{ database_id: "replace-me" }, { database_id: mine }],
      },
      false,
    ],
    [
      "a renamed copy with its own fresh uuid passes",
      { packageName: "my-new-app", databases: [{ database_id: mine }] },
      true,
    ],
    [
      "no d1 block at all passes",
      { packageName: "core-template-x", databases: undefined },
      true,
    ],
    [
      `this repo's own name (${pkgName}) with the placeholder passes`,
      {
        packageName: pkgName,
        databases: [{ database_id: "replace-me-run-wrangler-d1-create" }],
      },
      true,
    ],
  ];
  for (const [what, input, expected] of cases) {
    const got = verdict(input).ok;
    if (got !== expected) {
      throw new Error(`self-check failed: ${what} (expected ok=${expected}, got ${got})`);
    }
  }
  // The parser has to survive the comments and trailing commas this repo's config uses.
  const parsed = parseJsonc('{\n // a line comment with "a quote\n "a": 1, /* block */\n "b": [2,],\n}');
  if (parsed.a !== 1 || parsed.b.length !== 1) throw new Error("self-check failed: jsonc parsing");
  if (parseJsonc('{"url": "https://x/y//z"}').url !== "https://x/y//z") {
    throw new Error("self-check failed: a // inside a string is not a comment");
  }
  // The real wrangler.jsonc in this repo must parse and must pass.
  const live = verdict({
    packageName: pkgName,
    databases: parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")).d1_databases,
  });
  if (!live.ok) throw new Error("self-check failed: this repo's own wrangler.jsonc is refused");
  console.log(`check-d1-not-inherited: self-check passed (${cases.length} cases + the live config)`);
  return 0;
}

process.exit(process.argv.includes("--self-check") ? selfCheck() : main());
