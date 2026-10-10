# Owned tasks

Handlers can use `context.spawnChild(task)` to admit work into the same durable
router. Await admission and return the handler result; the router then enters
`completing`, releases the handler's scheduler slot, and waits for all owned
children. This permits chapter batches with a single foreground slot. A handler
must not hold that slot while waiting for a child in the same scheduling pool.

Scheduling mode and lifetime are separate. `mode: 'background'` selects the
background pool. `spawnChild(task, { detached: true })` gives the child an
independent lifetime. Parent cancellation leaves detached children running;
runtime shutdown interrupts every active task.

Cancellation reaches descendants before parents. Parent results wait for owned
handler cleanup. A failed child cancels its unfinished siblings and fails the
parent with `OWNED_CHILD_FAILED`. A child waiting for user input keeps its parent
in `completing`; resume the child or cancel the parent. Handler timeouts cover
handler execution, rather than time spent in `completing`.

Ownership and the parent's pending result are saved in execution metadata. After
restart, `resume(parentId)` resumes interrupted children and settles the saved
parent result without running the parent handler again. Completed children are
reused. Resuming failed children remains explicit.

The daemon registers `task.batch`. Submit a normal task with that kind and
`input.payload.tasks` containing chapter checks or other tasks. Its completed
result includes `childResults` in submission order. Batch ids are checked for
duplicates before any child is admitted.
