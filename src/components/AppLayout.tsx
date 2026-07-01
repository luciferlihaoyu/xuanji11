import { Outlet, useNavigate } from 'react-router-dom';
import TopNavbar from './TopNavbar';
import ToastContainer from './ToastContainer';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useAuth } from '@/hooks/useAuth';

export default function AppLayout() {
  const navigate = useNavigate();

  const { user, isLoading } = useAuth({ redirectOnUnauthenticated: true });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  useHotkeys({
    'cmd+n': () => navigate('/upload'),
    'ctrl+n': () => navigate('/upload'),
    'cmd+b': () => {},
    'ctrl+b': () => {},
  });

  return (
    <div
      className="min-h-screen theme-transition"
      style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      <TopNavbar />
      <main className="pt-[48px]">
        <Outlet />
      </main>
      <ToastContainer />
    </div>
  );
}
