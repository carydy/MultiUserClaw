import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout.tsx'
import LoginPassword from './pages/LoginPassword.tsx'
import Chat from './pages/Chat.tsx'
import { isLoggedIn } from './lib/api.ts'

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPassword />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Chat />} />
      </Route>
    </Routes>
  )
}
