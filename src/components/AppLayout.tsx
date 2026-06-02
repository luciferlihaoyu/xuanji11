import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import TopNavbar from './TopNavbar';
import ToastContainer from './ToastContainer';
import CommandPalette from './CommandPalette';
import { useHotkeys } from '@/hooks/useHotkeys';

export default function AppLayout() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useHotkeys({
    'cmd+k': () => setPaletteOpen(true),
    'ctrl+k': () => setPaletteOpen(true),
    'cmd+n': () => navigate('/upload'),
    'ctrl+n': () => navigate('/upload'),
    'cmd+b': () => {}, // Toggle sidebar handled by page
    'ctrl+b': () => {},
    'esc': () => setPaletteOpen(false),
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
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
