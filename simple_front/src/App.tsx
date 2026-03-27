import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.tsx'
import Login from './pages/Login.tsx'
import Chat from './pages/Chat.tsx'
import WeChat from './pages/WeChat.tsx'
import { isLoggedIn } from './lib/api.ts'

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Chat />} />
        <Route path="wechat" element={<WeChat />} />
      </Route>
    </Routes>
  )
}
