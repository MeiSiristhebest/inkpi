export interface TextReadRequest {
  startLine?: number;
  maxLines?: number;
  maxBytes?: number;
}

export interface TextReadResult {
  text: string;
  snapshotBytes: number;
  scannedBytes: number;
  retainedBytes: number;
  skippedBytes: number;
  nextLine: number | null;
  truncated: boolean;
  scanLimitReached: boolean;
}

export interface DirectoryCursor {
  version: 1;
  path: string;
  offset: number;
  mtimeMs: number;
}

export interface DirectoryPage {
  entries: Array<{ name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }>;
  nextCursor: DirectoryCursor | null;
}

export interface OutputWindow {
  content: string;
  totalCharacters: number;
  skippedCharacters: number;
}

export interface ProcessRunRequest {
  /** A host-approved executable alias, never a shell command string. */
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ProcessProgress {
  stdout: OutputWindow;
  stderr: OutputWindow;
}

export interface ProcessRunResult extends ProcessProgress {
  exitCode: number | null;
  termination: 'exited' | 'cancelled' | 'timeout';
  durationMs: number;
}

/** Explicit host capability. Process execution is not an operating-system sandbox. */
export interface ExecutionEnv {
  readonly capabilities: { readonly write: boolean; readonly process: boolean };
  readText(path: string, request?: TextReadRequest, signal?: AbortSignal): Promise<TextReadResult>;
  listDirectory(path: string, limit?: number, cursor?: DirectoryCursor, signal?: AbortSignal): Promise<DirectoryPage>;
  writeText(path: string, text: string, signal?: AbortSignal): Promise<{ bytesWritten: number }>;
  editText(path: string, oldText: string, newText: string, signal?: AbortSignal): Promise<{ bytesWritten: number }>;
  runProcess(
    request: ProcessRunRequest,
    signal?: AbortSignal,
    onProgress?: (progress: ProcessProgress) => void
  ): Promise<ProcessRunResult>;
}
