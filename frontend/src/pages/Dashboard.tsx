import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bot,
  Wrench,
  MessageSquare,
  Loader2,
} from 'lucide-react'
import { fetchAgents, fetchDashboardStats } from '../store/agents'
import type { BackendAgent, DashboardStats } from '../types/agent'

function StatCard({
  icon: Icon,
  iconColor,
  value,
  label,
}: {
  icon: React.ElementType
  iconColor: string
  value: string | number
  label: string
}) {
  return (
    <div className="rounded-xl border border-dark-border bg-dark-card p-5">
      <div className="flex items-start justify-between">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconColor}`}>
          <Icon size={20} className="text-white" />
        </div>
      </div>
      <div className="mt-4 text-3xl font-bold text-dark-text">{value}</div>
      <div className="mt-1 text-sm text-dark-text-secondary">{label}</div>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [agents, setAgents] = useState<BackendAgent[]>([])
  const [stats, setStats] = useState<DashboardStats>({ totalAgents: 0, totalSessions: 0, totalSkills: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchAgents(), fetchDashboardStats()])
      .then(([a, s]) => { setAgents(a); setStats(s) })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="animate-spin text-dark-text-secondary" size={32} /></div>

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-dark-text">仪表盘</h1>
        <p className="mt-1 text-sm text-dark-text-secondary">Agent 运营总览</p>
      </div>

      {/* Stat Cards */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        <StatCard
          icon={Bot}
          iconColor="bg-accent-purple"
          value={stats.totalAgents}
          label="Agent 总数"
        />
        <StatCard
          icon={MessageSquare}
          iconColor="bg-accent-blue"
          value={stats.totalSessions}
          label="会话总数"
        />
        <StatCard
          icon={Wrench}
          iconColor="bg-accent-green"
          value={stats.totalSkills}
          label="技能总数"
        />
      </div>

      {/* Agent Status Table */}
      <div className="rounded-xl border border-dark-border bg-dark-card">
        <div className="flex items-center justify-between border-b border-dark-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Bot size={20} className="text-accent-blue" />
            <h2 className="text-base font-semibold text-dark-text">Agents Overview</h2>
          </div>
          <button
            onClick={() => navigate('/agents')}
            className="rounded-lg border border-dark-border px-3 py-1.5 text-xs text-dark-text-secondary hover:bg-dark-card-hover hover:text-dark-text transition-colors"
          >
            查看全部
          </button>
        </div>

        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-dark-text-secondary">
              <th className="px-6 py-3 font-medium">Agent 名称</th>
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {agents.map(agent => (
              <tr
                key={agent.id}
                className="border-t border-dark-border/50 hover:bg-dark-card-hover transition-colors"
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-dark-bg">
                      {agent.identity?.emoji ? (
                        <span className="text-lg">{agent.identity.emoji}</span>
                      ) : (
                        <Bot size={18} className="text-accent-blue" />
                      )}
                    </div>
                    <div className="text-sm font-medium text-dark-text">{agent.name || agent.identity?.name || agent.id}</div>
                  </div>
                </td>
                <td className="px-4 py-4 text-sm text-dark-text-secondary">
                  {agent.id}
                </td>
                <td className="px-4 py-4 text-center">
                    <button
                      onClick={() => navigate(`/agents/${agent.id}`)}
                      className="rounded-lg border border-dark-border px-3 py-1 text-xs text-dark-text-secondary hover:bg-dark-card-hover hover:text-dark-text transition-colors"
                    >
                      查看
                    </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
