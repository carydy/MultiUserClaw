// API client for OpenClaw Platform Gateway (multi-tenant mode)

// Always use relative URL to go through Vite proxy, avoiding CORS preflight
const API_URL = ''

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface AuthUser {
  id: string
  username: string
  email: string
  created_at: string
}

export interface AgentInfo {
  id: string
  name: string
  identity?: {
    name?: string
    emoji?: string
    avatar?: string
    theme?: string
    avatarUrl?: string
  }
}

export interface AgentListResult {
  defaultId: string
  mainKey: string
  scope: string
  agents: AgentInfo[]
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

export interface ChannelAccountSnapshot {
  accountId: string
  name?: string | null
  enabled?: boolean | null
  configured?: boolean | null
  linked?: boolean | null
  running?: boolean | null
  connected?: boolean | null
  reconnectAttempts?: number | null
  lastConnectedAt?: number | null
  lastError?: string | null
  mode?: string
  webhookUrl?: string
  [key: string]: unknown
}

export interface ChannelsStatusResult {
  ts: number
  channelOrder: string[]
  channelLabels: Record<string, string>
  channelDetailLabels?: Record<string, string>
  channelSystemImages?: Record<string, string>
  channelMeta?: Array<{
    id: string
    label: string
    detailLabel: string
    systemImage?: string
  }>
  channels: Record<string, unknown>
  channelAccounts: Record<string, ChannelAccountSnapshot[]>
  channelDefaultAccountId: Record<string, string>
}

export interface PluginInfo {
  name: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_KEY = 'openclaw_access_token'
const REFRESH_TOKEN_KEY = 'openclaw_refresh_token'

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
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

// ---------------------------------------------------------------------------
// Core HTTP helper
// ---------------------------------------------------------------------------

let refreshPromise: Promise<boolean> | null = null

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json() as { detail?: string; message?: string }
    return data.detail || data.message || `请求失败 (${res.status})`
  } catch {
    const body = await res.text()
    return body || `请求失败 (${res.status})`
  }
}

async function tryRefreshToken(): Promise<boolean> {
  const refresh = getRefreshToken()
  if (!refresh) return false

  // Deduplicate concurrent refresh attempts
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

export async function fetchJSON<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let res = await fetch(`${API_URL}${path}`, { ...options, headers })

  // On 401 attempt a silent token refresh and retry once
  if (res.status === 401 && token) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getAccessToken()}`
      res = await fetch(`${API_URL}${path}`, { ...options, headers })
    } else {
      clearTokens()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res))
  }

  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Auth functions
// ---------------------------------------------------------------------------

export async function login(
  username: string,
  password: string,
): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
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

// ---------------------------------------------------------------------------
// Agent functions
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<AgentListResult> {
  return fetchJSON<AgentListResult>('/api/openclaw/agents')
}

// ---------------------------------------------------------------------------
// Session functions
// ---------------------------------------------------------------------------

export async function listSessions(): Promise<Session[]> {
  return fetchJSON<Session[]>('/api/openclaw/sessions')
}

export async function getSession(key: string): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/api/openclaw/sessions/${encodeURIComponent(key)}`)
}

export async function deleteSession(key: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/sessions/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

export async function updateSessionTitle(
  key: string,
  title: string,
): Promise<{ ok: boolean; key: string; title: string | null }> {
  return fetchJSON<{ ok: boolean; key: string; title: string | null }>(
    `/api/openclaw/sessions/${encodeURIComponent(key)}/title`,
    {
      method: 'PUT',
      body: JSON.stringify({ title }),
    },
  )
}

// ---------------------------------------------------------------------------
// Chat functions
// ---------------------------------------------------------------------------

export async function sendChatMessage(
  sessionKey: string,
  message: string,
): Promise<{ ok: boolean; runId: string | null }> {
  return fetchJSON<{ ok: boolean; runId: string | null }>(
    `/api/openclaw/sessions/${encodeURIComponent(sessionKey)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  )
}

export async function waitForAgentRun(
  runId: string,
  timeoutMs = 25000,
): Promise<AgentRunWaitResult> {
  const params = new URLSearchParams({ timeoutMs: String(timeoutMs) })
  return fetchJSON<AgentRunWaitResult>(
    `/api/openclaw/runs/${encodeURIComponent(runId)}/wait?${params.toString()}`,
  )
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function getChannelsStatus(probe = false): Promise<ChannelsStatusResult> {
  const params = probe ? '?probe=true' : ''
  return fetchJSON<ChannelsStatusResult>(`/api/openclaw/channels/status${params}`)
}

// ---------------------------------------------------------------------------
// Plugins / Extensions
// ---------------------------------------------------------------------------

export async function listPlugins(): Promise<PluginInfo[]> {
  return fetchJSON<PluginInfo[]>('/api/openclaw/plugins')
}
