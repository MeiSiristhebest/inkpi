/**
 * HttpClient port.
 *
 * The AI providers need to perform HTTP requests, but they should not depend
 * on the global `fetch` directly. Production code uses `GlobalFetchHttpClient`
 * which delegates to the ambient global `fetch` (so existing tests that stub
 * `globalThis.fetch` keep working). Tests and alternative runtimes can inject a
 * custom `HttpClient` via `setHttpClient`.
 */
export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Default implementation. Delegates to the global `fetch` binding so that the
 * behavior is identical to a direct `fetch(...)` call, and so that tests which
 * replace `globalThis.fetch` continue to be exercised.
 */
export class GlobalFetchHttpClient implements HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, init);
  }
}

let activeHttpClient: HttpClient = new GlobalFetchHttpClient();

export function getHttpClient(): HttpClient {
  return activeHttpClient;
}

/**
 * Replace the active HTTP client. Pass `null` to restore the default
 * `GlobalFetchHttpClient`.
 */
export function setHttpClient(client: HttpClient | null): void {
  activeHttpClient = client ?? new GlobalFetchHttpClient();
}
