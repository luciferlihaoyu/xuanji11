import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { Search, ArrowRight, X } from 'lucide-react';

interface Command {
  id: string;
  label: string;
  description: string;
  icon?: string;
  path: string;
  category: 'page' | 'action';
}

const COMMANDS: Command[] = [
  { id: 'knowledge-graph', label: '鐭ヨ瘑鑴戝浘', description: 'D3.js 鍔涘鍚戠煡璇嗗浘璋?, icon: '鈽?, path: '/', category: 'page' },
  { id: 'knowledge-base', label: '鐭ヨ瘑搴?, description: '鏂囨。绠＄悊涓庣紪杈戝櫒', icon: '馃摎', path: '/kb', category: 'page' },
  { id: 'workflow', label: '宸ヤ綔娴佺紪鎺?, description: '鍙鍖栬妭鐐圭紪绋?, icon: '鈿?, path: '/workflows', category: 'page' },
  { id: 'agents', label: 'Agent 绠＄悊', description: '鏅鸿兘鍔╂墜绠＄悊', icon: '馃', path: '/agents', category: 'page' },
  { id: 'datasources', label: '鏁版嵁婧?, description: '浜戠洏 / NAS 鏁版嵁鎺ュ叆', icon: '馃敆', path: '/sources', category: 'page' },
  { id: 'upload', label: '鏂囦欢涓婁紶', description: '涓婁紶鏂囦欢骞跺悜閲忓寲', icon: '馃摛', path: '/upload', category: 'page' },
  { id: 'api-center', label: 'API 涓績', description: '鎺ュ彛鏂囨。涓庤皟璇?, icon: '馃攲', path: '/api', category: 'page' },
  { id: 'settings', label: '绯荤粺璁剧疆', description: '涓婚銆佸亸濂借缃?, icon: '鈿?, path: '/settings/theme', category: 'page' },
  { id: 'search', label: '鍏ㄥ眬鎼滅储', description: '鍏ㄦ枃 + 鍚戦噺璇箟鎼滅储', icon: '馃攳', path: '/search', category: 'page' },
  { id: 'login', label: '閫€鍑虹櫥褰?, description: '杩斿洖鐧诲綍椤?, icon: '馃毆', path: '/login', category: 'action' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const filtered = query.trim()
    ? COMMANDS.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description.toLowerCase().includes(query.toLowerCase())
      )
    : COMMANDS;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (cmd: Command) => {
      setOpen(false);
      navigate(cmd.path);
    },
    [navigate]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[activeIndex]) {
        handleSelect(filtered[activeIndex]);
      }
    },
    [filtered, activeIndex, handleSelect]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="w-full max-w-lg rounded-xl overflow-hidden shadow-2xl border"
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-secondary, #1a1a2e)',
          borderColor: 'var(--border-subtle, rgba(255,255,255,0.06))',
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: 'var(--border-subtle, rgba(255,255,255,0.06))' }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted, #666)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="鎼滅储椤甸潰..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text-primary, #fff)' }}
          />
          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-white/5"
            style={{ color: 'var(--text-muted, #666)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted, #666)' }}>
              鏃犲尮閰嶇粨鏋?            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={() => handleSelect(cmd)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  i === activeIndex ? 'bg-white/10' : 'hover:bg-white/5'
                }`}
              >
                <span className="text-lg shrink-0">{cmd.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm" style={{ color: 'var(--text-primary, #fff)' }}>
                    {cmd.label}
                  </div>
                  <div
                    className="text-xs truncate"
                    style={{ color: 'var(--text-muted, #666)' }}
                  >
                    {cmd.description}
                  </div>
                </div>
                <ArrowRight
                  className="w-4 h-4 shrink-0 opacity-0 group-hover:opacity-100"
                  style={{ color: 'var(--text-muted, #666)' }}
                />
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          className="flex items-center justify-between px-4 py-2 text-[10px] border-t"
          style={{
            borderColor: 'var(--border-subtle, rgba(255,255,255,0.06))',
            color: 'var(--text-muted, #666)',
          }}
        >
          <span>鈫戔啌 瀵艰埅  路  鈫?閫夋嫨  路  Esc 鍏抽棴</span>
          <span>鈱楰 鎵撳紑</span>
        </div>
      </div>
    </div>
  );
}
