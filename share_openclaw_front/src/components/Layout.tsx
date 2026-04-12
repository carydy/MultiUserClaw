import { Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { LogOut, MessageSquare } from 'lucide-react'
import { getMe, logout } from '../lib/api.ts'
import type { AuthUser } from '../lib/api.ts'

export default function Layout() {
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    getMe().then(setUser).catch(() => {})
  }, [])

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-light-border bg-light-sidebar px-4 py-2 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-blue text-white font-semibold">S</div>
          <div>
            <div className="text-sm font-semibold text-light-text">MedClaw Shared</div>
            <div className="text-xs text-light-text-secondary">共享 OpenClaw 轻量工作台</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-light-card px-2 py-1 text-xs text-light-text-secondary">
            <MessageSquare size={14} />
            {user?.runtime_mode || 'shared'}
          </div>
          {user && (
            <span className="text-xs text-light-text-secondary">{user.username}</span>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-light-text-secondary hover:text-accent-red transition-colors"
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
