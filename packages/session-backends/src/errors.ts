/**
 * 会话后端端口的错误类型。
 */

/**
 * 后端已关闭后再次被调用时抛出。
 *
 * 这是 `ISessionBackend.close()` 后置条件（见 `types.ts`）的运行时体现：
 * `close()` 之后，后端进入终止态，任何其它方法都必须拒绝，而不是静默写穿或返回陈旧数据。
 */
export class BackendClosedError extends Error {
  public readonly backendName: string;

  constructor(backendName: string) {
    super(`Session backend "${backendName}" is closed; operations are not permitted after close().`);
    this.name = 'BackendClosedError';
    this.backendName = backendName;
  }
}
