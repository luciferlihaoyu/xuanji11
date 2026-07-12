import { Network, GitPullRequest, FileText, Tag } from 'lucide-react';

interface Totals {
  nodes: number;
  edges: number;
  documents: number;
  tags: number;
}

interface AnalysisCardsProps {
  totals?: Totals;
}

const cards = [
  { key: 'nodes' as const, label: '知识节点', icon: Network, color: 'var(--accent-cyan)' },
  { key: 'edges' as const, label: '关系连线', icon: GitPullRequest, color: 'var(--accent-violet)' },
  { key: 'documents' as const, label: '知识文档', icon: FileText, color: 'var(--accent-emerald)' },
  { key: 'tags' as const, label: '标签节点', icon: Tag, color: 'var(--accent-amber)' },
];

export function AnalysisCards({ totals }: AnalysisCardsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const value = totals?.[card.key] ?? 0;
        return (
          <div key={card.key} className="card-base flex items-center gap-4">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor: `${card.color}15`,
                border: `1px solid ${card.color}30`,
              }}
            >
              <card.icon className="w-5 h-5" style={{ color: card.color }} />
            </div>
            <div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {card.label}
              </div>
              <div
                className="text-2xl font-bold font-mono"
                style={{ color: 'var(--text-primary)' }}
              >
                {value.toLocaleString()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
