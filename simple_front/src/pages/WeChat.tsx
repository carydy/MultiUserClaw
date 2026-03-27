import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Loader2,
  Smartphone,
  PlugZap,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'
import {
  getAccessToken,
  listPlugins,
  getChannelsStatus,
} from '../lib/api.ts'
import type { ChannelAccountSnapshot } from '../lib/api.ts'

const WEIXIN_PLUGIN_NAME = 'openclaw-weixin'
const WEIXIN_LOGIN_COMMAND = `openclaw channels login --channel ${WEIXIN_PLUGIN_NAME}`

function base64UrlDecode(value: string): string {
  const base = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = base.length % 4 === 0 ? '' : '='.repeat(4 - (base.length % 4))
  return atob(base + pad)
}

function getTokenSubject(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return 'anonymous'
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    const sub = String(payload?.sub ?? '').trim()
    return sub || 'anonymous'
  } catch {
    return 'anonymous'
  }
}

function getWeixinTerminalSessionKey(token: string, attempt: number): string {
  return `weixin-login:${window.location.host}:${getTokenSubject(token)}:${attempt}`
}

export default function WeChat() {
  const [status, setStatus] = useState<'loading' | 'idle' | 'binding'>('loading')
  const [channelStatus, setChannelStatus] = useState<ChannelAccountSnapshot | null>(null)
  const [error, setError] = useState('')

  const fetchChannelStatus = useCallback(async () => {
    try {
      const result = await getChannelsStatus(true)
      const weixinAccounts = result.channelAccounts?.['weixin'] || result.channelAccounts?.['openclaw-weixin'] || []
      setChannelStatus(weixinAccounts[0] || null)
    } catch {
      setChannelStatus(null)
    }
  }, [])

  useEffect(() => {
    fetchChannelStatus().then(() => setStatus('idle'))
  }, [fetchChannelStatus])

  const isConnected = channelStatus?.connected === true || channelStatus?.running === true

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-accent-blue" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b border-dark-border shrink-0">
        <div className="flex items-center justify-between max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-green/10 text-2xl">
              🟩
            </div>
            <div>
              <h1 className="text-xl font-bold text-dark-text">微信渠道</h1>
              <div className="flex items-center gap-2 mt-1">
                <span className={`inline-block h-2 w-2 rounded-full ${isConnected ? 'bg-accent-green' : 'bg-gray-500'}`} />
                <span className="text-sm text-dark-text-secondary">
                  {isConnected ? '已连接' : '未连接'}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              setStatus('loading')
              fetchChannelStatus().then(() => setStatus('idle'))
            }}
            className="flex items-center gap-1.5 rounded-lg border border-dark-border px-3 py-1.5 text-xs text-dark-text-secondary hover:text-dark-text transition-colors"
          >
            <RefreshCw size={14} />
            刷新状态
          </button>
        </div>
      </div>

      {status === 'binding' ? (
        <WeixinBindPanel
          onDone={() => {
            setStatus('idle')
            fetchChannelStatus()
          }}
        />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
          {error && (
            <div className="rounded-lg bg-accent-red/10 p-3 text-sm text-accent-red flex items-center gap-2 max-w-md w-full">
              <AlertCircle size={16} />
              {error}
            </div>
          )}
          {isConnected ? (
            <div className="text-center">
              <div className="text-4xl mb-3">✅</div>
              <p className="text-dark-text font-medium">微信渠道已连接</p>
              <p className="text-sm text-dark-text-secondary mt-1">可以通过微信与 AI Agent 对话</p>
              <button
                onClick={() => setStatus('binding')}
                className="mt-4 rounded-lg border border-dark-border px-4 py-2 text-sm text-dark-text-secondary hover:text-dark-text transition-colors"
              >
                重新扫码绑定
              </button>
            </div>
          ) : (
            <div className="text-center">
              <Smartphone size={48} className="mx-auto mb-3 text-dark-text-secondary opacity-30" />
              <p className="text-dark-text font-medium">微信渠道未连接</p>
              <p className="text-sm text-dark-text-secondary mt-1">点击下方按钮扫码绑定微信</p>
              <button
                onClick={() => {
                  setError('')
                  setStatus('binding')
                }}
                className="mt-4 rounded-lg bg-accent-blue px-6 py-2 text-sm font-medium text-white hover:bg-accent-blue/90 transition-colors"
              >
                扫码绑定
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function WeixinBindPanel({ onDone }: { onDone: () => void }) {
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [connected, setConnected] = useState(false)
  const [running, setRunning] = useState(false)
  const [pluginReady, setPluginReady] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const outputRef = useRef<HTMLDivElement | null>(null)
  const hadSessionRef = useRef(false)

  useEffect(() => {
    if (!outputRef.current) return
    outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [output])

  useEffect(() => {
    let disposed = false
    let nextWs: WebSocket | null = null

    const connect = async () => {
      const token = getAccessToken()
      if (!token) {
        setError('未登录或 token 已失效')
        return
      }

      setError('')
      setConnected(false)
      setRunning(true)
      setPluginReady(false)
      hadSessionRef.current = false

      try {
        const plugins = await listPlugins()
        if (disposed) return
        const installed = plugins.some((plugin) => plugin.name === WEIXIN_PLUGIN_NAME)
        if (!installed) {
          setRunning(false)
          setError('未检测到微信插件 (openclaw-weixin)。请确认已安装该插件。')
          return
        }
        setPluginReady(true)
      } catch (err: any) {
        if (disposed) return
        setRunning(false)
        setError(err?.message || '获取插件列表失败')
        return
      }

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const wsUrl = `${proto}://${window.location.host}/api/openclaw/terminal/ws?token=${encodeURIComponent(token)}`
      nextWs = new WebSocket(wsUrl)
      const sessionKey = getWeixinTerminalSessionKey(token, attempt)

      nextWs.onopen = () => {
        if (disposed) return
        setConnected(true)
        setRunning(true)
        nextWs?.send(JSON.stringify({
          type: 'init',
          session_key: sessionKey,
          command: WEIXIN_LOGIN_COMMAND,
        }))
      }

      nextWs.onclose = (event) => {
        if (disposed) return
        setConnected(false)
        setRunning(false)
        setWs((current) => (current === nextWs ? null : current))
        if (!hadSessionRef.current) {
          const reason = event.reason?.trim()
          setError(reason ? `微信绑定终端未就绪: ${reason}` : '微信绑定终端未就绪')
        }
      }

      nextWs.onerror = () => {
        if (disposed) return
        setOutput((prev) => `${prev}\n[error] terminal websocket error\n`)
      }

      nextWs.onmessage = (evt) => {
        if (disposed) return
        try {
          const msg = JSON.parse(String(evt.data))
          if (msg.type === 'session') {
            hadSessionRef.current = true
            const reused = Boolean(msg.reused)
            setOutput((prev) => `${prev}[session] ${String(msg.session_key ?? '')} ${reused ? '(reused)' : '(new)'}\n`)
          } else if (msg.type === 'output') {
            const chunk = String(msg.data ?? '')
            setOutput((prev) => prev + chunk)
          } else if (msg.type === 'started') {
            setOutput((prev) => `${prev}[started] ${String(msg.command ?? '')}\n`)
          } else if (msg.type === 'exit') {
            setRunning(false)
            setOutput((prev) => `${prev}\n[exit] code=${String(msg.code)} signal=${String(msg.signal)}\n`)
            if (String(msg.code ?? '') === '0') {
              onDone()
            }
          } else if (msg.type === 'error') {
            setRunning(false)
            setError(String(msg.message ?? '微信绑定失败'))
          }
        } catch {
          setOutput((prev) => prev + String(evt.data))
        }
      }

      setWs(nextWs)
    }

    void connect()

    return () => {
      disposed = true
      try { nextWs?.close() } catch { /* ignore */ }
    }
  }, [attempt, onDone])

  const qrLinkMatch = output.match(/https:\/\/liteapp\.weixin\.qq\.com\/q\/[^\s]+/)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-3 border-b border-dark-border bg-dark-bg/40 shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className={`inline-flex items-center gap-1 ${connected ? 'text-accent-green' : 'text-dark-text-secondary'}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-accent-green' : 'bg-gray-500'}`} />
              {connected ? '终端已连接' : '终端未连接'}
            </span>
            <span className={`inline-flex items-center gap-1 ${running ? 'text-accent-yellow' : 'text-dark-text-secondary'}`}>
              <PlugZap size={12} />
              {running ? '扫码流程进行中' : '等待重新发起'}
            </span>
            <span className={`inline-flex items-center gap-1 ${pluginReady ? 'text-accent-green' : 'text-dark-text-secondary'}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${pluginReady ? 'bg-accent-green' : 'bg-gray-500'}`} />
              {pluginReady ? '微信插件已就绪' : '检查微信插件中'}
            </span>
          </div>
          {qrLinkMatch && (
            <div className="mt-3 rounded-lg bg-accent-green/10 p-3 text-sm text-accent-green">
              浏览器扫码链接：
              <a href={qrLinkMatch[0]} target="_blank" rel="noreferrer" className="ml-1 underline break-all">
                {qrLinkMatch[0]}
              </a>
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-lg bg-accent-red/10 p-3 text-sm text-accent-red flex items-center gap-2">
              <AlertCircle size={16} />
              {error}
            </div>
          )}
        </div>
      </div>

      <div
        ref={outputRef}
        className="flex-1 overflow-auto whitespace-pre-wrap bg-black px-6 py-4 font-mono text-xs leading-relaxed text-green-200"
      >
        {output || '正在连接微信绑定终端...'}
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-dark-border shrink-0">
        <button
          onClick={() => {
            try { ws?.close() } catch { /* ignore */ }
            setOutput('')
            setError('')
            setAttempt((value) => value + 1)
          }}
          className="rounded-lg border border-dark-border px-4 py-1.5 text-sm text-dark-text-secondary hover:text-dark-text transition-colors"
        >
          重新生成二维码
        </button>
        <button
          onClick={() => setOutput('')}
          className="rounded-lg border border-dark-border px-4 py-1.5 text-sm text-dark-text-secondary hover:text-dark-text transition-colors"
        >
          清空输出
        </button>
        <button
          onClick={() => {
            try { ws?.close() } catch { /* ignore */ }
            onDone()
          }}
          className="rounded-lg bg-accent-blue px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-blue/90 transition-colors"
        >
          返回
        </button>
      </div>
    </div>
  )
}
