const activeWorkerExits = new Set<Promise<void>>();

/** Tracks worker lifetime until the dependency's actual worker-thread exit notification settles. */
export function trackCodemodeWorkerExit(exited: Promise<void>): void {
  activeWorkerExits.add(exited);
  const remove = () => activeWorkerExits.delete(exited);
  void exited.then(remove, remove);
}

/** Internal lifecycle count used by the runtime and integration tests. */
export function getActiveCodemodeWorkerCount(): number {
  return activeWorkerExits.size;
}
