/**
 * Typed fetch helpers for the Next.js server proxies.
 * All paths are RELATIVE — the browser only ever talks to this app's /api/*.
 *
 * v2: the login JWT (localStorage 'razor.jwt') is attached automatically to
 * every call, and a 401 fires the 'razor:unauthorized' window event so the
 * AuthContext can drop the user back on the login screen.
 */

export const JWT_STORAGE_KEY = 'razor.jwt';

export function readJwt(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(JWT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeJwt(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(JWT_STORAGE_KEY, token);
    else window.localStorage.removeItem(JWT_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

function authHeaders(): Record<string, string> {
  const token = readJwt();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function onUnauthorized(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('razor:unauthorized'));
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  data: unknown;

  constructor(code: string, message: string, status: number, data: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function postJson<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  timeoutMs = 90_000
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError('NETWORK', message, 0);
  }
  const data = await parse(res);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(
      typeof data.error === 'string' ? data.error : `HTTP_${res.status}`,
      typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : 'Request failed',
      res.status,
      data
    );
  }
  return data as T;
}

export async function getJson<T = Record<string, unknown>>(path: string, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError('NETWORK', message, 0);
  }
  const data = await parse(res);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    throw new ApiError(
      typeof data.error === 'string' ? data.error : `HTTP_${res.status}`,
      typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : 'Request failed',
      res.status,
      data
    );
  }
  return data as T;
}

/** Rs 1 = 100 paise; format paise for display. */
export function formatInr(paise: number | null | undefined): string {
  if (typeof paise !== 'number' || Number.isNaN(paise)) return '—';
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
