import { Network, Link2, Bot, RefreshCw } from 'lucide-react';

interface BottomInfoBarProps {
  nodeCount: number;
  edgeCount: number;
  onlineAgents: number;
  totalAgents: number;
  lastSync: string;
}

export default function BottomInfoBar({ nodeCount, edgeCount, onlineAgents, totalAgents, lastSync }: BottomInfoBarProps) {
  const items = [
    { icon: Network, label: `${nodeCount.toLocaleString()} 节点` },
    { icon: Link2, label: `${edgeCount.toLocaleString()} 连接` },
    { icon: Bot, label: `${onlineAgents}/${totalAgents} Agent 在线` },
    { icon: RefreshCw, label: lastSync },
  ];

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-1.5 sm:gap-x-4 md:gap-6 md:px-5 md:py-2 rounded-full border max-w-[calc(100vw-1.5rem)]"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderColor: 'var(--border-subtle)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}
    >
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <item.icon className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
          <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
            {item.label}
          </span>
          {item.icon === Bot && (
            <span className="status-dot-online" />
          )}
        </div>
      ))}
    </div>
  );
}
