Please install and integrate the `deep-search` Flue agent into our Cloudflare Worker project.

Execute this integration using Flue's Cloudflare deployment best practices and adhere strictly to our architectural standards:

1. **Dependencies:** Install `@flue/runtime`, `valibot`, and the native Cloudflare Agents SDK (`agents@^0.14.2`). Ensure we are utilizing the native Agents SDK exclusively and not the abandoned Honi framework.
2. **Scaffold Files:** Create the `deep-search` block files as defined in the Flue registry:
* `agents/deep-search.ts`
* `workflows/deep-search.ts`
* `tools/search.ts`
* `skills/research/SKILL.md`


3. **Wrangler Configuration:** - Update `wrangler.jsonc` to include `"nodejs_compat"` within the `compatibility_flags`.
* Add the necessary Durable Object SQLite migrations using `new_sqlite_classes` (do not use the legacy `new_classes` property). The migration must explicitly declare the Flue Registry and the PascalCase versions of the generated classes:
```jsonc
"migrations": [
  {
    "tag": "v1", // Adjust the tag sequence appropriately if migrations already exist
    "new_sqlite_classes": ["FlueRegistry", "FlueDeepSearchAgent", "FlueDeepSearchWorkflow"]
  }
]

```


* Do NOT manually define `FLUE_DEEP_SEARCH_AGENT` or `FLUE_DEEP_SEARCH_WORKFLOW` bindings in `wrangler.jsonc`. Flue's build step handles binding merges automatically.


4. **Routing:** Mount the generated workflow into our existing Hono router setup securely.
5. **Data Layer Adherence:** If setting up any application-side analytics or run-tracking alongside this, continue routing operations through Drizzle ORM backed by D1. You must maintain our modular schema directory structure, strictly keeping one file per database table.
6. **Build Pipeline:** Ensure our build scripts execute `flue build --target cloudflare` to compile the Worker artifact correctly before triggering Wrangler.
7. **Build a frontend page to demo chatting with this new flue agent using `assistant-ui` to connect with the `cloudflare agent sdk` which is wrapping the `flue` agent on the `worker backend` using `hono api` hosted by the `worker backend`

---

# Here are documents for context:

