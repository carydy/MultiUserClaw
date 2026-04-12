import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import MarkdownContent from '../components/MarkdownContent.tsx'
import {
  deleteSession,
  getAccessToken,
  getSession,
  getSharedAgentInfo,
  listSessions,
  sendChatMessage,
  updateSessionTitle,
  uploadFileToWorkspace,
  waitForAgentRun,
} from '../lib/api.ts'
import type { Session, SessionDetail, SharedAgentInfo } from '../lib/api.ts'

interface PendingFile {
  id: string
  file: File
  name: string
}

function formatTime(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function Chat() {
  const [agentInfo, setAgentInfo] = useState<SharedAgentInfo | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(null)
  const [messages, setMessages] = useState<SessionDetail['messages']>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [renamingSessionKey, setRenamingSessionKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const activeSessionKeyRef = useRef<string | null>(null)
  const skipNextAutoLoadRef = useRef(false)
  const sseRef = useRef<EventSource | null>(null)
  const sseCompletedRef = useRef(false)
  const sseFinalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadAgentInfo = useCallback(async () => {
    const info = await getSharedAgentInfo()
    setAgentInfo(info)
  }, [])

  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const items = await listSessions()
      setSessions(items)
      setActiveSessionKey((current) => {
        if (current && items.some((item) => item.key === current)) return current
        return items[0]?.key || null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载会话失败')
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const loadSession = useCallback(async (key: string) => {
    setChatLoading(true)
    setError('')
    try {
      const detail = await getSession(key)
      setActiveSessionKey(key)
      setMessages(detail.messages || [])
      setStreamingText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载会话失败')
      setMessages([])
    } finally {
      setChatLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAgentInfo().catch((err: unknown) => setError(err instanceof Error ? err.message : '加载 Agent 信息失败'))
    fetchSessions().catch(() => {})
  }, [fetchSessions, loadAgentInfo])

  useEffect(() => {
    activeSessionKeyRef.current = activeSessionKey
  }, [activeSessionKey])

  useEffect(() => {
    if (activeSessionKey) {
      if (skipNextAutoLoadRef.current) {
        skipNextAutoLoadRef.current = false
        return
      }
      loadSession(activeSessionKey).catch(() => {})
    } else {
      setMessages([])
      setStreamingText('')
    }
  }, [activeSessionKey, loadSession])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending, streamingText])

  const hasContent = useMemo(() => input.trim().length > 0 || pendingFiles.length > 0, [input, pendingFiles])

  const handleNewSession = () => {
    setActiveSessionKey(null)
    activeSessionKeyRef.current = null
    setMessages([])
    setStreamingText('')
    setError('')
    setPendingFiles([])
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setPendingFiles((prev) => [
      ...prev,
      ...files.map((file) => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name: file.name })),
    ])
    e.target.value = ''
  }

  const handleChatEvent = useCallback((payload: any) => {
    const { state, sessionKey } = payload || {}
    const currentKey = activeSessionKeyRef.current
    if (!sessionKey || !currentKey || sessionKey !== currentKey) return

    if (state === 'delta' && payload.message) {
      const content = payload.message.content
      if (Array.isArray(content)) {
        const textPart = content.find((item: any) => item?.type === 'text')
        if (textPart?.text) setStreamingText(textPart.text)
      } else if (typeof content === 'string') {
        setStreamingText(content)
      }
      return
    }

    if (state === 'started') {
      setStreamingText('')
      return
    }

    if (state === 'final' || state === 'error' || state === 'aborted') {
      if (sseFinalTimerRef.current) clearTimeout(sseFinalTimerRef.current)
      sseFinalTimerRef.current = setTimeout(() => {
        const latestKey = activeSessionKeyRef.current
        if (!latestKey) {
          setStreamingText('')
          sseCompletedRef.current = true
          return
        }
        getSession(latestKey).then((detail) => {
          setMessages(detail.messages || [])
          setStreamingText('')
          setSending(false)
          sseCompletedRef.current = true
          fetchSessions().catch(() => {})
        }).catch(() => {
          setStreamingText('')
          setSending(false)
          sseCompletedRef.current = true
        })
      }, 1500)
    }
  }, [fetchSessions])

  useEffect(() => {
    const token = getAccessToken()
    if (!token) return

    const sse = new EventSource(`/api/shared-openclaw/events/stream?token=${encodeURIComponent(token)}`)
    sseRef.current = sse

    sse.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.event === 'chat' && msg.payload) {
          handleChatEvent(msg.payload)
        }
      } catch {
        // ignore malformed keepalive payloads
      }
    }

    return () => {
      if (sseFinalTimerRef.current) clearTimeout(sseFinalTimerRef.current)
      sse.close()
      sseRef.current = null
    }
  }, [handleChatEvent])

  const waitForResponse = async (sessionKey: string, runId: string | null) => {
    sseCompletedRef.current = false

    if (runId) {
      const startedAt = Date.now()
      while (!sseCompletedRef.current && Date.now() - startedAt < 120000) {
        const result = await waitForAgentRun(runId, 15000)
        if (sseCompletedRef.current) return
        if (result.status === 'timeout') continue
        if (result.status === 'error') {
          throw new Error(typeof result.error === 'string' ? result.error : '共享 Agent 运行失败')
        }
        break
      }
    }

    if (sseCompletedRef.current) return

    const detail = await getSession(sessionKey)
    setMessages(detail.messages || [])
    setStreamingText('')
    sseCompletedRef.current = true
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!hasContent || sending) return

    setSending(true)
    setError('')

    try {
      const uploadedPaths: string[] = []
      for (const pending of pendingFiles) {
        const result = await uploadFileToWorkspace(pending.file)
        uploadedPaths.push(result.path)
      }

      let finalMessage = text
      if (uploadedPaths.length > 0) {
        const refs = uploadedPaths.map((path) => `[附件: ~/.openclaw/${path}]`).join('\n')
        finalMessage = finalMessage ? `${finalMessage}\n\n${refs}` : refs
      }

      const optimisticParts: string[] = []
      if (text) optimisticParts.push(text)
      uploadedPaths.forEach((path) => optimisticParts.push(`📎 ${path.split('/').pop() || path}`))
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: optimisticParts.join('\n'), timestamp: new Date().toISOString() },
      ])
      setInput('')
      setPendingFiles([])

      setStreamingText('')
      const sendResult = await sendChatMessage(finalMessage, activeSessionKey)
      if (sendResult.session_key !== activeSessionKeyRef.current) {
        skipNextAutoLoadRef.current = true
        activeSessionKeyRef.current = sendResult.session_key
        setActiveSessionKey(sendResult.session_key)
      }
      await waitForResponse(sendResult.session_key, sendResult.runId)
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const handleDeleteSession = async (key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('确定删除这个会话？')) return
    try {
      await deleteSession(key)
      if (activeSessionKey === key) {
        setActiveSessionKey(null)
        setMessages([])
      }
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleSaveRename = async (key: string) => {
    if (renameSaving) return
    setRenameSaving(true)
    try {
      await updateSessionTitle(key, renameValue)
      setRenamingSessionKey(null)
      setRenameValue('')
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setRenameSaving(false)
    }
  }

  return (
    <div className="flex h-full bg-light-bg">
      <aside className="flex w-80 shrink-0 flex-col border-r border-light-border bg-light-sidebar">
        <div className="border-b border-light-border px-4 py-4">
          <div className="mb-3">
            <div className="text-sm font-semibold text-light-text">共享 Agent</div>
            <div className="mt-1 text-xs text-light-text-secondary">{agentInfo?.agent_id || '加载中...'}</div>
          </div>
          <button
            onClick={handleNewSession}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-blue px-3 py-2 text-sm font-medium text-white hover:bg-accent-blue/90"
          >
            <Plus size={16} />
            新建会话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {sessionsLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-light-text-secondary">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载会话中...
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-light-border bg-light-card p-4 text-sm text-light-text-secondary">
              还没有历史会话，直接发送第一条消息即可自动创建。
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => {
                const active = session.key === activeSessionKey
                return (
                  <div
                    key={session.key}
                    onClick={() => setActiveSessionKey(session.key)}
                    className={`cursor-pointer rounded-xl border px-3 py-3 transition-colors ${active ? 'border-accent-blue bg-accent-blue/5' : 'border-light-border bg-light-card hover:bg-light-card-hover'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        {renamingSessionKey === session.key ? (
                          <div className="space-y-2">
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-full rounded-lg border border-light-border px-2 py-1 text-sm outline-none focus:border-accent-blue"
                            />
                            <div className="flex items-center gap-2">
                              <button onClick={(e) => { e.stopPropagation(); void handleSaveRename(session.key) }} className="rounded-md bg-accent-blue px-2 py-1 text-xs text-white">
                                <Check size={12} />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setRenamingSessionKey(null); setRenameValue('') }} className="rounded-md border border-light-border px-2 py-1 text-xs text-light-text-secondary">
                                <X size={12} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="truncate text-sm font-medium text-light-text">{session.title || '未命名会话'}</div>
                            <div className="mt-1 text-xs text-light-text-secondary">{formatTime(session.updated_at)}</div>
                          </>
                        )}
                      </div>
                      {renamingSessionKey !== session.key && (
                        <div className="flex items-center gap-1">
                          <button onClick={(e) => { e.stopPropagation(); setRenamingSessionKey(session.key); setRenameValue(session.title || '') }} className="rounded-md p-1 text-light-text-secondary hover:bg-light-sidebar">
                            <Pencil size={14} />
                          </button>
                          <button onClick={(e) => void handleDeleteSession(session.key, e)} className="rounded-md p-1 text-light-text-secondary hover:bg-light-sidebar hover:text-accent-red">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-light-border px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-light-text">{activeSessionKey ? '会话详情' : '新的会话'}</div>
            <div className="text-xs text-light-text-secondary">workspace: {agentInfo?.workspace_dir || '-'}</div>
          </div>
          <button onClick={() => activeSessionKey && loadSession(activeSessionKey)} className="rounded-lg border border-light-border p-2 text-light-text-secondary hover:bg-light-card">
            <RefreshCw size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {chatLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-light-text-secondary">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载消息中...
            </div>
          ) : messages.length === 0 && !streamingText ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-light-text-secondary">
              <MessageSquare size={48} className="mb-4 opacity-30" />
              <div className="text-base font-medium text-light-text">开始一段新的对话</div>
              <div className="mt-2 max-w-md text-sm">该模式下每个用户共享同一个 OpenClaw 实例，但拥有自己独立的 Agent、会话和 workspace。</div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message, index) => {
                const isUser = message.role === 'user'
                return (
                  <div key={`${message.timestamp || index}-${index}`} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${isUser ? 'bg-accent-blue text-white' : 'bg-light-card border border-light-border text-light-text'}`}>
                      <div className="mb-1 text-xs opacity-70">{isUser ? '你' : 'Agent'} · {formatTime(message.timestamp)}</div>
                      {isUser ? <div className="whitespace-pre-wrap text-sm leading-6">{message.content}</div> : <MarkdownContent content={message.content} />}
                    </div>
                  </div>
                )
              })}
              {streamingText ? (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-2xl border border-light-border bg-light-card px-4 py-3 text-light-text shadow-sm">
                    <div className="mb-1 text-xs opacity-70">Agent</div>
                    <MarkdownContent content={streamingText} />
                    <span className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent-blue align-text-bottom" />
                  </div>
                </div>
              ) : sending ? (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-light-border bg-light-card px-4 py-3 text-sm text-light-text-secondary shadow-sm">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Agent 正在思考...
                  </div>
                </div>
              ) : null}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t border-light-border px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
              {error}
            </div>
          )}

          {pendingFiles.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingFiles.map((pending) => (
                <div key={pending.id} className="flex items-center gap-2 rounded-lg border border-light-border bg-light-card px-3 py-2 text-sm text-light-text-secondary">
                  <FileText size={14} />
                  <span>{pending.name}</span>
                  <button onClick={() => setPendingFiles((prev) => prev.filter((item) => item.id !== pending.id))}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 rounded-2xl border border-light-border bg-light-card p-3 shadow-sm">
            <button onClick={() => fileInputRef.current?.click()} className="rounded-xl border border-light-border p-2 text-light-text-secondary hover:bg-light-sidebar">
              <Paperclip size={18} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder="输入消息，支持上传文件到你的共享 workspace..."
              className="min-h-[72px] flex-1 resize-none border-0 bg-transparent text-sm outline-none placeholder:text-light-text-secondary"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!hasContent || sending}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-blue text-white hover:bg-accent-blue/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
