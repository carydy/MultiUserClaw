import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { login } from '../lib/api.ts'

export default function Login() {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return
    setLoading(true)
    setError('')
    try {
      await login(username.trim(), password)
      navigate('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark-bg">
      <div className="w-full max-w-[780px] rounded-xl border border-dark-border bg-dark-card p-6">
        <div className="mb-4 flex flex-col items-center gap-2">
          <img src="/openclaw-logo.webp" alt="OpenClaw" className="h-10 w-10 rounded-lg" />
          <h1 className="text-lg font-semibold text-dark-text">OpenClaw 智能助手</h1>
        </div>

        {error && (
          <div className="mb-3 rounded-lg bg-accent-red/10 p-3 text-sm text-accent-red">
            {error}
          </div>
        )}

        {loading && (
          <div className="mb-3 flex items-center justify-center gap-2 text-sm text-dark-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>正在登录...</span>
          </div>
        )}

        <form onSubmit={handlePasswordLogin} className="mx-auto max-w-sm space-y-4">
          <div>
            <label className="block text-xs text-dark-text-secondary mb-1">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-dark-border bg-dark-bg px-3 py-2 text-sm text-dark-text outline-none focus:border-accent-blue"
              placeholder="请输入用户名"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-dark-text-secondary mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-dark-border bg-dark-bg px-3 py-2 text-sm text-dark-text outline-none focus:border-accent-blue"
              placeholder="请输入密码"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !username.trim() || !password}
            className="w-full rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/90 transition-colors disabled:opacity-50"
          >
            登录
          </button>
        </form>
      </div>
    </div>
  )
}