### Deploy to Cloudflare
```markdown
---
description: Build and deploy Flue agents on Cloudflare Workers.
title: Deploy to Cloudflare | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Deploy to Cloudflare

Last updated Jun 20, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/deploy/cloudflare/index.md) 

Build and deploy Flue agents on Cloudflare Workers. This guide walks you through the different kinds of agents you can build — from simple prompt-and-response endpoints to full coding agents backed by persistent storage and remote sandboxes.

By the end, you will have a Flue agent running on Cloudflare Workers, and you will know how to add subagents, R2-backed context, Cloudflare sandboxes, and Durable Object-backed sessions.

## Project layout

The project root is your project directory. Flue selects authored source from `.flue/`, then `src/`, then the project root. The first matching directory wins, and layouts never mix. See [Project Layout](https://flueframework.com/docs/guide/project-layout/) for the full convention.

By default `flue build` writes to `./dist/` at the project root; pass `--output <path>` to redirect the build elsewhere. `wrangler.jsonc` and any `Dockerfile` you ship live at the project root, regardless of where the build lands. Examples in this guide use the `./.flue/` layout.

## Hello World

The simplest agent — no container, no storage, just a prompt and a typed result.

### 1\. Set up your project

```bash
mkdir my-flue-worker && cd my-flue-worker
npm init -y
npm install @flue/runtime valibot 'agents@^0.14.2'
npm install -D @flue/cli wrangler
```

`agents` is Cloudflare’s Agents SDK — Flue uses its Durable Object base class and native lifecycle capabilities while retaining ownership of application routing. Flue is tested against `agents` 0.14.x; the generated worker checks at runtime that the installed SDK provides the durability API it relies on (such as `runFiber`) and fails with an explicit error if it does not. If you also need a remote sandbox, additionally install `@cloudflare/sandbox` (see [Connecting a remote sandbox](#connecting-a-remote-sandbox) below).

### 2\. Create your first agent

`.flue/workflows/translate.ts`:

```typescript
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const translator = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export default defineWorkflow({
  agent: translator,
  input: v.object({ text: v.string(), language: v.string() }),

  async run({ harness, input }) {
    const { data } = await (
      await harness.session()
    ).prompt(`Translate this to ${input.language}: "${input.text}"`, {
      result: v.object({
        translation: v.string(),
        confidence: v.picklist(['low', 'medium', 'high']),
      }),
    });
    return data;
  },
});
```

A few things to note:

* **`route`** — Export Hono middleware to expose this workflow via HTTP. It may perform authentication before calling `next()`.
* **`defineAgent(...)` \+ `defineWorkflow(...)`** — The required workflow agent declares model and sandbox policy. Flue initializes its harness for each run. By default, it receives a virtual sandbox powered by [just-bash](https://github.com/vercel-labs/just-bash). No container needed.
* **Schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent’s response and returns it on `response.data`, fully typed.

### 3\. Configure Durable Object migrations

Cloudflare requires an explicit migration whenever a Worker adds a Durable Object class. Flue generates the classes and bindings for discovered agents and workflows, but your project owns the ordered migration history in `wrangler.jsonc`.

`wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueTranslateWorkflow"] }],
}
```

Every Cloudflare target includes `FlueRegistry`. Flue-owned bindings use upper snake case and generated classes use PascalCase: `.flue/workflows/translate.ts` binds `FLUE_TRANSLATE_WORKFLOW` to `FlueTranslateWorkflow`, while `.flue/agents/support-chat.ts` binds `FLUE_SUPPORT_CHAT_AGENT` to `FlueSupportChatAgent`.

Keep deployed migration entries in order. When you add an agent or workflow later, append a uniquely tagged migration for its new class. Generated Flue agent classes require Durable Object SQLite: introduce them through `new_sqlite_classes`, not legacy `new_classes`. An already deployed KV-backed Durable Object class cannot be converted to SQLite in place. For this pre-1.0 agent durability upgrade, use a fresh generated agent class identity and treat deployment as a hard execution-state boundary: in-flight direct prompts and dispatched inputs from earlier generated-agent identities are not adopted. Use Cloudflare’s explicit rename or delete migrations when changing a deployed class lifecycle. When upgrading a workflow deployment created before this naming scheme, append `renamed_classes` entries such as `{ "from": "TranslateWorkflow", "to": "FlueTranslateWorkflow" }`; do not rewrite deployed migration history.

### 4\. Build and deploy

```bash
npx flue build --target cloudflare
npx wrangler deploy --config dist/my-flue-worker/wrangler.json
```

`flue build --target cloudflare` compiles your project into a `./dist` directory containing a Cloudflare Workers-compatible artifact. Deploy the generated Wrangler config from the build output, not the source-root `wrangler.jsonc`, so Wrangler uses Flue’s generated entrypoint, merged bindings, and Cloudflare Vite output. The generated directory is named from your Worker name, so this example writes `dist/my-flue-worker/wrangler.json`.

Before deploying, run the same generated config through Wrangler’s dry run:

```bash
npx wrangler deploy --dry-run --config dist/my-flue-worker/wrangler.json
```

### Serving assets from the same Worker

Workers static assets are served before your Worker script unless `assets.run_worker_first` says otherwise. If a single Worker serves a front-end build and application routes that invoke Flue, include every application-owned API prefix and every mounted Flue prefix in `run_worker_first` so those requests reach Hono instead of the asset handler or SPA fallback:

```jsonc
{
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/_flue/*"],
  },
}
```

Adjust the prefixes to match where your `app.ts` mounts public routes and `flue()`. If Flue is mounted at `/api`, include `/api/*`; if your application mounts Flue at a private internal prefix, include that prefix too and protect it with middleware.

### 5\. Add your API key

For local Cloudflare development, put provider API keys in `.dev.vars` beside your Wrangler configuration:

```bash
cat > .dev.vars <<'EOF'
ANTHROPIC_API_KEY="your-api-key"
EOF

printf '\n.dev.vars*\n.env*\n' >> .gitignore
```

Use the variable name your provider expects — `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. Do not commit local secret files. Cloudflare also supports `.env`\-based local variables, but use either `.dev.vars` or `.env`, not both; when `.dev.vars` exists, `.env` values are not loaded into local Worker bindings. Flue loads `.env` or one explicitly selected `--env` file before CLI configuration and builds, but Worker runtime variables continue to follow Cloudflare’s local-variable rules.

For a deployed Worker, add secrets through Wrangler rather than treating a local-development file as production configuration:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx flue build --target cloudflare
npx wrangler deploy --config dist/my-flue-worker/wrangler.json
```

For CI or a managed deployment pipeline, `wrangler deploy --secrets-file <path>` is also available when your pipeline provides a protected secrets file.

### 6\. Try it locally

For local development, use `flue dev --target cloudflare`. It builds your project root, then starts a Cloudflare Workers development server through the official Vite integration on port 3583 and watches for changes:

```bash
npx flue dev --target cloudflare
```

Then test it:

```bash
curl http://localhost:3583/workflows/translate?wait=result \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

For one finite local operation, `flue run --target cloudflare <name>` starts the same Vite/workerd application runtime without watch mode, invokes an agent or workflow through an existing authored `flue()` mount, and exits. It runs normal application middleware and temporarily exposes route-free discovered resources through the mount.

Route middleware sees the original inbound HTTP request before Flue forwards accepted work into its Durable Object. Durable direct-agent processing is a later boundary: after admission, Flue uses a deterministic internal request and does not persist or reconstruct the caller’s original headers, cookies, query parameters, URL, or body as operation-time `ctx.req`. Authenticate before admission and carry any non-secret correlation you need later in application-owned input or storage.

### Extending generated Cloudflare Durable Objects

Flue normally owns each generated agent and workflow Durable Object class. When an addressable agent or workflow needs native Cloudflare Agents SDK capabilities such as `onStart()`, `schedule()`, `scheduleEvery()`, or `queue()`, export a `cloudflare` extension descriptor from its module:

```ts
import { defineAgent } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';

export default defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async onStart() {
        await this.scheduleEvery(60, 'heartbeat');
      }

      async heartbeat() {
        this.setState({ ...this.state, lastHeartbeatAt: Date.now() });
      }
    },
});
```

This is an advanced Cloudflare-only extension point. Flue applies `base` first, then defines its own Durable Object subclass with the generated Flue binding and class identity. For `.flue/agents/support-chat.ts`, authored Worker code can access the namespace as `env.FLUE_SUPPORT_CHAT_AGENT`, and Wrangler binds that name to `FlueSupportChatAgent`. For `.flue/workflows/translate.ts`, the corresponding names are `env.FLUE_TRANSLATE_WORKFLOW` and `FlueTranslateWorkflow`. Use `base` for native SDK lifecycle hooks and additional named methods. Do not override `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()`: Flue and the Agents SDK use those methods for routing, interruption recovery, and alarm multiplexing.

Use `wrap` when an integration needs to wrap the final Flue-generated Durable Object class:

```ts
import * as Sentry from '@sentry/cloudflare';

export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry((env: Env) => ({ dsn: env.SENTRY_DSN }), Final),
});
```

Both `base` and `wrap` are optional. Do not override Flue-owned `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()` methods. This module-local export is distinct from the optional source-root `.flue/cloudflare.ts` deployment module below. Native SDK callbacks run as Durable Object activity: they do not receive a Flue workflow context, create workflow runs, or automatically initialize a Flue harness or session.

### Extending the Worker

Add an optional `.flue/cloudflare.ts` module when your deployment needs native Cloudflare capabilities outside Flue’s generated classes. Named exports become top-level Worker exports, which lets the same Worker define application-owned Durable Objects:

```ts
import { DurableObject } from 'cloudflare:workers';

export class SalesforceAuthCache extends DurableObject {
  async refreshIfNeeded() {
    return await this.ctx.storage.get('token');
  }
}
```

Declare the corresponding binding and migration in your project-root `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SALESFORCE_AUTH_CACHE", "class_name": "SalesforceAuthCache" }],
  },
  "migrations": [{ "tag": "v2", "new_sqlite_classes": ["SalesforceAuthCache"] }],
}
```

Your agents and workflows receive the namespace through `env.SALESFORCE_AUTH_CACHE`. Keep bindings, containers, and ordered migration history in Wrangler configuration; `cloudflare.ts` provides the Worker code exports but does not infer deployment topology.

An optional default export adds non-HTTP Worker handlers:

```ts
export default {
  async scheduled(_controller, env) {
    await env.SALESFORCE_AUTH_CACHE.getByName('default').refreshIfNeeded();
  },
};
```

Use `.flue/app.ts` for custom HTTP routes and middleware. `cloudflare.ts` must not export a default `fetch` handler because Flue keeps HTTP composition in `app.ts`.

## Subagents

Subagents define named delegates for detached task sessions:

```typescript
import { defineAgent, defineAgentProfile } from '@flue/runtime';

const triager = defineAgentProfile({
  name: 'triager',
  instructions: 'Search thoroughly, cite sources, and stay concise.',
});
const support = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', subagents: [triager] }));

export default defineWorkflow({
  agent: support,
  async run({ harness }) {
    return await (
      await harness.session()
    ).task('Help me reset my password', {
      agent: 'triager',
    });
  },
});
```

## Using the sandbox

By default, the virtual sandbox starts empty — no files, no skills, no context. This is fine for stateless prompt-and-response agents like the translator above. But many agents need files to work with.

Because the agent has shell access, it can set up its own workspace on the fly:

```typescript
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const reporter = defineAgent(() => ({ model: 'openai/gpt-5.5' }));

export default defineWorkflow({
  agent: reporter,
  input: v.object({ topic: v.string() }),

  async run({ harness, input }) {
    const session = await harness.session();
    await session.shell(`mkdir -p /workspace/data`);
    await session.shell(`cat > /workspace/data/config.json << 'EOF'
{
  "rules": ["Be concise", "Use bullet points", "Cite sources"],
  "tone": "professional"
}
EOF`);

    return await session.prompt(
      `Read the config in /workspace/data/config.json.
       Generate a report about: ${input.topic}`,
    );
  },
});
```

The agent can use its built-in tools — grep, glob, read — to search and read these files. This is still running on a virtual sandbox (no container), so it’s fast and cheap.

## Support agents with context files

For support agents, you can seed Flue’s default virtual sandbox with the knowledge required for a request. The agent can search and read these files using its built-in `grep`, `glob`, and `read` tools without provisioning a container or installing a sandbox adapter.

`.flue/workflows/support.ts`:

```typescript
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const support = defineAgent(() => ({ model: 'openrouter/moonshotai/kimi-k2.6' }));

export default defineWorkflow({
  agent: support,
  input: v.object({ message: v.string() }),

  async run({ harness, input }) {
    await harness.fs.writeFile(
      '/workspace/articles/reset-password.md',
      '# Reset your password\n\nUse the account settings page to request a password reset email.',
    );

    return await (
      await harness.session()
    ).prompt(
      `You are a support agent. Search the workspace for articles relevant
      to this request, then write a helpful response.\n\nCustomer: ${input.message}`,
    );
  },
});
```

This remains the default just-bash virtual sandbox: it starts quickly, supports shell and filesystem tools, and requires no Worker Loader binding. If an application needs durable external storage or a full Linux environment, choose and own a sandbox adapter appropriate to that requirement.

## Connecting a remote sandbox

The examples above all run on virtual sandboxes — no container needed. But for agents that need a full Linux environment — git, Node.js, a browser, system packages — you want a remote sandbox.

Cloudflare has native container support via [@cloudflare/sandbox](https://developers.cloudflare.com/containers/). Each session gets its own isolated container with a persistent filesystem, shell, and full Linux userspace.

If you’d rather connect to an external provider — e.g. Daytona — instead of running the sandbox on Cloudflare, see [Connect a Daytona Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/daytona/).

### Setup

You own the container config. That means four things:

1. Install `@cloudflare/sandbox`: `npm install @cloudflare/sandbox`.
2. Export the Sandbox class from `.flue/cloudflare.ts`.
3. Declare the Durable Object binding, migration, and container image in your `wrangler.jsonc` at the project root.
4. Commit a `Dockerfile` at the path your `containers[].image` points to.

Append the Sandbox migration to the same top-level history you use for generated Flue classes; do not replace migrations that have already been deployed.

### Example

`.flue/cloudflare.ts`:

```ts
export { Sandbox } from '@cloudflare/sandbox';
```

`wrangler.jsonc` (at the project root, alongside `package.json`):

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-agent",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueAssistantAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["Sandbox"] },
  ],
  "containers": [{ "class_name": "Sandbox", "image": "./Dockerfile" }],
}
```

`Dockerfile` (at the project root):

```dockerfile
FROM docker.io/cloudflare/sandbox:0.9.2
```

The base image is published by Cloudflare and bundles the control-plane HTTP server that `@cloudflare/sandbox` needs to communicate with the container, along with `node`, `git`, `curl`, and a working directory at `/workspace`. Pin the tag to match the `@cloudflare/sandbox` version in your `package.json` — they’re versioned together. Add your own `RUN` lines to install extra tools as needed.

`.flue/agents/assistant.ts`:

```typescript
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(({ id, env }) => ({
  sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
  model: 'anthropic/claude-opus-4-7',
}));
```

### Multiple sandboxes

Different agents can use different container images. Export a separate alias for each Sandbox class, then declare each binding and container entry:

```ts
// .flue/cloudflare.ts
export { Sandbox as PyBoxSandbox } from '@cloudflare/sandbox';
export { Sandbox as NodeSandbox } from '@cloudflare/sandbox';
```

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "class_name": "PyBoxSandbox", "name": "PyBox" },
      { "class_name": "NodeSandbox", "name": "NodeBox" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueAssistantAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["PyBoxSandbox", "NodeSandbox"] },
  ],
  "containers": [
    { "class_name": "PyBoxSandbox", "image": "./docker/python.Dockerfile" },
    { "class_name": "NodeSandbox", "image": "./docker/node.Dockerfile" },
  ],
}
```

Each agent grabs the sandbox it needs: `cloudflareSandbox(getSandbox(env.PyBox, id))` or `cloudflareSandbox(getSandbox(env.NodeBox, id))`.

### Secure egress with outbound Workers

When your agent runs in a container, it may need to call external APIs — GitHub, npm registries, internal services. The traditional approach is to inject API tokens as environment variables, but that means the agent (and the LLM) has direct access to those secrets.

Cloudflare Sandboxes solve this with [outbound Workers](https://blog.cloudflare.com/sandbox-auth/) — a programmable egress proxy that intercepts outgoing HTTP/HTTPS requests from the container. Secrets are injected at the proxy layer, so the container never sees them. This is configured on the Cloudflare Sandbox class, outside of your Flue agent code:

```typescript
import { Sandbox } from '@cloudflare/sandbox';

export class MySandbox extends Sandbox {
  static outboundByHost = {
    'api.github.com': (request, env, ctx) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
      return fetch(request, { headers });
    },
  };
}
```

This is a zero-trust model — no token is ever granted to the untrusted sandbox. The proxy runs on the same machine as the container, so latency is minimal. You can also use outbound Workers to log requests, block specific domains, or enforce dynamic policies that change over the lifetime of a session.

For full details, see the [outbound Workers documentation](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).

### When to use a remote sandbox

| Virtual sandbox                  | Remote sandbox                              |
| -------------------------------- | ------------------------------------------- |
| Millisecond startup              | Seconds to start (cached images are faster) |
| Grep, glob, read, basic shell    | Full Linux: git, Node.js, Python, browsers  |
| R2 or inline files               | Real persistent filesystem                  |
| High-traffic / high-scale agents | Coding agents, complex dev environments     |

Most agents don’t need a remote sandbox. Start with a virtual sandbox and only move to a remote sandbox when you need the full environment.

## Conversation persistence

For agents, generated Cloudflare applications store one append-only canonical conversation stream per agent instance in Durable Object SQLite, with attachment bytes in a separate immutable store. Sessions select conversations from that stream; there is no second session transcript or persisted conversation snapshot. Workflow harness conversation state is execution-scoped to its run, while workflow run records and event history use the workflow durable-runtime path.

Filesystem durability remains a separate decision. The default lightweight sandbox uses an in-memory filesystem and must not be treated as durable merely because conversation state is stored in a Durable Object. Use a durable workspace or container-backed integration when files or installed artifacts must survive later activity.

Agent clients read materialized history or projected updates at `GET /agents/:name/:id`; see the [Streaming Protocol](https://flueframework.com/docs/api/streaming-protocol/).

## Interruption and recovery semantics

A deployment or code update can reset a Durable Object while an operation is running. Flue handles interrupted Cloudflare operations according to their execution model:

| Operation                                      | After interruption                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct attached agent HTTP prompt              | The accepted prompt remains queued independently of its transport. Flue requeues only when canonical input is provably absent, recognizes provably completed canonical output, and otherwise records a visible terminal interruption without blindly replaying provider work. No public agent run exists. |
| Dispatched agent input                         | Durable delivery and internal deduplication are keyed by dispatchId and persisted submission state, not by a run. Direct and dispatched inputs to one agent instance share one accepted order. Reconciliation uses the same conservative replay rules.                                                    |
| Flue workflow invocation (202 or ?wait=result) | Flue terminalizes the interrupted run as errored. An attached synchronous response may fail. Flue does not automatically start a replacement run.                                                                                                                                                         |

Cloudflare direct prompts and dispatched inputs enter one SQLite-backed submission queue owned by the target agent Durable Object. The attached transport observes accepted backend work but does not own it: losing an HTTP response does not cancel the accepted submission. Agent events are durably stored and can be replayed from any offset via the Durable Streams protocol.

Before provider processing starts, Flue persists canonical submitted input and records an operational input-application boundary. After interruption, Flue retries only when it can prove provider work did not cross that boundary. If replay safety is uncertain, it appends a framework interruption advisory to canonical session history and terminalizes the operational submission instead of risking duplicate model work or external effects. Later prompts to the same agent instance can see that factual advisory.

All Cloudflare workflow invocations use the same Fiber-backed durable admission path. The transport controls only whether the caller receives an immediate `{ runId }` receipt or waits for `{ runId, result }`. Run events are durably stored and can be streamed through `GET /runs/:runId` when the workflow exports `runs` middleware.

External effects remain application-owned. An interruption can leave the outcome of already-started model or tool activity uncertain, and an explicit caller retry can repeat effects. For dispatched agent work, correlate effects with `dispatchId` or an application-level idempotency key. Direct attached prompts do not expose a public receipt or replay API.

Flue persists workflow inputs with workflow run records before admitted work starts so operators can inspect the original input after an interruption. Flue does not automatically retry interrupted workflows. The caller or application should decide whether retry is appropriate and explicitly invoke the workflow again when needed. Use an application-level idempotency key when a repeated invocation may encounter external side effects from an earlier attempt. Agent submission payloads are likewise durable application data while queued and running. Settled submission data is retained indefinitely in this beta release. Dispatch receipt rows persist indefinitely as well, providing duplicate-delivery protection for repeated forwarding of one `dispatchId`; there is no public submission lookup API. Treat persisted inputs as sensitive: do not submit secrets unless your application retention and access policy permits storing them.

When Flue terminalizes an admitted interrupted workflow run, it emits `run_resume` before `run_end`, including when the interruption happened before live observers received `run_start`. This is recovery of terminal handling, not resumed or retried workflow code. Flue does not automatically propagate a trace carrier with dispatched input or preserve the original attached direct request after durable admission. For trace interpretation and application-owned HTTP extraction, see [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/#attach-application-trace-context).

Flue workflows do not resume from checkpointed durable steps after Durable Object interruption. For jobs that require durable step-level continuation, implement those steps with [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

### Beta persisted-schema boundary

Flue supports the Cloudflare Durable Object SQL table shape created by `v0.8.0` or newer. Existing supported SQLite-backed databases receive additive execution-store tables such as `flue_agent_submissions` at runtime and may retain unused historical columns; they do not require table rebuilds. Flue stamps every Durable Object database with its persisted schema version in a one-row `flue_meta` table the first time it opens it, and refuses to open a database stamped by a newer Flue version (for example, after rolling back a deploy). KV-backed Durable Object classes remain outside this boundary because Cloudflare cannot convert them to SQLite in place. Persisted agent session records still follow Flue’s beta session-data version boundary. Clear or separately migrate records written by an older session-data schema before upgrading.

## Sandbox context

`AGENTS.md` and skills are optional workspace-context files that the agent reads from its sandbox at `init()` time. They live at conventional paths inside whatever sandbox the agent is using — Flue looks for `<cwd>/AGENTS.md` and `<cwd>/.agents/skills/<name>/SKILL.md`. Whatever’s there gets loaded; whatever isn’t, doesn’t. Most agents don’t need either to do useful work.

If you want to use them, put them in your sandbox. How you do that depends on which sandbox you’re using: write them in via `session.shell()` or `session.fs` for the default virtual sandbox, or `COPY` them in for a container.

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/greet/SKILL.md`:

```markdown
---
name: greet
description: Generate a personalized greeting for a given name.
---

Given the name provided in the arguments, generate a warm, personalized
greeting. Keep it to one or two sentences.
```

**`AGENTS.md`** at the root of the sandbox is the agent’s system prompt — it provides global context about the project.

```markdown
You are a helpful assistant working on the my-project codebase.
Use the project's existing patterns and conventions.
```

Call a skill from your agent:

```typescript
const { data } = await session.skill('greet', {
  args: { name: 'World' },
  result: v.object({ greeting: v.string() }),
});
```

## Building and deploying

Flue compiles your project into a deployable artifact. For Cloudflare, this means a Workers-compatible bundle:

```bash
# Local development (reads local variables from .dev.vars or .env)
npx flue dev --target cloudflare

# One-off build for Cloudflare
npx flue build --target cloudflare

# Configure a deployed secret interactively, then deploy
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy --config dist/my-agent/wrangler.json
```

Every workflow that exports `route` gets an HTTP endpoint automatically. The middleware may authenticate the request and call `next()` to admit it. The route follows the pattern `/workflows/<name>` — for example, `.flue/workflows/translate.ts` becomes `/workflows/translate`.

```bash
# Hit your deployed workflow
curl https://my-support-agent.<your-subdomain>.workers.dev/workflows/translate?wait=result \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

Stream events from a deployed agent with `GET https://my-support-agent.<your-subdomain>.workers.dev/agents/chat/customer-123?offset=-1&live=sse`. Live reads require an `offset` — use `-1` to replay from the start, or `now` for future events only (see the [Streaming Protocol](https://flueframework.com/docs/api/streaming-protocol/)).

### Choosing a sandbox strategy

Here’s the progression of sandbox types available on Cloudflare, from simplest to most powerful:

1. **Empty virtual sandbox** — `defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }))`. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `session.shell()` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **Container sandbox** — Full Linux environment via `@cloudflare/sandbox`. For coding agents, complex dev environments, and anything that needs real system tools.

Start simple. Move up when you need to.

## Docs Navigation

Current page: [Deploy to Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

* [  Overview ](https://flueframework.com/docs/ecosystem/)

### Channels

* [ Discord ](https://flueframework.com/docs/ecosystem/channels/discord/)
* [ Facebook ](https://flueframework.com/docs/ecosystem/channels/messenger/)
* [ GitHub ](https://flueframework.com/docs/ecosystem/channels/github/)
* [ Google Chat ](https://flueframework.com/docs/ecosystem/channels/google-chat/)
* [ Intercom ](https://flueframework.com/docs/ecosystem/channels/intercom/)
* [ Linear ](https://flueframework.com/docs/ecosystem/channels/linear/)
* [ Microsoft Teams ](https://flueframework.com/docs/ecosystem/channels/teams/)
* [ Notion ](https://flueframework.com/docs/ecosystem/channels/notion/)
* [ Resend ](https://flueframework.com/docs/ecosystem/channels/resend/)
* [ Salesforce ](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/)
* [ Shopify ](https://flueframework.com/docs/ecosystem/channels/shopify/)
* [ Slack ](https://flueframework.com/docs/ecosystem/channels/slack/)
* [ Stripe ](https://flueframework.com/docs/ecosystem/channels/stripe/)
* [ Telegram ](https://flueframework.com/docs/ecosystem/channels/telegram/)
* [ Twilio ](https://flueframework.com/docs/ecosystem/channels/twilio/)
* [ WhatsApp ](https://flueframework.com/docs/ecosystem/channels/whatsapp/)
* [ Zendesk ](https://flueframework.com/docs/ecosystem/channels/zendesk/)

### Sandboxes

* [ boxd ](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
* [ Cloudflare Shell ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/)
* [ Cloudflare Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
* [ Daytona ](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
* [ E2B ](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
* [ exe.dev ](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
* [ islo ](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
* [ Mirage ](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)
* [ Modal ](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
* [ Vercel Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)

### Deploy

* [ AWS ](https://flueframework.com/docs/ecosystem/deploy/aws/)
* [ Cloudflare ](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
* [ Docker ](https://flueframework.com/docs/ecosystem/deploy/docker/)
* [ Fly.io ](https://flueframework.com/docs/ecosystem/deploy/fly/)
* [ GitHub Actions ](https://flueframework.com/docs/ecosystem/deploy/github-actions/)
* [ GitLab CI/CD ](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
* [ Node.js ](https://flueframework.com/docs/ecosystem/deploy/node/)
* [ Railway ](https://flueframework.com/docs/ecosystem/deploy/railway/)
* [ Render ](https://flueframework.com/docs/ecosystem/deploy/render/)
* [ SST ](https://flueframework.com/docs/ecosystem/deploy/sst/)

### Databases

* [ libSQL ](https://flueframework.com/docs/ecosystem/databases/libsql/)
* [ MongoDB ](https://flueframework.com/docs/ecosystem/databases/mongodb/)
* [ MySQL ](https://flueframework.com/docs/ecosystem/databases/mysql/)
* [ Postgres ](https://flueframework.com/docs/ecosystem/databases/postgres/)
* [ Redis ](https://flueframework.com/docs/ecosystem/databases/redis/)
* [ Supabase ](https://flueframework.com/docs/ecosystem/databases/supabase/)
* [ Turso ](https://flueframework.com/docs/ecosystem/databases/turso/)
* [ Valkey ](https://flueframework.com/docs/ecosystem/databases/valkey/)

### Tooling

* [ Braintrust ](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
* [ OpenTelemetry ](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
* [ Sentry ](https://flueframework.com/docs/ecosystem/tooling/sentry/)
* [ Vitest Evals ](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)
```


### Cloudflare Shell

```markdown
---
description: Use a durable Cloudflare Workspace with code-oriented agent operations.
title: Cloudflare Shell | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Cloudflare Shell

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/index.md) 

The Cloudflare Shell adapter adapts an application-owned `@cloudflare/shell` `Workspace` into a Flue sandbox on the Cloudflare target. Unlike a Linux shell sandbox, it provides a durable workspace and a model-facing `code` tool that executes JavaScript against workspace state through a Worker Loader binding.

## Quickstart

Add durable workspace sandbox capability to an existing Flue project with the [Cloudflare Shell](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox cloudflare-shell
```

## Overview

The blueprint installs `@cloudflare/shell` and `@cloudflare/codemode`, creates `<source-root>/sandboxes/cloudflare-shell.ts`, and adds a Worker Loader binding to Wrangler configuration. The generated adapter exports sandbox construction and default workspace helpers; its file API retries nested writes after recursively creating a missing parent directory.

```ts
// flue-blueprint: sandbox/cloudflare-shell@1
import { Workspace, WorkspaceFileSystem /* ... */ } from '@cloudflare/shell';
import { stateTools } from '@cloudflare/shell/workers';
import { DynamicWorkerExecutor, resolveProvider /* ... */ } from '@cloudflare/codemode';
import type { SandboxFactory, SessionToolFactory /* ... */ } from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';

