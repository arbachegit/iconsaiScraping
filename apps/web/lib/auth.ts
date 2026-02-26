/**
 * Centralized Auth Module
 *
 * Manages access + refresh tokens, auto-refresh on 401,
 * and provides fetchWithAuth for all authenticated API calls.
 */

const TOKEN_KEY = 'token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const API_BASE = '/api';

// ============================================
// TOKEN STORAGE
// ============================================

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  // Set cookie for middleware route protection
  document.cookie = 'has_session=1; path=/; max-age=604800; SameSite=Lax';
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  // Remove session cookie
  document.cookie = 'has_session=; path=/; max-age=0';
}

export function isAuthenticated(): boolean {
  const hasToken = !!getAccessToken();
  if (typeof document !== 'undefined') {
    if (hasToken && !document.cookie.includes('has_session=')) {
      // Sync cookie for middleware — user has tokens but cookie is missing
      document.cookie = 'has_session=1; path=/; max-age=604800; SameSite=Lax';
    } else if (!hasToken && document.cookie.includes('has_session=')) {
      // Clear stale cookie
      document.cookie = 'has_session=; path=/; max-age=0';
    }
  }
  return hasToken;
}

// ============================================
// TOKEN REFRESH
// ============================================

let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data = await res.json();
    setTokens(data.access_token, data.refresh_token || refreshToken);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

/**
 * Attempt to refresh the access token.
 * Deduplicates concurrent refresh requests.
 */
async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = refreshAccessToken().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

// ============================================
// FETCH WITH AUTH
// ============================================

/**
 * Authenticated fetch wrapper.
 * - Automatically attaches Authorization header
 * - On 401, attempts token refresh and retries once
 * - On final 401, clears tokens and redirects to login
 */
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getAccessToken();

  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  let res = await fetch(url, { ...options, headers });

  // If 401 and we have a refresh token, try refreshing
  if (res.status === 401 && getRefreshToken()) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const newToken = getAccessToken();
      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`);
      }
      res = await fetch(url, { ...options, headers });
    }
  }

  // If still 401 after refresh attempt, clear and redirect
  if (res.status === 401) {
    clearTokens();
    if (typeof window !== 'undefined' && !window.location.pathname.match(/^\/(set-password|verify|reset-password|recover-password)?$/)) {
      window.location.href = '/';
    }
  }

  return res;
}
