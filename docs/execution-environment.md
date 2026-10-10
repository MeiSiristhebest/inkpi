# Execution environment

The host may pass an `ExecutionEnv` through `DaemonOptions.executionEnv`, or grant its tools explicitly with `createExecutionEnvTools`. The daemon exposes no file or process tools when this option is omitted. Read, write and process grants appear separately in tool registration metadata. The domain port uses asynchronous operations; `NodeExecutionEnv` lives in the server adapter package. The older synchronous `FileSystem` port remains for host configuration and package management.

```ts
import { InkPiDaemon, NodeExecutionEnv } from '@inkpi/server';

const environment = new NodeExecutionEnv({
  root: '/approved/project',
  allowWrite: true,
  executables: { node: '/approved/runtime/node' },
  environment: { LANG: 'en_US.UTF-8' }
});
const daemon = new InkPiDaemon({ executionEnv: environment });
```

The root must already exist. File paths and process working directories resolve beneath its canonical path. Absolute paths within the root work; traversal and links resolving outside it fail. Each executable alias maps to an absolute path supplied by the host. Arguments pass directly to `spawn` with `shell: false`; tool calls cannot supply environment variables, and child processes do not inherit the daemon's environment. This is a capability for trusted host programs, not an operating-system sandbox: an approved program can access resources allowed by its OS account. Untrusted scripts require a separate isolated runtime.

Reads capture the initial file size and scan at most 16 MiB in chunks of at most 64 KiB. They decode UTF-8 across chunk boundaries and remove a leading BOM. The default retained limit is 32,000 UTF-8 bytes and 200 lines. Growing files are bounded by their original size. `scannedBytes` counts bytes read from the file handle; `skippedBytes` is scanned bytes minus retained UTF-8 bytes, including skipped prefixes, the BOM and unused data in the final chunk. `scanLimitReached` identifies an incomplete scan. A complete line boundary returns `nextLine`; an incomplete byte-limited line has no line cursor. Hosts may set their budgets when constructing the environment; tool arguments cannot increase them. Line scans start from the beginning, so very late ranges may require a different owner-side index.

`DocumentResourceAdapter.readRange` allows a resource owner to perform this scan before returning data. `read_resource` prefers that method and forwards cancellation. Existing adapters that implement only `read` retain compatibility, but their source reads are not bounded by the Runtime. List/search previews are bounded on return.

Directory pages use incremental directory enumeration rather than loading all names. A cursor binds the canonical directory, offset and modification time. Each page returns at most 200 entries in the filesystem's enumeration order. Directory changes reject the cursor instead of silently mixing versions. The scan offset is limited to 100,000 entries; the adapter does not promise lexicographic ordering.

File mutations reserve their canonical path in call order and run through a per-file queue. Other files execute independently. Edits require one exact match and retain unaffected bytes, BOM and line endings. The default file mutation limit is 2 MiB. Replacement writes a new file in the same directory, preserves existing permissions, flushes it, then renames it over the target. Failed or cancelled writes remove their temporary file. Cancelling a queued caller cannot remove another caller's active queue. Cancellation during an active operation waits for cleanup; once rename is underway, the committed result is returned. External processes changing the same file are outside this in-process queue, and these path checks do not establish protection against a hostile filesystem race.

Process execution drains stdout and stderr into separate windows of at most 32,000 UTF-16 characters. It retains the newest text, does not split decoded surrogate pairs, and reports the total and skipped character counts. Progress snapshots are time-limited (250 ms by default); tool checkpoints are requested at most once per second. Default process duration is 30 seconds, with a 120-second maximum. Timeout and cancellation kill the directly spawned child and await its close event before returning. Descendant process isolation belongs to the approved program or host. File writes and process calls use `replay: never`; read and listing tools use explicit versioned safe contracts.

Local Windows tests cover real files, UTF-8/BOM short reads, file growth, scan limits, traversal and directory links, paging, queued and active cancellation, concurrent edits, argv/cwd/environment, continuous output, child termination, production daemon registration and owner-side resource reads. A fresh child process also verifies a 100 MiB file is scanned within a 1 MiB budget with less than 64 MiB RSS growth. This does not substitute for Linux/macOS or a remote-host acceptance run.