export interface GetShellSandboxOptions {
  workspace: Workspace;
  loader: WorkerLoader;
  executor?: Pick<DynamicWorkerExecutorOptions, 'timeout' | 'globalOutbound' | 'modules'>;
}

export function getShellSandbox(options: GetShellSandboxOptions): SandboxFactory {
  /* ... generated workspace and Worker Loader validation ... */

  const { workspace, loader, executor: executorOptions } = options;
  const fs = new WorkspaceFileSystem(workspace);
  const executor = new DynamicWorkerExecutor({
    loader,
    ...executorOptions,
  });
  const stateProvider = resolveProvider(stateTools(workspace));
  const toolFactory: SessionToolFactory = () => [createCodeTool(executor, stateProvider)];

  return {
    async createSessionEnv() {
      return createWorkspaceSessionEnv(workspace, fs, '/');
    },
    tools: toolFactory,
  };
}

/* ... generated workspace session environment and code tool implementation ... */

export function getDefaultWorkspace(): Workspace {
  const { storage } = getCloudflareContext();
  return new Workspace({ sql: storage.sql });
}
```

Create a workspace, then pass it with the `worker_loaders` binding to `getShellSandbox(...)`. Agents receive durable file operations and the isolated JavaScript `code` tool; they do not receive Linux command execution. Application-specific data loading into the workspace remains application-owned.

## Configure

| Requirement                            | Purpose                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare target                      | **Required** — Runs the Workspace and Worker Loader integration.                                                                     |
| @cloudflare/shell package              | **Required** — Provides the durable Workspace.                                                                                       |
| @cloudflare/codemode package           | **Required** — Provides code-oriented model operations.                                                                              |
| worker\_loaders binding such as LOADER | **Required on Cloudflare** — Executes JavaScript against Workspace state; this is a Cloudflare binding, not an environment variable. |
| Environment-variable credentials       | **Not required** — The integration uses the worker\_loaders binding instead.                                                         |
| Ordinary Linux shell                   | **Not provided** — This adapter provides a model-facing code tool, not shell command execution.                                      |

Import the generated helpers from your project adapter file, not from `@flue/runtime/cloudflare`:

```ts
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';
```

## Choose this adapter when

Use Cloudflare Shell when files must be stored in a durable Workspace and agent work can be expressed through Workspace operations. It is not interchangeable with a container: `harness.shell(...)` and `session.shell(...)` do not provide Linux command execution through this adapter.

If the workspace should survive later user interactions, associate it with a stable addressable agent instance. A workspace created inside one workflow invocation belongs to that invocation’s owner rather than forming a shared cross-run workspace.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) and [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/).

## Docs Navigation

Current page: [Cloudflare Shell](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

* [  Overview ](https://flueframework.com/docs/ecosystem/)

### Channels

* [ Discord ](https://flueframework.com/docs/ecosystem/channels/discord/)
* [ Facebook ](https://flueframework.com/docs/ecosystem/channels/messenger/)
* [ GitHub ](https://flueframework.com/docs/ecosystem/channels/github/)
* [ Google Chat ](https://flueframework.com/docs/ecosystem/channels/google-chat/)
* [ Intercom ](https://flueframework.com/docs/ecosystem/channels/intercom/)
* [ Linear ](https://flueframework.com/docs/ecosystem/channels/linear/)
* [ Microsoft Teams ](https://flueframework.com/docs/ecosystem/channels/teams/)
* [ Notion ](https://flueframework.com/docs/ecosystem/channels/notion/)
* [ Resend ](https://flueframework.com/docs/ecosystem/channels/resend/)
* [ Salesforce ](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/)
* [ Shopify ](https://flueframework.com/docs/ecosystem/channels/shopify/)
* [ Slack ](https://flueframework.com/docs/ecosystem/channels/slack/)
* [ Stripe ](https://flueframework.com/docs/ecosystem/channels/stripe/)
* [ Telegram ](https://flueframework.com/docs/ecosystem/channels/telegram/)
* [ Twilio ](https://flueframework.com/docs/ecosystem/channels/twilio/)
* [ WhatsApp ](https://flueframework.com/docs/ecosystem/channels/whatsapp/)
* [ Zendesk ](https://flueframework.com/docs/ecosystem/channels/zendesk/)

### Sandboxes

* [ boxd ](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
* [ Cloudflare Shell ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/)
* [ Cloudflare Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
* [ Daytona ](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
* [ E2B ](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
* [ exe.dev ](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
* [ islo ](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
* [ Mirage ](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)
* [ Modal ](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
* [ Vercel Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)

### Deploy

* [ AWS ](https://flueframework.com/docs/ecosystem/deploy/aws/)
* [ Cloudflare ](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
* [ Docker ](https://flueframework.com/docs/ecosystem/deploy/docker/)
* [ Fly.io ](https://flueframework.com/docs/ecosystem/deploy/fly/)
* [ GitHub Actions ](https://flueframework.com/docs/ecosystem/deploy/github-actions/)
* [ GitLab CI/CD ](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
* [ Node.js ](https://flueframework.com/docs/ecosystem/deploy/node/)
* [ Railway ](https://flueframework.com/docs/ecosystem/deploy/railway/)
* [ Render ](https://flueframework.com/docs/ecosystem/deploy/render/)
* [ SST ](https://flueframework.com/docs/ecosystem/deploy/sst/)

### Databases

* [ libSQL ](https://flueframework.com/docs/ecosystem/databases/libsql/)
* [ MongoDB ](https://flueframework.com/docs/ecosystem/databases/mongodb/)
* [ MySQL ](https://flueframework.com/docs/ecosystem/databases/mysql/)
* [ Postgres ](https://flueframework.com/docs/ecosystem/databases/postgres/)
* [ Redis ](https://flueframework.com/docs/ecosystem/databases/redis/)
* [ Supabase ](https://flueframework.com/docs/ecosystem/databases/supabase/)
* [ Turso ](https://flueframework.com/docs/ecosystem/databases/turso/)
* [ Valkey ](https://flueframework.com/docs/ecosystem/databases/valkey/)

### Tooling

* [ Braintrust ](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
* [ OpenTelemetry ](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
* [ Sentry ](https://flueframework.com/docs/ecosystem/tooling/sentry/)
* [ Vitest Evals ](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)
```

