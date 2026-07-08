import { Outlet, useNavigate } from 'react-router-dom';
import TopNavbar from './TopNavbar';
import ToastContainer from './ToastContainer';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useAppStore } from '@/store/useAppStore';

export default function AppLayout() {
  const navigate = useNavigate();
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  useHotkeys({
    'cmd+n': () => navigate('/upload'),
    'ctrl+n': () => navigate('/upload'),
    'cmd+b': toggleSidebar,
    'ctrl+b': toggleSidebar,
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
