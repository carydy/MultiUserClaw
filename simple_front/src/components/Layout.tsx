import { NavLink, Outlet } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { MessageSquare, Smartphone, LogOut } from 'lucide-react'
import { getMe, logout } from '../lib/api.ts'
import type { AuthUser } from '../lib/api.ts'

export default function Layout() {
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    getMe().then(setUser).catch(() => {})
  }, [])

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-accent-blue/15 text-accent-blue'
        : 'text-dark-text-secondary hover:text-dark-text hover:bg-dark-card'
    }`

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-dark-border bg-dark-sidebar px-4 py-2 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <img src="/openclaw-logo.webp" alt="OpenClaw" className="h-7 w-7 rounded-md" />
            <span className="text-sm font-semibold text-dark-text">OpenClaw Lite</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={linkClass}>
              <MessageSquare size={15} />
              对话
            </NavLink>
            <NavLink to="/wechat" className={linkClass}>
              <Smartphone size={15} />
              微信渠道
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <span className="text-xs text-dark-text-secondary">{user.username}</span>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-dark-text-secondary hover:text-accent-red transition-colors"
          >
            <LogOut size={14} />
            退出
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