### Cloudflare Sandbox

```markdown
---
description: Run Flue agent work inside Cloudflare container-backed sandboxes.
title: Cloudflare Sandbox | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Cloudflare Sandbox

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/index.md) 

Cloudflare Sandbox uses `@cloudflare/sandbox` to provide a container-backed Linux environment to a Flue application deployed on Cloudflare. This integration is platform-native: it is not an adapter module for a Node-target application.

## Quickstart

Add container-backed Linux sandbox capability to an existing Flue project with the [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox cloudflare
```

## Overview

Cloudflare Sandbox is a Cloudflare target integration rather than a generated adapter. In a Cloudflare-targeted project, the blueprint installs `@cloudflare/sandbox`; a workflow obtains the bound Durable Object with `getSandbox(...)`, wraps it with Flue’s `cloudflareSandbox(...)`, and passes that sandbox factory to an agent definition.

```ts
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';
import * as v from 'valibot';

type Env = { Sandbox: DurableObjectNamespace };

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent<Env>(({ id, env }) => ({
  sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
  model: 'anthropic/claude-opus-4-7',
}));

export default defineWorkflow({
  agent,
  input: v.object({ message: v.string() }),
  async run({ harness, input }) {
    return await (await harness.session()).prompt(input.message);
  },
});
```

