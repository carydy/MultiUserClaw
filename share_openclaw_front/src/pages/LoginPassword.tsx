import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { login, register } from '../lib/api'

export default function LoginPassword() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const isRegister = mode === 'register'

  const resetError = () => setError('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    resetError()

    if (isRegister) {
      if (!email.trim()) {
        setError('请输入邮箱')
        return
      }
      if (password.length < 6) {
        setError('密码至少需要 6 个字符')
        return
      }
      if (password !== confirmPassword) {
        setError('两次输入的密码不一致')
        return
      }
    }

    setLoading(true)
    try {
      if (isRegister) {
        await register(username.trim(), email.trim(), password)
      } else {
        await login(username.trim(), password)
      }
      navigate('/', { replace: true })
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : isRegister ? '注册失败' : '登录失败'
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-light-sidebar px-4">
      <div className="w-full max-w-md rounded-xl border border-light-border bg-light-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-blue text-lg font-semibold text-white">S</div>
          <h1 className="text-lg font-semibold text-light-text">MedClaw Shared</h1>
          <p className="text-sm text-light-text-secondary">共享 OpenClaw 轻量工作台</p>
        </div>

        <div className="mb-4 grid grid-cols-2 rounded-lg bg-light-bg p-1 text-sm">
          <button
            type="button"
            onClick={() => { setMode('login'); resetError() }}
            className={`rounded-md px-3 py-2 transition-colors ${!isRegister ? 'bg-accent-blue text-white' : 'text-light-text-secondary hover:text-light-text'}`}
          >
            密码登录
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); resetError() }}
            className={`rounded-md px-3 py-2 transition-colors ${isRegister ? 'bg-accent-blue text-white' : 'text-light-text-secondary hover:text-light-text'}`}
          >
            注册共享账号
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-accent-red/10 p-3 text-sm text-accent-red">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-2 block text-sm font-medium text-light-text">
              用户名
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-light-border bg-light-bg px-4 py-2.5 text-light-text placeholder-light-text-secondary focus:border-accent-blue focus:outline-none focus:ring-1 focus:ring-accent-blue disabled:opacity-50"
              placeholder="请输入用户名"
              disabled={loading}
              required
            />
          </div>

          {isRegister && (
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-light-text">
                邮箱
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-light-border bg-light-bg px-4 py-2.5 text-light-text placeholder-light-text-secondary focus:border-accent-blue focus:outline-none focus:ring-1 focus:ring-accent-blue disabled:opacity-50"
                placeholder="请输入邮箱"
                disabled={loading}
                required={isRegister}
              />
            </div>
          )}

          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-light-text">
              密码
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-light-border bg-light-bg px-4 py-2.5 text-light-text placeholder-light-text-secondary focus:border-accent-blue focus:outline-none focus:ring-1 focus:ring-accent-blue disabled:opacity-50"
              placeholder={isRegister ? '请设置密码（至少 6 位）' : '请输入密码'}
              disabled={loading}
              required
            />
          </div>

          {isRegister && (
            <div>
              <label htmlFor="confirmPassword" className="mb-2 block text-sm font-medium text-light-text">
                确认密码
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-lg border border-light-border bg-light-bg px-4 py-2.5 text-light-text placeholder-light-text-secondary focus:border-accent-blue focus:outline-none focus:ring-1 focus:ring-accent-blue disabled:opacity-50"
                placeholder="请再次输入密码"
                disabled={loading}
                required={isRegister}
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password || (isRegister && (!email || !confirmPassword))}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-blue px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-blue/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{isRegister ? '注册中...' : '登录中...'}</span>
              </>
            ) : (
              isRegister ? '注册并进入共享模式' : '登录'
            )}
          </button>
        </form>

        <div className="mt-4 space-y-2 text-center text-xs text-light-text-secondary">
          <p>{isRegister ? '在此页面注册的新账号会默认使用 shared 模式' : '使用您的账号密码登录共享模式'}</p>
          <Link to="/login" className="text-accent-blue hover:underline">
            返回扫码登录
          </Link>
        </div>
      </div>
    </div>
  )
}
