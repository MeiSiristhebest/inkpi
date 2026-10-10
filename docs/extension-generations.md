# Extension replacement

`ExtensionRunner` prepares each extension against a scoped API before changing
the live `ExtensionHost`. Tools, commands, shortcuts, events, context transforms
and hooks stay staged until the factory finishes. A failed factory leaves the
previous generation active. `loadAll` prepares the whole dependency ordered
group and checks registration collisions before replacing any member.

An `ExtensionModule` may declare `dependencies` by module name and an async
`dispose` callback. Missing dependencies and cycles are rejected before factories
run. A dependency cannot be unloaded while a live dependent remains. Runner
disposal drains callbacks in reverse dependency order and reports cleanup errors
after attempting every module.

Factories receive an `ExtensionGenerationAPI`, which adds `generation`, `signal`
and `onDispose(callback)` to the existing capability facets. The replacement
becomes visible before the previous signal is aborted. Saved callbacks reject
once their generation retires; tool progress and results that arrive after
retirement are fenced. Cleanup registrations are invoked in reverse order.
Registration ownership prevents an old disposer from removing a later binding,
including bindings registered with the same object.

`host.clear()` invalidates active and preparing generations. Call
`await runner.dispose()` to drain their resource cleanup; clearing registrations
alone does not await cleanup. Cleanup should close resources directly rather
than wait for another runner mutation from inside a queued mutation.

`DynamicPluginLoader` uses the runner when given an actual `ExtensionHost` and
exposes `dispose()`. ESM entry contents and CommonJS entry modules are reloaded;
CommonJS dependency modules retain Node's normal cache behavior. A plain custom
`ExtensionAPI` retains the existing direct factory path, which has no generation
replacement contract. Factories remain trusted in-process code; generation
ownership does not isolate filesystem or process effects made during preparation.

`tests/extension-generation.test.ts` exercises failed preparation, group collision,
host clearing, stale asynchronous tools, reverse cleanup and actual ESM/CommonJS
file replacement. Existing host, skill and daemon plugin integration tests cover
the shared registration path.