The blueprint also exports `Sandbox` from `<source-root>/cloudflare.ts`, adds its Durable Object binding, a new migration entry, and its container declaration to `wrangler.jsonc`, and creates a project-root `Dockerfile` whose image tag matches the installed package version. The resulting workflow runs agent shell and file operations in the container-backed sandbox identified by the workflow run id. Cloudflare’s direct delete API does not expose recursive or force controls, so `cloudflareSandbox()` rejects either option before mutation. A Node-targeted project must migrate to the Cloudflare target before using this integration.

## Configure

| Requirement                                  | Purpose                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare target                            | **Required** — Runs the platform-native sandbox integration.                                                                 |
| @cloudflare/sandbox package                  | **Required** — Provides the Sandbox Durable Object and RPC client.                                                           |
| Container image                              | **Required** — Defines the Linux filesystem and command environment.                                                         |
| Durable Object/container binding             | **Required on Cloudflare** — Exposes the sandbox through Wrangler platform configuration; it is not an environment variable. |
| Stable sandbox identity and retention policy | **Required** — Controls lifecycle and reuse for the application.                                                             |
| Environment-variable credentials             | **Not required** — The platform integration uses Cloudflare bindings and deployment configuration instead.                   |

Cloudflare Sandbox requires a Worker deployment, Durable Object/container configuration, and a container image. Add the dependency to a Cloudflare-targeted project and export its Durable Object class from your Cloudflare deployment module:

