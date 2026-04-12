const API_URL = ''

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface AuthUser {
  id: string
  username: string
  email: string
  runtime_mode: string
  created_at?: string
}

export interface SharedAgentInfo {
  runtime_mode: string
  agent_id: string
  workspace_dir: string
  upload_dir: string
  username: string
  status: string
}

export interface Session {
  key: string
  title?: string
  created_at: string | null
  updated_at: string | null
}

export interface SessionDetail {
  key: string
  messages: Array<{
    role: string
    content: string
    timestamp: string | null
  }>
  created_at: string | null
  updated_at: string | null
}

export interface AgentRunWaitResult {
  runId: string
  status: 'ok' | 'error' | 'timeout'
  startedAt: number | null
  endedAt: number | null
  error: unknown
}

const ACCESS_TOKEN_KEY = 'share-openclaw-access-token'
const REFRESH_TOKEN_KEY = 'share-openclaw-refresh-token'

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, access)
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
}

function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

export function isLoggedIn(): boolean {
  return getAccessToken() !== null
}

let refreshPromise: Promise<boolean> | null = null

async function parseErrorMessage(res: Response): Promise<string> {
  const fallback = `请求失败 (${res.status})`

  try {
    const body = await res.text()
    if (!body) return fallback

    try {
      const data = JSON.parse(body) as { detail?: string; message?: string }
      return data.detail || data.message || body || fallback
    } catch {
      return body || fallback
    }
  } catch {
    return fallback
  }
}

async function tryRefreshToken(): Promise<boolean> {
  const refresh = getRefreshToken()
  if (!refresh) return false
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      })
      if (!res.ok) return false
      const data: TokenResponse = await res.json()
      setTokens(data.access_token, data.refresh_token)
      return true
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

async function fetchJSON<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  let res = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (res.status === 401 && token) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      headers.Authorization = `Bearer ${getAccessToken()}`
      res = await fetch(`${API_URL}${path}`, { ...options, headers })
    } else {
      clearTokens()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json() as Promise<T>
}

export async function ssoLogin(infoxToken: string): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/sso', {
    method: 'POST',
    body: JSON.stringify({ infox_token: infoxToken, runtime_mode: 'shared' }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}

export async function login(username: string, password: string): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}

export async function register(username: string, email: string, password: string): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password, runtime_mode: 'shared' }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}

export function logout(): void {
  clearTokens()
  window.location.href = '/login'
}

export async function getMe(): Promise<AuthUser> {
  return fetchJSON<AuthUser>('/api/auth/me')
}

export async function getSharedAgentInfo(): Promise<SharedAgentInfo> {
  return fetchJSON<SharedAgentInfo>('/api/shared-openclaw/me')
}

export async function listSessions(): Promise<Session[]> {
  return fetchJSON<Session[]>('/api/shared-openclaw/sessions')
}

export async function getSession(key: string): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/api/shared-openclaw/sessions/${encodeURIComponent(key)}`)
}

export async function deleteSession(key: string): Promise<void> {
  await fetchJSON(`/api/shared-openclaw/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' })
}

export async function updateSessionTitle(key: string, title: string): Promise<{ ok: boolean; key: string; title: string | null }> {
  return fetchJSON(`/api/shared-openclaw/sessions/${encodeURIComponent(key)}/title`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  })
}

export async function sendChatMessage(message: string, sessionKey?: string | null): Promise<{ ok: boolean; runId: string | null; session_key: string }> {
  return fetchJSON('/api/shared-openclaw/chat', {
    method: 'POST',
    body: JSON.stringify({ message, session_key: sessionKey }),
  })
}

export async function waitForAgentRun(runId: string, timeoutMs = 25000): Promise<AgentRunWaitResult> {
  const params = new URLSearchParams({ timeoutMs: String(timeoutMs) })
  return fetchJSON<AgentRunWaitResult>(`/api/shared-openclaw/runs/${encodeURIComponent(runId)}/wait?${params.toString()}`)
}

export async function uploadFileToWorkspace(file: File): Promise<{ name: string; path: string }> {
  const formData = new FormData()
  formData.append('file', file)
  const token = getAccessToken()
  const res = await fetch(`${API_URL}/api/shared-openclaw/files/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  })
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json() as Promise<{ name: string; path: string }>
}
