import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, Bell, Settings, Command, Menu, X, Orbit } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';
import ThemeSwitch from './ThemeSwitch';

const navItems = [
  { label: '知识脑图', path: '/' },
  { label: '知识库', path: '/kb' },
  { label: '工作流', path: '/workflows' },
  { label: '备份', path: '/backups' },
  { label: '入库', path: '/ingestion' },
  { label: 'Agent 管理', path: '/agents' },
  { label: 'API 中心', path: '/api' },
  { label: '数据源', path: '/sources' },
  { label: '上传', path: '/upload' },
  { label: '分析', path: '/analytics' },
];

export default function TopNavbar() {
  const location = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocus, setSearchFocus] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const addToast = useAppStore((state) => state.addToast);
  const { data: user } = trpc.auth.me.useQuery();

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    window.location.hash = '/search?q=' + encodeURIComponent(trimmed);
  };

  const userInitial = (user?.name?.charAt(0).toUpperCase() ?? 'U');

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 flex items-center h-12 px-4 border-b"
      style={{
        background: 'linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-primary) 100%)',
        borderColor: 'var(--border-subtle)',
        borderBottomWidth: '1px',
        borderBottomStyle: 'solid',
      }}
    >
      {/* Brand - 科幻风 */}
      <Link to="/" className="flex items-center gap-2 mr-4 shrink-0 group">
        <div className="relative w-7 h-7 flex items-center justify-center">
          <Orbit className="w-6 h-6 text-[var(--accent-cyan)] group-hover:animate-rotate" style={{ animationDuration: '4s' }} />
          <div className="absolute inset-0 rounded-full" style={{ boxShadow: '0 0 8px var(--accent-cyan-dim)' }} />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-bold tracking-wider" style={{ 
            background: 'linear-gradient(135deg, var(--accent-cyan), var(--accent-gold))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>
            璇玑智脑
          </span>
          <span className="text-[8px] tracking-[0.2em] uppercase" style={{ color: 'var(--text-dim)', marginTop: '-2px' }}>
            XuanJi Brain
          </span>
        </div>
      </Link>

      {/* Divider — 科幻竖线 */}
      <div className="h-6 w-px mr-4" style={{ background: 'linear-gradient(180deg, transparent, var(--accent-cyan), transparent)' }} />

      {/* Desktop Nav */}
      <div className="hidden lg:flex items-center gap-0.5 mr-6">
        {navItems.map((item) => {
          const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className="relative px-3 py-1.5 text-[13px] font-medium rounded transition-all duration-200"
              style={{
                color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                backgroundColor: isActive ? 'var(--accent-cyan-dim)' : 'transparent',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              {item.label}
              {isActive && (
                <span className="absolute bottom-0 left-2 right-2 h-px rounded-full" style={{ background: 'linear-gradient(90deg, transparent, var(--accent-cyan), transparent)' }} />
              )}
            </Link>
          );
        })}
      </div>

      {/* Search */}
      <div className="flex-1 max-w-md mx-4 hidden md:block">
        <div
          className="flex items-center h-8 px-3 rounded-md border transition-all duration-200"
          style={{
            backgroundColor: 'var(--bg-tertiary)',
            borderColor: searchFocus ? 'var(--accent-cyan)' : 'var(--border-subtle)',
            boxShadow: searchFocus ? '0 0 0 2px var(--accent-cyan-dim), 0 0 12px rgba(0,229,255,0.1)' : 'none',
          }}
        >
          <Search className="w-4 h-4 mr-2" style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="搜索知识、文件、Agent..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text-primary)' }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocus(true)}
            onBlur={() => setSearchFocus(false)}
            onKeyDown={handleSearchKeyDown}
          />
          <span
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded font-mono"
            style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', color: 'var(--text-dim)' }}
          >
            <Command className="w-2.5 h-2.5" />K
          </span>
        </div>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2 ml-auto">
        <ThemeSwitch />

        <button
          className="relative p-2 rounded-md transition-colors duration-200"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-cyan)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
          onClick={() => addToast({ type: 'info', title: '通知功能开发中' })}
          aria-label="通知"
        >
          <Bell className="w-4 h-4" />
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--accent-red)', boxShadow: '0 0 4px var(--accent-red)' }} />
        </button>

        <Link
          to="/settings/appearance"
          className="p-2 rounded-md transition-colors duration-200 hidden sm:block"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-cyan)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          <Settings className="w-4 h-4" />
        </Link>

        <div
          className="w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold"
          style={{
            borderColor: 'var(--accent-cyan)',
            background: 'linear-gradient(135deg, rgba(0,229,255,0.2), rgba(167,139,250,0.2))',
            color: 'var(--accent-cyan)',
            boxShadow: '0 0 6px var(--accent-cyan-dim)',
          }}
        >
          {userInitial}
        </div>

        <button className="lg:hidden p-2 rounded-md ml-1" style={{ color: 'var(--text-muted)' }} onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="absolute top-12 left-0 right-0 border-b lg:hidden animate-fade-in" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          {navItems.map((item) => {
            const isActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/');
            return (
              <Link key={item.path} to={item.path} className="block px-4 py-2.5 text-sm font-medium" style={{ color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)' }} onClick={() => setMobileMenuOpen(false)}>
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