```ts
// <source-root>/cloudflare.ts
export { Sandbox } from '@cloudflare/sandbox';
```

Declare the sandbox binding in Wrangler configuration, then wrap the RPC stub returned by `getSandbox(...)` with `cloudflareSandbox(...)` and pass it to an agent:

```ts
import { getSandbox } from '@cloudflare/sandbox';
import { defineAgent } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

type Env = { Sandbox: DurableObjectNamespace };

export default defineAgent<Env>(({ id, env }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
  cwd: '/workspace',
}));
```

## Choose this integration when

Use Cloudflare Sandbox when an agent on Cloudflare needs git, package installation, native binaries, or other Linux tooling. Prefer Cloudflare Shell instead when a durable workspace with Workspace-oriented operations is sufficient and a Linux toolchain is unnecessary.

Treat network egress, mounted data, credentials, and side effects as application security decisions. See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/#remote-sandboxes) and [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/).

## Docs Navigation

Current page: [Cloudflare Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

* [  Overview ](https://flueframework.com/docs/ecosystem/)

### Channels

* [ Discord ](https://flueframework.com/docs/ecosystem/channels/discord/)
* [ Facebook ](https://flueframework.com/docs/ecosystem/channels/messenger/)
* [ GitHub ](https://flueframework.com/docs/ecosystem/channels/github/)
* [ Google Chat ](https://flueframework.com/docs/ecosystem/channels/google-chat/)
* [ Intercom ](https://flueframework.com/docs/ecosystem/channels/intercom/)
* [ Linear ](https://flueframework.com/docs/ecosystem/channels/linear/)
* [ Microsoft Teams ](https://flueframework.com/docs/ecosystem/channels/teams/)
* [ Notion ](https://flueframework.com/docs/ecosystem/channels/notion/)
* [ Resend ](https://flueframework.com/docs/ecosystem/channels/resend/)
* [ Salesforce ](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/)
* [ Shopify ](https://flueframework.com/docs/ecosystem/channels/shopify/)
* [ Slack ](https://flueframework.com/docs/ecosystem/channels/slack/)
* [ Stripe ](https://flueframework.com/docs/ecosystem/channels/stripe/)
* [ Telegram ](https://flueframework.com/docs/ecosystem/channels/telegram/)
* [ Twilio ](https://flueframework.com/docs/ecosystem/channels/twilio/)
* [ WhatsApp ](https://flueframework.com/docs/ecosystem/channels/whatsapp/)
* [ Zendesk ](https://flueframework.com/docs/ecosystem/channels/zendesk/)

### Sandboxes

* [ boxd ](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
* [ Cloudflare Shell ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/)
* [ Cloudflare Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
* [ Daytona ](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
* [ E2B ](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
* [ exe.dev ](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
* [ islo ](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
* [ Mirage ](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)
* [ Modal ](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
* [ Vercel Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)

### Deploy

* [ AWS ](https://flueframework.com/docs/ecosystem/deploy/aws/)
* [ Cloudflare ](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
* [ Docker ](https://flueframework.com/docs/ecosystem/deploy/docker/)
* [ Fly.io ](https://flueframework.com/docs/ecosystem/deploy/fly/)
* [ GitHub Actions ](https://flueframework.com/docs/ecosystem/deploy/github-actions/)
* [ GitLab CI/CD ](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
* [ Node.js ](https://flueframework.com/docs/ecosystem/deploy/node/)
* [ Railway ](https://flueframework.com/docs/ecosystem/deploy/railway/)
* [ Render ](https://flueframework.com/docs/ecosystem/deploy/render/)
* [ SST ](https://flueframework.com/docs/ecosystem/deploy/sst/)

### Databases

* [ libSQL ](https://flueframework.com/docs/ecosystem/databases/libsql/)
* [ MongoDB ](https://flueframework.com/docs/ecosystem/databases/mongodb/)
* [ MySQL ](https://flueframework.com/docs/ecosystem/databases/mysql/)
* [ Postgres ](https://flueframework.com/docs/ecosystem/databases/postgres/)
* [ Redis ](https://flueframework.com/docs/ecosystem/databases/redis/)
* [ Supabase ](https://flueframework.com/docs/ecosystem/databases/supabase/)
* [ Turso ](https://flueframework.com/docs/ecosystem/databases/turso/)
* [ Valkey ](https://flueframework.com/docs/ecosystem/databases/valkey/)

### Tooling

* [ Braintrust ](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
* [ OpenTelemetry ](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
* [ Sentry ](https://flueframework.com/docs/ecosystem/tooling/sentry/)
* [ Vitest Evals ](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)
```


### Assistant-ui

```markdown
# Cloudflare Agents Integration
URL: /docs/integrations/frameworks/cloudflare-agents/overview

Wire Cloudflare's stateful agent framework into a React chat UI with assistant-ui via the standard AI SDK runtime. WebSocket transport, server-side persistence, tool calling, all preserved.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

[Cloudflare Agents](https://developers.cloudflare.com/agents/) is Cloudflare's framework for stateful AI agents that run on Durable Objects at the edge. Each agent owns its own SQLite-backed message history, exposes a WebSocket channel for low-latency streaming, and can call tools (server-side or client-side).

> [!info]
>
> This is an integration guide, not a runtime adapter. assistant-ui does not ship a `@assistant-ui/react-cloudflare-agents` package. `@cloudflare/ai-chat`'s `useAgentChat` returns a structural extension of the AI SDK's `useChat`, so the existing [AI SDK runtime](/docs/runtimes/ai-sdk/v6) consumes it directly.

## Architecture

Cloudflare Agents handles the server half: a Durable Object subclasses `AIChatAgent` from `@cloudflare/ai-chat`, owns the message history, and streams responses back over a WebSocket. `@cloudflare/ai-chat/react`'s `useAgentChat` hook wraps that WebSocket and exposes the same `messages`, `sendMessage`, `regenerate`, `status`, `stop`, `setMessages`, `addToolOutput` surface that the AI SDK's `useChat` does, plus a few Cloudflare-specific extras (`clearHistory`, `isServerStreaming`, `isToolContinuation`).

assistant-ui handles the client half. `useAISDKRuntime` from [`@assistant-ui/react-ai-sdk`](/docs/runtimes/ai-sdk/v6) reads exactly those AI SDK methods off whatever you pass in, so feeding it `useAgentChat`'s return value yields a fully-featured runtime: streaming, tool calling, edit, reload, history import and export, attachments, suggestions.

Shared adapters (attachments, speech, feedback, history) work the same way as described in [adapters](/docs/runtimes/concepts/adapters). Multi-thread support needs a [custom thread list](/docs/runtimes/concepts/threads) wired around `useAISDKRuntime`; [AssistantCloud](/docs/cloud) integrates via `useChatRuntime` (which constructs its own `useChat` internally) and is not compatible with the `useAgentChat` wiring shown here.

## Requirements

- A Cloudflare account with Workers enabled and `wrangler` installed.
- A frontend project (Next.js or any other AI-SDK-compatible React app).
- Model API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) configured as Worker secrets.

## Setup

The setup has two halves. Steps 1 to 4 happen in the **Worker** project (Cloudflare side); steps 5 to 7 happen in a **separate assistant-ui frontend**. You'll have two dev processes running by the end: `wrangler dev` for the Worker, and your frontend's dev server.

1. ### Scaffold the Worker project

   ```
   npm create cloudflare@latest my-agent -- --type=hello-world --ts
   cd my-agent
   ```

   Add the Cloudflare Agents packages and the AI SDK:

   ```bash
   npm install agents@0.12.4 @cloudflare/ai-chat@0.7.0 ai@latest @ai-sdk/openai@latest
   ```

   The two Cloudflare packages above are pinned to exact versions because `agents` and `@cloudflare/ai-chat` are pre-1.0 and ship breaking changes between minor releases. See [version stability](#version-stability) below before bumping them.

2. ### Define the agent

   `AIChatAgent` already implements message persistence, streaming protocol, and WebSocket plumbing. Override `onChatMessage` to plug in your model and tools.

   ```
   import { AIChatAgent } from "@cloudflare/ai-chat";
   import { openai } from "@ai-sdk/openai";
   import { streamText, convertToModelMessages } from "ai";

   export type Env = {
     OPENAI_API_KEY: string;
     Chat: DurableObjectNamespace<Chat>;
   };

   export class Chat extends AIChatAgent<Env> {
     async onChatMessage(onFinish: Parameters<typeof streamText>[0]["onFinish"]) {
       return streamText({
         model: openai("gpt-5.4-nano"),
         messages: await convertToModelMessages(this.messages),
         onFinish,
       });
     }
   }
   ```

   `Env` is exported alongside `Chat` so the Worker entry point can reuse the same type. The `Chat: DurableObjectNamespace<Chat>` field mirrors the binding declared in `wrangler.jsonc` (next step) and is what `routeAgentRequest` looks up to resolve the agent. `DurableObjectNamespace` is a global from `@cloudflare/workers-types`, which the `npm create cloudflare` scaffold sets up by default.

   `this.messages` is the persisted history for this Durable Object instance. Each unique agent `name` you connect with from the client (step 7) gets its own instance and its own message log.

3. ### Register the Durable Object and route requests

   ```
   import { routeAgentRequest } from "agents";
   import { Chat, type Env } from "./chat";

   export { Chat };

   const cors = (request: Request) => ({
     "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
     "Access-Control-Allow-Headers": "Content-Type, Upgrade",
     "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
   });

   export default {
     async fetch(request: Request, env: Env): Promise<Response> {
       if (request.method === "OPTIONS") {
         return new Response(null, { headers: cors(request) });
       }
       const upstream =
         (await routeAgentRequest(request, env)) ??
         new Response("Not found", { status: 404 });
       const res = new Response(upstream.body, upstream);
       for (const [k, v] of Object.entries(cors(request))) res.headers.set(k, v);
       return res;
     },
   } satisfies ExportedHandler<Env>;
   ```

   `routeAgentRequest` handles WebSocket upgrades, agent lookup by URL path, and the `/get-messages` HTTP endpoint that the frontend uses for history rehydration. The `cors` helper reflects the request origin so the frontend can talk to the Worker across ports during local development. WebSocket upgrades bypass CORS in the browser, but the `/get-messages` HTTP fetch and any custom routes need these headers. For production, replace the wildcard fallback with an explicit allowlist.

   Wire the Durable Object binding in `wrangler.jsonc`:

   ```
   {
     "name": "my-agent",
     "main": "src/index.ts",
     "compatibility_date": "2026-01-01",
     "compatibility_flags": ["nodejs_compat"],
     "durable_objects": {
       "bindings": [{ "name": "Chat", "class_name": "Chat" }]
     },
     "migrations": [
       { "tag": "v1", "new_sqlite_classes": ["Chat"] }
     ]
   }
   ```

   The binding `name` and `class_name` must match the exported class. `new_sqlite_classes` is required so the Durable Object can use SQLite for message storage.

4. ### Run the Worker locally

   Local `wrangler dev` reads environment variables from a `.dev.vars` file in the project root (not from the remote secret store):

   ```
   OPENAI_API_KEY=sk-...
   ```

   ```
   wrangler dev
   ```

   For production, upload the same key as a deployed Worker secret before `wrangler deploy`:

   ```
   wrangler secret put OPENAI_API_KEY
   ```

   The Worker boots on `http://localhost:8787`. Leave it running.

5. ### Initialize the assistant-ui frontend

   In a different directory:

   ```
   npx assistant-ui@latest create
   ```

   ```
   npx assistant-ui@latest init
   ```

   This creates a default chat page and a local API route at `app/api/chat/route.ts`. You won't use the local route, since the agent runs on the Worker; delete it once the next step is wired.

6. ### Install the Cloudflare client packages

   In the frontend project:

   ```bash
   npm install agents@0.12.4 @cloudflare/ai-chat@0.7.0
   ```

7. ### Wire the runtime

   ```
   "use client";

   import { useAgent } from "agents/react";
   import { useAgentChat } from "@cloudflare/ai-chat/react";
   import { AssistantRuntimeProvider } from "@assistant-ui/react";
   import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
   import { Thread } from "@/components/assistant-ui/thread";

   export const Assistant = () => {
     const agent = useAgent({
       agent: "Chat",
       name: "default",
       host: process.env.NEXT_PUBLIC_AGENT_HOST!,
     });
     const chat = useAgentChat({ agent });
     const runtime = useAISDKRuntime(chat);

     return (
       <AssistantRuntimeProvider runtime={runtime}>
         <Thread />
       </AssistantRuntimeProvider>
     );
   };
   ```

   Set the Worker URL in your frontend environment:

   ```
   NEXT_PUBLIC_AGENT_HOST=http://localhost:8787
   ```

   `NEXT_PUBLIC_*` exposes the value to the browser. In production, point this at your deployed Worker (e.g. `https://my-agent.example.workers.dev`).

   `name: "default"` is the Durable Object instance key. Pass a per-user value (a user ID, session ID, or chat ID) to give each user their own persisted history. Switching `name` from the client opens a new WebSocket connection to a different Durable Object instance.

## Notes

### Type compatibility with `useChat`

`useAgentChat`'s return type is `Omit<ReturnType<typeof useChat>, "addToolOutput"> & { ... }`. The `addToolOutput` option shape differs slightly between the two: `useChat` accepts `{ state, tool, toolCallId, ... }`; `useAgentChat` accepts `{ state, toolCallId, toolName?, ... }`. At runtime the call paths converge through `useAISDKRuntime` without issue (verified against `@cloudflare/ai-chat@0.7.0`). If the TypeScript compiler flags the call, cast at the call site: `useAISDKRuntime(chat as Parameters<typeof useAISDKRuntime>[0])`, or `chat as unknown as Parameters<typeof useAISDKRuntime>[0]` if TypeScript still refuses the direct cast. (`satisfies` does not help here; it validates assignability without changing the inferred type, so it surfaces the same error.)

### Cloudflare-specific extras

`useAgentChat` exposes three values that `useChat` does not:

- `clearHistory()` sends a `cf_agent_chat_clear` frame and wipes the Durable Object's SQLite store. Bind it to a "Clear chat" button if you need server-side history reset; `setMessages([])` alone only clears the client view.
- `isServerStreaming` is `true` while the server is pushing tokens, independent of client-initiated request state. Use it for a universal streaming indicator.
- `isToolContinuation` distinguishes "server auto-continuing after a tool result" from "user just sent a new message". Useful for typing-indicator gating.

Destructure these alongside `chat` and pass them into your UI directly; they don't need to flow through the runtime.

### `setMessages` round-trips through the Durable Object

`useAgentChat` overrides `setMessages` to broadcast the new list over the WebSocket so the Durable Object's SQLite history stays in sync. This means assistant-ui's `onImport`, `onEdit`, `onReload`, and pending-tool cancellation paths all persist server-side automatically. The tradeoff is one extra WebSocket round-trip per mutation, which can race if the connection is lagging; assume eventual consistency, not transactional.

### Authenticate the Worker before going to production

`routeAgentRequest` accepts any client that knows the agent class and `name`. If you derive `name` from a user ID (as recommended for per-user history), any client that knows or guesses another user's ID can connect to that Durable Object and read its full message log. Before deploying:

- Gate the fetch handler with a header or cookie check (e.g. a JWT issued by your auth backend), and only call `routeAgentRequest` after the request is authenticated.
- Pass the same credential from the frontend via `useAgent`'s `headers` or `query` options so the WebSocket upgrade carries it.
- Tighten the CORS `Access-Control-Allow-Origin` to an explicit allowlist; the wildcard in the example above is for local development only.

### Version stability

`agents` and `@cloudflare/ai-chat` are pre-1.0 and ship breaking changes between minor versions. Pin both to exact versions in `package.json` and read the Cloudflare changelog before bumping. The `useAgentChat` return shape has been additive since 0.3.0, so the integration above should keep working across patch releases.

## Related

- [Cloudflare Agents docs](https://developers.cloudflare.com/agents/) — Cloudflare's official guide: Durable Object lifecycle, WebSocket protocol, tool patterns, multi-agent routing.
- [AI SDK runtime](/docs/runtimes/ai-sdk/v6) — The runtime that handles the client side of this integration.

```
