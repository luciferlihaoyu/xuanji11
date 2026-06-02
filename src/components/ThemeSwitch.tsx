import { Sun, Moon } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

export default function ThemeSwitch() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="relative flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-all duration-300"
      style={{
        borderColor: theme === 'dark' ? 'var(--accent-cyan)' : 'var(--border-active)',
        backgroundColor: theme === 'dark' ? 'rgba(0,229,255,0.08)' : 'var(--bg-tertiary)',
        color: theme === 'dark' ? 'var(--accent-cyan)' : 'var(--accent-amber)',
      }}
      title={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
    >
      {theme === 'dark' ? (
        <>
          <Moon className="w-3.5 h-3.5" />
          <span>深空</span>
        </>
      ) : (
        <>
          <Sun className="w-3.5 h-3.5" />
          <span>昼白</span>
        </>
      )}
    </button>
  );
}
