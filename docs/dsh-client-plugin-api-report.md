# DeepSeek Harness (dsh) — Browser (client) Plugin API Report

Research target: write new plugins for the dsh browser client. Everything below was
read from the installed packages under
`C:\Users\KS\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
and from the reference plugin
`D:\work\mgc\deepseek-harness-kit\plugins\plugin-market\lib\client.js`.
Line references are to those exact files. No speculation — only what the code shows.

Package short names used below:

| package | file |
|---|---|
| `dsh-client-runtime` | `...\dsh-client-runtime\lib\client.js` |
| `dsh-client-modules` | `...\dsh-client-modules\lib\client.js` |
| `dsh-client-web` | `...\dsh-client-web\lib\index.js` |
| `dsh-client-web-react` | `...\dsh-client-web-react\lib\index.js` |
| `dsh-client-ui-slots` | `...\dsh-client-ui-slots\lib\index.js` |
| `dsh-client-locale` | `...\dsh-client-locale\lib\client.js` |
| `dsh-client-ui-sidebar` | `...\dsh-client-ui-sidebar\lib\client.js` |
| `dsh-client-ui-layout` | `...\dsh-client-ui-layout\lib\client.js` |
| `dsh-client-ui-workspace` | `...\dsh-client-ui-workspace\lib\client.js` |
| `dsh-client-ui-conversation` | `...\dsh-client-ui-conversation\lib\client.js` |
| `dsh-client-ui-settings-general` | `...\dsh-client-ui-settings-general\lib\client.js` |
| `dsh-client-ui-settings` | `...\dsh-client-ui-settings\lib\client.js` |
| `dsh-api-gateway` | `...\dsh-api-gateway\lib\client.js` |
| `cordis` | `...\cordis\lib\types\*.d.ts` |
| `cordis-plugin-loader` | `...\cordis-plugin-loader\lib\index.js` |
| `dsh-cordis-client-runner` | `...\dsh-cordis-client-runner\lib\client.js` |
| `plugin-market` | `D:\work\mgc\deepseek-harness-kit\plugins\plugin-market\lib\client.js` |

---

## 1. The `window.__ModuleLoader__.load` contract

### 1.1 What `__ModuleLoader__` is

It is installed **once per page** by the module system constructor in
`dsh-client-modules/lib/client.js` (lines 70–76):

```js
const win = globalThis;
if (win.__ModuleLoader__ !== void 0) throw new Error("client-modules: window.__ModuleLoader__ already installed (double boot?)");
win.__ModuleLoader__ = { load: (handoff) => {
    if (this.factories.has(handoff.id)) throw new Error(`client-modules: duplicate factory registration for "${handoff.id}" (bundle executed twice without invalidate?)`);
    this.factories.set(handoff.id, handoff.factory);
} };
```

So the **entire** contract is:

```js
window.__ModuleLoader__.load({ id: string, factory: (require) => moduleExports })
```

- `load` only **registers** a factory under `id`. It does **not** execute it.
- Executing the factory (materialization) happens lazily on first import/require
  (`dsh-client-modules/lib/client.js` lines 91–113):

```js
materialize(id) {
    const existing = this.loadCache.get(id);
    if (existing !== void 0) return existing;
    ...
    const record = {
        id,
        exports: registered(this.makeRequire(edges)),
        styles: claimStyles(id),
        edges
    };
    this.loadCache.set(id, record);
    return record;
}
```

- A duplicate `id` throws — one registration per id per page (unless `invalidate(id)`
  removed it, line 164–167).

### 1.2 The `factory(require)` signature

The factory is a CommonJS-shaped function. Every shipped bundle writes exactly
(`plugin-market/lib/client.js` lines 6–13, `dsh-client-locale/lib/client.js`
lines 1–10, same pattern everywhere):

```js
window.__ModuleLoader__.load({
    id: "@dsh-kit/plugin-market",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        let react = require("react");
        let prim = require("@deepseek-ai/dsh-client-ui-primitives");
        ...
        exports.NS = NS;
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
```

The factory returns the module's exports object. The loader's contract for a
plugin module is the **object-plugin** shape of cordis (see §2.1):
`exports.apply(ctx, config)`, optional `exports.inject` (array of service names),
optional `exports.name`.

### 1.3 How `require(spec)` resolves — the module table

`makeRequire` (`dsh-client-modules/lib/client.js` lines 121–132) — resolution
order for the synchronous `require` handed to factories:

```js
makeRequire(edges) {
    return (spec) => {
        edges.add(spec);
        if (this.seed.has(spec)) return this.seed.get(spec);        // 1. seed words
        if (this.statics.has(spec)) return this.statics.get(spec);  // 2. shell-own statics
        const id = stripClientSuffix(spec);                          //    "<id>/client" -> "<id>"
        const record = this.loadCache.get(id);                       // 3. memoized record
        if (record !== void 0) return record.exports;
        if (this.factories.has(id)) return this.materialize(id).exports; // 4. registered factory (recursive)
        throw new Error(`client-modules: require("${spec}") missed the module table — ...`);
    };
}
```

- `<pkg>/client` is normalized to `<pkg>` (line 28:
  `const stripClientSuffix = (spec) => spec.endsWith("/client") ? spec.slice(0, -7) : spec;`)
  — a bundle may require `"@deepseek-ai/dsh-client-runtime/client"` (see
  `dsh-client-locale/lib/client.js` line 10).
- Cross-plugin value imports are **not** possible in general: only registered
  factories can be required, and requiring a plugin that is registered but not yet
  loaded throws (fetching is async; the sync `require` cannot load).
- The **seed words** (what every bundle may require without registration) are the
  platform module table from `dsh-client-web/lib/index.js` lines 165–178:

```js
function getStaticModules() {
    return {
        "react": React,
        "react/jsx-runtime": ReactJsxRuntime,
        "react-dom": ReactDom,
        "react-dom/client": ReactDomClient,
        "@deepseek-ai/cordis": Cordis,
        "@deepseek-ai/dsh-client-ui-slots": UiSlots,
        "@deepseek-ai/dsh-client-web-react": WebReact,
        "@deepseek-ai/dsh-client-ui-primitives": UiPrimitives,
        "@deepseek-ai/dsh-client-ui-attachment": UiAttachment,
        "@deepseek-ai/dsh-client-schema-form": SchemaForm
    };
}
```

(Identical list as `PLATFORM_MODULES`, `dsh-client-web/lib/index.js` lines 423–434.)
So from a plugin bundle you can `require` those ten specifiers; everything else
(`@deepseek-ai/dsh-client-ui-sidebar`, `@deepseek-ai/dsh-client-runtime`, …) must be
a **registered factory** — i.e. only after that plugin's bundle was executed, and
only if it is in the boot graph. In practice the boot graph contains all shipped
client plugins, so `require("@deepseek-ai/dsh-client-runtime/client")` works at
materialization time because the runtime's own bundle is prefetched.

### 1.4 How a bundle gets loaded (boot)

`dsh-client-web/lib/index.js` `AppWebEntry.run()` (lines 326–356):

1. `parseBootManifest(globalThis.__DSH_BOOT__)` — the wire format
   (`dsh-client-modules/lib/client.js` lines 209–239):
   `{ rev: string, entries: [{ id, url, rev, inject?: string[], immediately?: boolean }] }`.
2. `new ClientModuleSystem({ modules, staticModules, ... })` — installs
   `window.__ModuleLoader__` (see §1.1).
3. Registers two shell-own statics (lines 333–334):
   `this.modules.registerStatic(APP_SHELL_ID, app_shell_exports)` and
   `this.modules.registerStatic(MODULES_ID, ModulesClient)` where
   `APP_SHELL_ID = "@deepseek-ai/dsh-client-app-shell"` (line 78).
4. `globalThis.__DSH_MODULES__ = this.modules` (line 335) — the kernel hands the
   module system to the `dsh-client-modules` plugin entry via
   `globalThis.__DSH_MODULES__` (`dsh-client-modules/lib/client.js` lines 246–250).
5. `this.ctx = new Context()` — a fresh cordis root context (line 348).
6. `await ctx.plugin(Loader)` (line 368), `loader.internal = this.modules`
   (line 370) — the vendored cordis loader imports through the client module system.
7. Creates one loader entry per boot row (`{ name: row.id }`, lines 377–386), then
   `loader.await()` and a full fiber sweep; on success flips `settled` so
   `AppRoot` renders `ctx.slots.renderSlot("root", {})` (lines 67, 341–345).

### 1.5 What "apply" gets

Each boot row becomes a loader entry whose plugin object is the bundle's exports.
`cordis-plugin-loader/lib/index.js` `_init()` (lines 509–521):

```js
async _init() {
    let plugin;
    try {
        plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, this.getOuterStack));
    } ...
    await this._start(plugin);
}
```

and `_start` (line 527): `fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, ...)`.
`unwrapExports` (lines 736–740) normalizes ESM default/CJS shapes. The cordis
registry treats the exports object as an object plugin (`{ apply(ctx, config) }`,
`inject`, `name` — see `cordis/lib/types/registry.d.ts` lines 50–81). So a client
plugin module is:

```js
exports.apply = (ctx) => { ... };   // plugin body
exports.inject = ["slots", "locale"]; // required services; fiber waits for them
exports.NS = "...";                   // (dsh convention, any extra exports allowed)
```

The fiber dependency state is `fiber.inject` (registry `Inject.resolve`,
`cordis-plugin-loader/lib/index.js` line 699) — a plugin whose `inject` services
are not all provided stays `pending` and the boot sweep fails loudly listing the
missing services (`dsh-client-web/lib/index.js` lines 396–413).

---

## 2. The full `ctx` shape in `apply(ctx)`

`ctx` is a **cordis `Context` proxy** (`cordis/lib/types/context.d.ts`). Core API
(from `cordis` type files; these are mixed onto every context):

| member | signature | source |
|---|---|---|
| `ctx.root` | the root context | `context.d.ts:21` |
| `ctx.baseUrl` | string \| undefined | `context.d.ts:23` |
| `ctx.events` / `ctx.registry` / `ctx.reflect` / `ctx.logger` | services | `context.d.ts:25-31` |
| `ctx.fiber` | the owning fiber (`.name`, `.uid`, `.config`, `.dispose()`, `.update()`, `.restart()`, `.await()`) | `fiber.d.ts:8-11, 97-199` |
| `ctx.on(name, listener, options?)` | → disposer | `events.d.ts:88` |
| `ctx.once(name, listener, options?)` | → disposer | `events.d.ts:97` |
| `ctx.emit(name, ...args)` | synchronous dispatch | `events.d.ts:44` |
| `ctx.parallel / serial / bail / waterfall(name, ...args)` | other dispatch modes | `events.d.ts:35-79` |
| `ctx.effect(execute, label?)` | run now, dispose on fiber unload; `execute` returns a disposer / iterable of disposers / promise; **throws `INACTIVE_EFFECT` on a dead fiber** | `fiber.d.ts:157-159` |
| `ctx.get(name, strict?)` | read a service; `undefined` when absent | `reflect.d.ts:6-16` |
| `ctx.set(name, value)` | overwrite own provided service | `reflect.d.ts:21-28` |
| `ctx.provide(name, value)` | provide a service owned by the current fiber; → disposer | `reflect.d.ts:41-43` |
| `ctx.reflect.provide(name, value, check?)` | same, lower-level; → disposer | `reflect.d.ts:144` |
| `ctx.accessor(name, {get, set?})` | computed ctx property | `reflect.d.ts:53` |
| `ctx.mixin(source, keys)` | forward members onto ctx (e.g. timer) | `reflect.d.ts:64-66` |
| `ctx.plugin(plugin, config?)` | load a plugin; → fiber | `registry.d.ts:120` |
| `ctx.inject(deps, callback)` | load a callback when deps available; → fiber | `registry.d.ts:111` |
| `ctx.extend(meta?) / isolate(name, label?) / intercept(name, config)` | scoped child contexts | `context.d.ts:70-99` |

### 2.1 Services a browser plugin can read off `ctx`

All services below are **provided by other client plugins**; declare them in your
`inject` array (or `ctx.get("name")` with an undefined check).

**`ctx.slots`** — the SlotRegistry cordis Service (`"slots"`), installed by the
runtime plugin (`dsh-client-runtime/lib/client.js` line 10472 `ctx.plugin(SlotRegistry)`;
service class lines 24–334). Members:

| member | signature |
|---|---|
| `slots.inject(key, callback)` | wait for slot `key`'s declaration, then run `callback` as an effect; → idempotent disposer (lines 55–114) |
| `slots.register(options, component)` | register a component into an already-declared slot; → disposer (lines 331–334, core semantics in ui-slots §3.2) |
| `slots.install(renderer)` | boot-once; the shell calls it with `createSlotRenderer()` (lines 121–129) |
| `slots.installLocale(face)` | boot-once; the locale plugin installs itself (lines 137–145) |
| `slots.renderSlot(key, owner)` | ctx-level render entry — **only `key === "root"`**; throws otherwise (lines 154–159) |
| `slots.entries(key)` | raw registered entries (lines 180–182) |
| `slots.entriesOfSlot(key)` | shadowing winners per cell (lines 192–194) |
| `slots.snapshot(root?)` | JSON-safe declaration tree (lines 200–202) |
| `slots.onEntryError(fn)` | observe entry crashes (lines 214–216) |
| `slots.spec(key)` | declared spec (lines 222–224) |
| `slots.subscribe(key, fn)` | registration-change subscription (lines 231–233) |
| `slots.getVersion(key)` | uSES version counter (lines 239–241) |

`slots.inject` semantics (lines 55–114): the callback runs **synchronously if the
slot is already declared**, otherwise inside the declaring `register()` call after
the declaration commits; a later declaration (re-declare) re-runs it; plugin unload
disposes everything. This is why the reference plugin wraps `register` in
`slots.inject(...)` — the sidebar's declaration of `sidebar.footer.action` may not
have landed yet when the plugin-market applies.

**`ctx.locale`** — LocaleRuntime (`"locale"`), provided by
`dsh-client-locale/lib/client.js` line 1193 `ctx.provide("locale", locale)`. See §4.

**`ctx.sessions`** — SessionRuntime (`"sessions"`), provided via
`rootCtx.reflect.provide("sessions", this, void 0)`
(`dsh-client-runtime/lib/client.js` line 8953). Members (lines 8855–9165):

- `list` — snapshot store `{ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress }` (lines 8865, 8913–8921)
- `currentProvideInfo` — getSnapshot/subscribe source for the current session's standard-props bundle (lines 8874, 8935)
- `provide(descriptor)` — register a per-session standard-props provider: `{ hooks: string[], props: string[], resolve(binding) => ({ hooks, props }) }`; hooks become `use<Name>` selector hooks on the render side, props spread verbatim; → disposer (lines 8965–8967, channel 8642–8783)
- `open(id)` (8972), `openSubagent(address)` (8979), `subagentAddress(id)` (8988), `setSubagentCatalogOpen(parentId, open)` (8996), `refreshSubagents(parentId)` (9003), `noteAgentPreset(sessionId, preset)` (9006), `clear()` (9016), `refresh()` (9023), `search(query, signal)` (9033)
- `create(opts?)` → Promise<sessionId>; throws `SessionCreateError` (9069–9074)
- `fork(opts: { sessionId, atSeq?, increaseTitle? })` → Promise<childId>; throws `SessionForkError` (9090–9106)
- `scope(id)` → scoped cordis ctx (9112–9114), `scopeOf(ctx)` (9123), `sessionOf(ctx)` (9135), `binding(id)` → `{ session, ... }` (9146–9148), `provideInfo(id)` (9156), `maybeProvideInfo(id)` (9163)
- `searchResultLimit = 20` (8863)

`binding(id).session` is the object-layer Session face (lines 7351–7460): `rename(title)`, `command(line)`, `open()`, `loadOlder()`, `resync()`, `subscribe(fn)`, `getSnapshot()`, `sessionId`, `projections`.

**`ctx.workspaces`** — WorkspaceRuntime (`"workspaces"`), provided via
`ctx.reflect.provide("workspaces", this, void 0)` (line 9848). Members (lines 9543–10063):

- `list` — snapshot store `{ items, archivedSessionIds, state, phase, error }` (lines 9664–9672; `subscribe`/`getSnapshot` 9653–9663)
- `create(input)` → Promise<Workspace> (9950–9954)
- `rename(workspaceId, title)` (9558), `delete(workspaceId)` (9572), `insertBefore(workspaceId, beforeWorkspaceId?)` (9584), `insertSessionBefore(workspaceId, sessionId, beforeSessionId?)` (9611), `archiveSession(sessionId)` (9626)
- `connectWorkspace(workspaceId)` → Promise<sessionId> (reuse blank session or create; 9862–9878)
- `startSession(workspaceId?)` — the shared New Session action (9930–9944)
- `createDirectory(path, name)` (9981), `listDirectory(path, signal)` (9970), `openPath(path)` (9993)
- `refresh()` (9645 area), `handleHostEnvelope(envelope)` (9636)

**`ctx.layout`** — LayoutController (`"layout"`), provided by
`dsh-client-ui-layout/lib/client.js` line 404 (`ctx.reflect.provide("layout", layout)`).
Members: `toggleSidebar()` (used by sidebar inject, `dsh-client-ui-sidebar/lib/client.js` line 262), `openDetails()`, `closeDetails()` (`dsh-client-ui-layout/lib/client.js` lines 330–336).

**`ctx.theme`** — ThemeRuntime (`"theme"`), provided by `dsh-client-ui-theme/lib/client.js` line 1276:
`getTheme()`, `exportInspectTokens()` (seen at `dsh-cordis-client-runner/lib/client.js` line 3630); emits `theme/change`.

**`ctx.modules`** — ClientModuleSystem (`"modules"`), provided by
`dsh-client-modules/lib/client.js` line 249: `import(specifier)`, `registerStatic(id, module)`, `prefetch(id)`, `invalidate(id)` (lines 133–167).

**`ctx.connection`** — the connection handle (`"connection"`), provided by
`dsh-client-connection/lib/client.js` line 10200. Members used by the runtime:
`connection.api` (wire client), `connection.start({ onMuxEnvelope, onHostEnvelope, onConnected, onStateChange })` → loop with `.stop()`, `connection.isLoopback`
(`dsh-client-runtime/lib/client.js` lines 10477–10503; `dsh-client-ui-settings/lib/client.js` line 210).

**`ctx.remote`** — ClientRemoteService (`"remote"`), provided by
`dsh-api-gateway/lib/client.js` (service class lines 23–34, `super(ctx, "remote")`).
Namespaces arrive as Typert descriptors; call sites look like
`ctx.remote.commands.execute(sessionId, line)`
(`dsh-client-runtime/lib/client.js` line 7371) and
`ctx.remote.dynamicCordisRunner.invoke(pluginId, pluginRunId, method, args)`
(`dsh-cordis-client-runner/lib/client.js` line 3997). Members: `$mount(contribution)`, `$on(event, listener)`, `$dispatch(event, args)`, `listeners(event)` (lines 35–89). Sub-namespaces such as `remote.commands` are declared as *services* (`"remote.commands"` appears in inject arrays, e.g. `dsh-client-runtime/lib/client.js` line 10466).

**`ctx.typert`** — TypertRegistry (`"typert"`), a cordis Service
(`dsh-typert-registry/lib/client.js` line 1151 `super(ctx, "typert")`). Used as
`ctx.typert.contexts.registerClient("agent", { identity: (candidate) => sessions.scopeOf(candidate) })`
(`dsh-client-runtime/lib/client.js` line 10479) and
`ctx.typert.remotes.register(contribution)` (`dsh-api-gateway/lib/client.js` line 97).

**`ctx.settingsScope`** — SettingsScopeBinder (`"settingsScope"`), a cordis Service
(`dsh-client-ui-settings/lib/client.js` line 195). Single method:
`ctx.settingsScope.bind({ namespace: string, ...spec })` → a scope controller with
`getSnapshot()`, `subscribe(fn)`, `set(field, value)`, `.value`
(`dsh-client-locale/lib/client.js` line 1184, `dsh-client-ui-theme/lib/client.js` line 1275).

**`ctx.appShell`** — `{ renderApp() }`, provided by the static app-shell entry
(`dsh-client-web/lib/index.js` lines 90–97).

**`ctx.loader`** — the vendored Loader (`cordis-plugin-loader`): `create(options)`, `resolve(id)`, `remove(id)`, `update(id, options, parent?, position?)`, `entries()`, `await()`, `internal` (lines 48–62, 160–221, 264).

**`ctx.timer`** — ClientTimerService plus mixed-in `ctx.timeout`, `ctx.interval`,
`ctx.throttle`, `ctx.debounce`, `ctx.setTimeout`, `ctx.setInterval`
(`dsh-cordis-client-runner/lib/client.js` lines 3733–3917).

Other services observed: `ctx.chatFileMentions` (`{ forClosing(owner) }`,
`dsh-client-ui-deliverables/lib/client.js` line 358), `ctx.cordisInspect`
(`dsh-cordis-client-runner/lib/client.js` line 1096), `ctx.dynamicCordisRunner`
(line 4061), `ctx.sessionLogDownload` (`dsh-session-log-export/lib/client.js`
line 237), `ctx.conversation` — a cordis Service `"conversation"`
(`dsh-client-ui-conversation/lib/client.js` lines 80–98 `super(ctx, "conversation")`),
also available per-session through `sessions.scope(id).get("conversation")`
(lines 9438–9444).

There is **no** `ctx.webServer`, `ctx.calls`, `ctx.store`, or `ctx.db` in the
browser client. Host calls go through `fetch` (the reference plugin does
`fetch("/plugin-market/...")`, `plugin-market/lib/client.js` lines 86–92) or the
dynamic-package `host.call` RPC (documented for cordis dynamic packages, see
`dsh-cordis-client-runner/lib/client.js` lines 3547–3583).

### 2.2 Events a plugin can listen to (`ctx.on`)

From `ctx.emit` call sites in client code: `"slots/changed"` (key)
(`dsh-client-runtime/lib/client.js` line 37), `"locale/change"` (snapshot)
(`dsh-client-locale/lib/client.js` line 1138), `"connection/reset"`
(`dsh-client-runtime/lib/client.js` line 10495), `"theme/change"` (snapshot)
(`dsh-client-ui-theme/lib/client.js` line 1225), plus loader/registry internals
`"loader/entry-init"`, `"loader/partial-dispose"`, `"internal/status"`,
`"internal/plugin"`, `"internal/config"`, `"internal/service"`,
`"internal/update"`, `"internal/get"`, `"internal/set"`, `"internal/listener"`,
`"internal/dispatch"` (`cordis-plugin-loader/lib/index.js` line 339;
`cordis/lib/types/events.d.ts` lines 216–239).

---

## 3. Every slot name (complete list) and the props each injected component receives

### 3.1 Slot kinds and the register() contract (`dsh-client-ui-slots/lib/index.js`)

`SlotCore.register(options, component)` (lines 64–144):

- Requires the slot to be **declared** first: `slot "${name}" is not declared (a parent entry's children table must declare it)` (line 66). The one a-priori declaration is `root` (`{ kind: "single", scope: "root" }`, seeded at construction, lines 55–63).
- Kinds and required options (lines 70–91):
  - `single` — one registration per priority; a second at the same priority throws.
  - `keyed` — requires `options.key`; one per `(key, priority)`.
  - `list` — requires `options.id`; one per `(id, priority)`.
  - `chain` — requires `options.select` (pure routing selector).
- Stored entry options (lines 105–120): `key`, `id`, `order`, `label` (string or thunk), `priority` (default 0; **lowest renders** — line 69), `select`, `inject`, `children` (declares child slots), `store` (a store handle, see below), `locale`, `registrant` (defaults to `ctx.fiber?.name`, runtime line 245).
- Declaring children: a `children` table commits specs for child keys; declaring an already-declared child throws (lines 92–95, 125–137); unload collapses children recursively (`releaseEntry`, lines 363–383).
- Ordering for list slots: `priority` then `order` ascending (line 122).
- Shadowing: for `single`/`keyed`/`list`, the first live entry per cell at the lowest priority wins (`entriesOfSlot`, lines 179–194). Chain slots consume every entry via `select`.

**Registering from a plugin** (the canonical pattern, `plugin-market/lib/client.js` lines 654–671):

```js
const inject = ["slots", "locale"];

function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-market: dictionaries");
    const t = ctx.locale.bind(NS);
    ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
            { name: "sidebar.footer.action", id: "plugin-market", order: 0, locale: NS },
            MarketFooterAction
        )
    );
    ...
}
```

### 3.2 The store option

`store` is a handle produced by `defineStore({ init, persist?, actions })`
(exported by the runtime, `dsh-client-runtime/lib/client.js` lines 5477–5506):

```js
function defineStore(decl) {
    return {
        spec: decl,
        create(scopeKey) {           // one instance per session scope
            const store = createSnapshotStore(decl.init(), ...);
            const actions = {};
            for (const key of Object.keys(decl.actions)) {
                actions[key] = (...params) => store.update((draft) => { decl.actions[key](draft, ...params); });
            }
            return { actions, getSnapshot, subscribe, store, clearPersisted };
        }
    };
}
```

`createSnapshotStore(init, opts)` (lines 5402–5432) returns
`{ getSnapshot, subscribe, update(mutator), set(next) }`; `{ persist: { name } }`
persists to `localStorage` (lines 5441–5456). The store instance axis lives in
`SlotRegistry` (runtime lines 294–329): root-scoped stores get one instance, session-scoped
stores one per session; instances are dropped with the session
(`pruneStoreScope`, lines 168–174).

### 3.3 Props every injected component receives (`dsh-client-web-react/lib/index.js`)

The renderer (`createSlotRenderer`, lines 750–757) composes each entry's props in
`renderEntry` (lines 494–512) / `standardKit` (lines 446–469) / `ContextualEntry`
(475–493). Final props are spread in this order (**owner props win**):

```js
{ ...kit, ...injected, ...slotInjected.props, ...(contextual), ...ownerProps }
```

- **`kit`** — the standard kit:
  - root scope: `useSessions` (selector hook over `sessions.list`), `useWorkspaces` (over `workspaces.list`) (lines 401–413).
  - session / session-maybe scopes add, from the current provide bundle (lines 419–432): every `hooks` member becomes a `use<Name>` selector hook — the runtime itself contributes `{ hooks: ["session"] }` (`dsh-client-runtime/lib/client.js` lines 8662–8665), so `useSession` is always present — plus `sessionId`, `useProjection(key, selector?, eq?)`, and every `props` member spread verbatim (e.g. `inputActions` from ui-conversation's `{ props: ["inputActions"] }` contribution, `dsh-client-ui-conversation/lib/client.js` lines 9504–9514). A `session-maybe` scope makes these hooks optional (return `undefined` with no session, lines 77–83, 422–427).
  - `t` — bound to `entry.locale` when declared (lines 449–453; binding via `localeSeat`, 305–321).
  - `useStore` + `actions` — when the entry declared a `store` (lines 454–458).
  - `renderSlot(key, ownerProps, opts?)` — only for keys declared in the entry's `children`; throws `SlotOwnershipError` otherwise; dies with the entry (`boundRenderSlot`, lines 147–164).
  - `renderSlotChain(key, ownerProps, opts?)` — same, for chain-kind children (lines 172–189).
  - `SessionProvider` — present when a child slot is `session` scope (line 462).
- **`injected`** — the entry's own `inject` face (`runInject`, lines 200–207; called as `inject(sessionId?, actions?)`). A `hooks` map inside the face is converted to `use<Name>` selector hooks (lines 212–222).
- **`slotInjected.props`** — the slot **spec's** `inject` face (the declarer's dispatcher-level inject; `cachedSlotInject`, lines 226–252).
- **`ownerProps`** — the props the rendering owner passes at its `renderSlot` call site (e.g. `{ wide }`, `{ locked }`, `{ inspect, onInspectDone }` — see the catalog below).

Render options `opts` passed to `renderSlot(key, owner, opts)`:
`{ only: id }` filters a list slot to one id (line 711), `{ entryKey: key }` dispatches a keyed slot (line 666), `{ fallback }` (rendered when empty/absent, lines 622–712), `{ overlay }` (chain overlay mode, lines 688–692), `{ hookContext }` (feeds slot-level hook factories, lines 626–627).

The authoritative per-slot contract table is `CLIENT_SLOT_API` in
`dsh-cordis-client-runner/lib/client.js` lines 2121–3524 — "Every slot the shipped
web bundle declares" — with `key`, `kind`, `scope`, `registerOptions`,
`ownerProps`, `standardProps`, `declaredBy`, `occupants`, `replaceRisk`, and a
copy-paste `example` per slot. The catalog below is that table, condensed.

### 3.4 Complete slot catalog (from `CLIENT_SLOT_API`, lines 2121–3524, plus declaration sites)

Scope legend: `root` = one instance app-wide; `session` = one per active session
(strict: not rendered with no session); `session-maybe` = same instance across the
no-session→session transition (adoption, `dsh-client-web-react/lib/index.js` lines 525–572).
`registerOptions`: `id` (list), `key` (keyed), `select` (chain), `order`, `label`.

**Frame / layout (declared by `root` entry — ui-layout AppFrame, `dsh-client-ui-layout/lib/client.js` lines 405–430):**

| slot | kind / scope | owner props at render site | notes |
|---|---|---|---|
| `root` | single / root | none (`children?: never`) | Built-in (ui-slots lines 55–63). Occupied by ui-layout AppFrame. DO NOT register (shadows the whole app; catalog lines 2969–2987). |
| `sidebar` | single / root | `{ collapsed: boolean, width: number }` | Whole left column. Occupied by ui-sidebar SidebarRoot (lines 3327–3343). |
| `conversation` | single / session-maybe | none (session facts via kit) | Whole center column. Occupied by ui-conversation ConversationRoot (lines 2123–2148). |
| `details` | single / session | none | Right details column; occupied by DetailsPanel (lines 2943–2967). |
| `shell.overlay` | list / root | none | Frame-wide floating layer, click-through; additive — your overlay lives here (lines 3289–3324). |

**Sidebar interiors (declared by ui-sidebar's `sidebar` entry, `dsh-client-ui-sidebar/lib/client.js` lines 265–283; catalog lines 3346–3419):**

| slot | kind / scope | owner props at render site (`SidebarRoot` lines 198–216) | notes |
|---|---|---|---|
| `sidebar.workspaces` | single / root | `{ wide: boolean, expandSidebar: () => void }` | The workspace/session browsing region ("会话" lives here). Occupied by ui-workspace WorkspaceBrowser. **single — a second registration replaces it.** |
| `sidebar.footer.action` | list / root | `{ wide: boolean }` | Footer actions beside Settings. **The additive sidebar seat — plugin-market registers here.** |
| `sidebar.settings` | single / root | `{ wide: boolean }` | Settings seat; occupied by ui-settings-general SettingsRoot. |
| `sidebar.workspaces.directoryFlow` | single / root | `{ open, busy, onPicked(path), onCancel, onError(msg) }` | Declared by WorkspaceBrowser (ui-workspace lines 2398–2407). Directory picker holes (browse/native). |

**Conversation interiors (declared by ui-conversation entries; lines 9515–9785, catalog lines 2150–2941):**

| slot | kind / scope | owner props at render site | notes |
|---|---|---|---|
| `conversation.session` | single / session | none | Entire session body; occupied by ConversationSession (2747–2771). |
| `conversation.session.header` | single / session | none | Title strip + tabs + action row (2774–2798). |
| `conversation.session.header.actions` | list / session | none | One button in the header action row — **additive per-session control** (2801–2848). |
| `conversation.session.header.utilities` | list / session | none | Right-aligned utilities (2851–2894). |
| `conversation.composer` | chain / session | `{ interactions, session }` (ComposerChainProps) | Composer takeover chain; `select`-routed; fallback is the composer bar (2312–2345). |
| `conversation.composer.bar` | single / session-maybe | `{ variant: 'hero'\|'composer', blocked?, disabled?, workspacePickerOpen?, ... }` | Default composer body (2348–2372). |
| `conversation.composer.dock` | list / session | `{ session, input }` (InputZone) | Band under the composer card; stats line lives here (2375–2418). |
| `conversation.input.dock` | list / session | `{ session, input }` (InputZone) | Full-width row above the composer card (queue/todo/goal bars) (2505–2552). |
| `conversation.input.left` | list / session | `{ session, input }` | Left end of the tool row inside the card (2555–2598). |
| `conversation.input.right` | list / session | `{ session, input }` | Right end of the tool row, before send (2701–2744). |
| `conversation.input.overlay` | list / session | none | InputBar floating overlay anchor (2628–2671). |
| `conversation.input.plan` | single / session | `{ locked: boolean }` | Plan-status seat (2674–2698). |
| `conversation.input.model` | single / session | `{ locked: boolean }` | Model-select seat (2601–2625). |
| `conversation.hero.workspace` | single / root | `{ open, anchorRef?, selectedId?, onPick(workspaceId), onClose }` | Hero workspace picker (2467–2483). |
| `conversation.hero.agentPreset` | single / root | none | Agent-preset chip on the new-session screen (2448–2464). |
| `conversation.hero.workspace.directoryFlow` | single / root | `{ open, busy, onPicked, onCancel, onError }` | Declared by WorkspacePicker (ui-workspace lines 2408–2416; catalog 2486–2502). |
| `conversation.view` | **list / session** | `{ inspect?: { callId } \| null, onInspectDone?: () => void }` | **The center-area TAB ring.** Each entry = one tab; rendered one-at-a-time with `{ only: activeId }`. Tabs show only when `tabs.length > 1` (ui-conversation lines 6995–7007, 7038–7044). Occupied by ChatView `id 'chat'`, TrajectoryView `id 'trajectory'` (2897–2940). |
| `conversation.chat.node` | keyed / session | `{ selectedCallId?, cwd?, openFile, inspectCall, forkAt, loadImage, fileMentions }` | Per-node-kind renderers; key domain is the node kind table (2228–2277; keys listed at 2254). |
| `conversation.chat.commandview` | keyed / session | `{ node, compaction? }` | Per slash-command row (2196–2225). |
| `conversation.chat.turnTail` | chain / session | `{ turn, seq, openFile }` | Extension chain under a completed turn (2280–2309). |
| `conversation.chat.assistant-actions` | list / session | `{ messageId }` | Action strip on one finalized assistant message (2150–2193). |
| `conversation.details.tool` | single / session | `{ block, cwd? }` | Details-panel body for a selected tool call (2421–2445). |

**Settings (declared by ui-settings-general's `sidebar.settings` entry, lines 540–569, and section entries; catalog lines 2989–3286):**

| slot | kind / scope | owner props | notes |
|---|---|---|---|
| `settings.trigger` | single / root | `{ wide }` | Sidebar-foot trigger content (3270–3286). |
| `settings.header` | single / root | none | Panel title text (3090–3106). |
| `settings.action` | list / root | none | Header actions before Close (2989–3024). |
| `settings.close` | single / root | none | Close button's visually-hidden label (3027–3043). |
| `settings.section` | list / root | `{ close: () => void }` | One settings page per entry (`id`, `order`, `label`) (3227–3267). |
| `settings.onboarding` | list / root | `{ stepId, complete, openSection(id) }` | Onboarding steps (3109–3144). |
| `settings.general.item` | list / root | none | One preference row in General (Language row registers here, `dsh-client-locale/lib/client.js` lines 1211–1218) (3046–3087). |
| `settings.plugins.tab` | list / root | none | One page inside the Plugins section (3189–3224). |
| `settings.plugin.item` | list / root | none | One plugin's card in the Plugins section (3147–3186). |

**Tool rows / cordis runner (catalog lines 3441–3522):**

| slot | kind / scope | owner props | notes |
|---|---|---|---|
| `tool.call.toolview` | keyed / session | `{ callId, toolName, block, cwd?, openFile, inspect? }` | Per wire-tool-name renderer; key domain open (3441–3486; taken keys listed at 3463). |
| `tool.view.cordis` | keyed / session | `{ pluginId, packageId, pluginRunId }` | Dynamic cordis package UI; dynamic client code registers `key: 'self'` (3489–3522). |

Every session-scope slot also receives the **standard kit** listed in §3.3
(`useSessions, useWorkspaces, useSession, sessionId, useProjection, useInput, inputActions`);
every root-scope slot receives `useSessions, useWorkspaces`.

---

## 4. The locale API (`dsh-client-locale/lib/client.js`)

### 4.1 Registration and binding

`LocaleRuntime` (lines 1002–1145). Service methods:

- `register(ns, localeOrDicts, dict?)` (lines 1084–1106):

```js
register(ns, localeOrDicts, dict) {
    const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
    let locales = this.dicts.get(ns);
    if (!locales) { locales = new Map(); this.dicts.set(ns, locales); }
    for (const [locale] of pairs) if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
    for (const [locale, entries] of pairs) locales.set(locale, entries);
    this.publish(this.snapshot.active, false);
    return () => { ... };   // disposer removes exactly the pairs this call added
}
```

  Two call forms: `ctx.locale.register("myNs", { zh: {...}, en: {...} })` (the
  reference plugin's form, `plugin-market/lib/client.js` line 657) or
  `register("myNs", "zh", {...})`.
  **A duplicate (ns, locale) pair throws** — there is no re-register/override of an
  existing namespace+locale.

- `bind(ns)` (lines 1107–1115) — memoized per namespace:

```js
bind(ns) {
    let t = this.bound.get(ns);
    if (!t) {
        t = (key, params) => this.translate(ns, key, params);
        this.bound.set(ns, t);
        return t;
    }
    return t;
}
```

- `translate(ns, key, params)` (lines 1116–1120):

```js
translate(ns, key, params) {
    const template = this.lookup(ns, key) ?? (ns !== "common" ? this.lookup("common", key) : void 0) ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
```

  Interpolation is `{name}` placeholders (the reference plugin uses
  `.replace("{name}", ...)` itself at `plugin-market/lib/client.js` line 521; the
  built-in `t` does it for you).

- `lookup(ns, key)` (lines 1121–1124):

```js
lookup(ns, key) {
    const locales = this.dicts.get(ns);
    return locales?.get(this.snapshot.active)?.[key] ?? locales?.get("zh")?.[key];
}
```

- `getLocale()` / `getSnapshot()` (lines 1037–1047) — immutable snapshot
  `{ active, locales, revision }` (`locales` is the fixed `[{id:"zh",label:"中文"},{id:"en",label:"English"}]`, lines 985–991).
- `subscribe(fn)` (lines 1055–1060) — notified on every snapshot change, including
  dictionary registration (registrations bump `revision` so already-rendered
  outlets refresh, lines 1048–1054, 1132–1144).
- `setLocale(id)` (lines 1065–1071) — only ids in `LOCALES`; persists through the
  settings scope (`host.set("preference", id)`).

### 4.2 Dictionary cascade

Per the class doc (lines 993–1001) the lookup chain per key is:

1. the entry's namespace in the **active locale**,
2. that namespace's **`zh` fallback**,
3. the shared **`common`** namespace (active, then zh) — `common` is registered by
   the locale plugin itself (lines 1185–1188) with the standard words
   (`ok/cancel/close/copy/…`, zh at 815–840, en at 844–869),
4. the **key itself** (missing text stays visible).

### 4.3 Overriding / translating the base English app strings — what is and isn't possible

This is the crux of question 4. From the code:

- **There is no per-key override API.** `register` is the only write path and it
  **throws** on an existing (ns, locale) pair (line 1091). You cannot re-register
  `common` (it already owns `zh`+`en`), nor any other shipped namespace
  (`sidebar`, `workspaces`-NS, `settings.*`, etc.), so you cannot patch another
  plugin's strings through the locale service.
- The cascade is per-namespace and falls through to `common`, never to a
  caller-owned override layer; there is no "user overrides" dictionary in
  `LocaleRuntime` at all.
- What you CAN do:
  - Register **your own namespace** and bind your components' `t` to it
    (`ctx.locale.register(NS, { zh, en })` + `ctx.locale.bind(NS)`), and pass
    `locale: NS` in your slot registrations so the renderer binds the `t` seat to
    your dictionary (`plugin-market/lib/client.js` lines 654–671).
  - For entries whose label is projected by the owner (settings sections,
    conversation view tabs, list-slot labels), supply `label: () => t("...")` as a
    thunk from your own namespace — `resolveSlotLabel` re-reads it on every
    projection (`dsh-client-ui-slots/lib/index.js` lines 19–21), and the
    settings docs explicitly note the registrant "re-registers with fresh text on
    locale change" (`dsh-cordis-client-runner/lib/client.js` line 3231).
  - Missing keys in your namespace fall back to `common`, so you inherit the
    standard words.
- The shipped app UI is not a single JSON i18n blob: each feature plugin registers
  its own namespace (e.g. the sidebar's `zh`/`en` at
  `dsh-client-ui-sidebar/lib/client.js` lines 224–236; the workspace browser's NS
  with `"section.sessions": "会话"` at `dsh-client-ui-workspace/lib/client.js`
  lines 2184–2239). There is no mechanism exposed to the client plugin API to
  patch those dictionaries globally. (The only app-wide override surface that
  exists is per-entry `locale` on *your own* registrations.)

---

## 5. How the sidebar registers its entries, and adding a second tab

### 5.1 Sidebar structure (`dsh-client-ui-sidebar/lib/client.js`)

The sidebar shell is `SidebarRoot`, registered **into the `sidebar` slot** (single)
by ui-sidebar (lines 265–283):

```js
ctx.effect(() => ctx.slots.register({
    name: "sidebar",
    locale: NS,
    children: {
        "sidebar.workspaces": { kind: "single", scope: "root" },
        "sidebar.settings":   { kind: "single", scope: "root" },
        "sidebar.footer.action": { kind: "list", scope: "root" }
    },
    inject: injectProps
}, SidebarRoot), "ui-sidebar: slot registration");
```

`injectProps` (lines 257–264) gives SidebarRoot `startSession(workspaceId)`
→ `ctx.workspaces.startSession(workspaceId)` and `toggleSidebar()`
→ `ctx.layout.toggleSidebar()`. SidebarRoot (lines 91–219) renders:

- logo row (brand button + collapse toggle),
- New Session button,
- `renderSlot("sidebar.workspaces", { wide, expandSidebar })` (line 200) — the
  browsing region,
- `renderSlot("sidebar.footer.action", { wide })` (line 211),
- `renderSlot("sidebar.settings", { wide })` (line 214).

### 5.2 Where "会话" comes from

The region is **not** rendered by the sidebar itself. `dsh-client-ui-workspace`
registers the browser into `sidebar.workspaces` (single slot) with its own
store + inject face (lines 2398–2407):

```js
ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
    name: "sidebar.workspaces",
    children: { "sidebar.workspaces.directoryFlow": { kind: "single", scope: "root" } },
    store: createWorkspaceViewStore(),
    inject: browserInjected,   // searchSessions, renameSession, forkSession, renameWorkspace,
                               // deleteWorkspace, insertWorkspaceBefore, archiveSession,
                               // insertSessionBefore, createWorkspace, hooks
    locale: NS
}, WorkspaceBrowser));
```

`WorkspaceBrowser` (component signature at line 1647:
`{ wide, expandSidebar, useSessions, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, insertSessionBefore, createWorkspace, searchSessions, searchResultLimit, useDirectoryFlow, renderSlot, t }`)
renders the section header labelled `t("section.sessions")` ("会话",
line 2188 of its NS dict) and the grouped/flat session list. It is a **self-contained
component with no pluggable sub-slots** (its only child slot is the directory-flow
hole, line 1953).

### 5.3 Adding a "second tab" to the sidebar

- There is **no first-party tab strip** in the sidebar and **no additive
  sub-slot** inside the browsing region. `sidebar.workspaces` is `single` — a
  second `register` at the same priority throws
  (`dsh-client-ui-slots/lib/client.js` lines 71–74); registering with a *different*
  `priority` would **shadow** the shipped WorkspaceBrowser (lowest priority wins,
  line 69), replacing the 会话 area entirely.
- The only **additive** sidebar surfaces are:
  - `sidebar.footer.action` (list) — what plugin-market uses; and
  - `shell.overlay` (list) for app-wide floating surfaces.
- To add a second tab **beside** 会话 you would have to shadow
  `sidebar.workspaces` with your own browser that reproduces the shipped one and
  adds your tab (the shipped browser's render/state is all internal to
  ui-workspace; the catalog's `replaceRisk: "shadows-shipped-ui"` for this seat,
  `dsh-cordis-client-runner/lib/client.js` lines 3402–3419). This is a
  replacement, not an extension point.

---

## 6. Hooks to render into the main/center workspace area

The center column is the `conversation` slot (single, session-maybe) rendered by
AppFrame (`dsh-client-ui-layout/lib/client.js` lines 228–237). Occupied by
ui-conversation's `ConversationRoot`, which declares the whole tree of
`conversation.*` seats (§3.4). The **additive** center-area hooks are:

1. **`conversation.view` (list / session) — the tab ring in the middle panel.**
   Register one entry per tab (`dsh-client-ui-conversation/lib/client.js` lines
   9710–9761 shows the shipped ChatView):

```js
slots.register({
    name: "conversation.view",
    id: "chat", order: 0,
    label: () => t("view.chat"),
    locale: NS,
    children: { "conversation.chat.node": { kind: "keyed", scope: "session", inject: CHAT_NODE_INJECT } },
    store: chatStore,
    inject: (sessionId, actions) => ({ openDetails, fileMentions, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt })
}, ChatView);
```

   The header builds tabs from `slots.entries("conversation.view")`
   (lines 9485–9501), renders a tablist only when more than one entry exists
   (lines 6995–7007), and mounts the active view with
   `renderSlot("conversation.view", { inspect, onInspectDone }, { only: active.id })`
   (lines 7038–7044). So a plugin adds a center tab with:

```js
ctx.slots.inject("conversation.view", () => ctx.slots.register(
    { name: "conversation.view", id: "my-view", order: 100, label: () => t("view.my"), locale: NS, store: myStore },
    MyViewComponent
));
```

   Your component receives the session kit (`useSession`, `sessionId`,
   `useProjection`, `useInput`, `inputActions`, …), `t`, `useStore`/`actions`,
   your `inject` face, and the owner props `{ inspect, onInspectDone }`.

2. **`conversation.session.header.actions` (list / session)** — a per-session
   button in the header action row (catalog lines 2801–2848).

3. **`conversation.input.dock` / `conversation.composer.dock` / `conversation.input.left` / `conversation.input.right` (list / session)** — composer-region chrome (queue/todo/goal bars live in `input.dock`; `dsh-client-ui-conversation/lib/client.js` lines 9772–9773 register dock entries via `ctx.plugin(todoDockEntry)` / `queueDockEntry`).

4. **`conversation.composer` (chain / session)** — full composer takeover via a
   `select`-routed entry (e.g. the approval panel, lines 9704–9709).

5. **`details` (single / session)** — the right column, if you want a side panel;
   occupied by DetailsPanel (lines 9774–9785).

---

## 7. Quick reference — a minimal plugin skeleton

```js
// my-plugin/lib/client.js
window.__ModuleLoader__.load({
    id: "my-plugin",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        let react = require("react");

        const NS = "myPlugin";
        const zh = { "tab.title": "我的页签" };
        const en = { "tab.title": "My tab" };

        function MyView({ t, useSession, sessionId, useStore, actions, renderSlot }) {
            return react.createElement("div", null, t("tab.title"));
        }

        const inject = ["slots", "locale", "sessions", "workspaces"];

        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), "my-plugin: dicts");
            ctx.slots.inject("conversation.view", () =>
                ctx.slots.register(
                    { name: "conversation.view", id: "my-plugin", order: 100, label: () => ctx.locale.bind(NS)("tab.title"), locale: NS },
                    MyView
                )
            );
        }

        exports.NS = NS;
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
```

Key facts to remember when writing a plugin:

- Register **inside** `ctx.slots.inject(key, cb)` — never call
  `ctx.slots.register` directly in `apply` for slots declared by other plugins;
  the declaration may not exist yet (runtime lines 55–114).
- Wrap everything that must be cleaned up on unload in `ctx.effect(...)` with a
  label; the disposers run automatically when the fiber unloads.
- `ctx.locale.register` **throws** on a duplicate namespace+locale — pick unique
  NS names and register exactly once per page (guarded by `ctx.effect`).
- `single` slots can only be shadowed (replace), `list`/`keyed`/`chain` slots are
  the additive extension points.
- Session-scope components must not assume a session exists only when the slot is
  `session-maybe`; strict `session` slots render nothing without one
  (`dsh-client-web-react/lib/index.js` lines 621–623).
