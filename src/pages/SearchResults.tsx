import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, FileText, Bot } from 'lucide-react';

const SEARCH_RESULTS = {
  knowledge: [
    { id: 'k1', title: 'OpenClaw 系统架构', snippet: 'OpenClaw 是一套多 Agent 协作系统，包含天庭 Hub、Wiki 知识库、技能系统等核心组件...', tags: ['系统架构', 'OpenClaw', '基础设施'], links: 12, updated: '2天前' },
    { id: 'k2', title: 'Agent 记忆机制详解', snippet: '每日日志 → Dreaming 整合 → MEMORY.md 长期记忆 → Wiki 共享知识...', tags: ['记忆', 'Agent', 'Dreaming'], links: 8, updated: '3天前' },
    { id: 'k3', title: '向量化模型对比', snippet: 'OpenAI text-embedding-3-large vs BGE-large-zh vs M3E-base 性能对比分析...', tags: ['向量', 'Embedding', 'AI'], links: 5, updated: '5天前' },
    { id: 'k4', title: '知识图谱可视化方案', snippet: '3D 知识星图和 2D 力导向图的技术实现方案，基于 D3.js 和 Three.js...', tags: ['可视化', '图谱', '3D'], links: 6, updated: '1天前' },
    { id: 'k5', title: '工作流引擎设计', snippet: '可视化工作流编排引擎的设计文档，支持触发器、处理节点、Agent 调用...', tags: ['工作流', '自动化', '编排'], links: 4, updated: '1周前' },
  ],
  files: [
    { id: 'f1', name: '系统架构图_v2.png', path: 'Wiki 知识库 / 系统架构 / 设计稿', size: '2.5 MB', updated: '3天前', indexed: true },
    { id: 'f2', name: 'API 接口文档.pdf', path: 'Wiki 知识库 / API 文档', size: '856 KB', updated: '1周前', indexed: true },
    { id: 'f3', name: 'Agent 配置模板.json', path: 'Wiki 知识库 / 配置文件', size: '12 KB', updated: '5天前', indexed: true },
    { id: 'f4', name: '团队协作规范.docx', path: 'Wiki 知识库 / 行政文档', size: '45 KB', updated: '2周前', indexed: false },
  ],
  agents: [
    { id: 'a1', name: '美智子（女娲）', role: 'CTO', action: '编辑了知识节点 "向量化模型配置"', time: '2小时前' },
    { id: 'a2', name: '羲和', role: '程序员', action: '更新了文档 "MAAP 通信协议"', time: '4小时前' },
    { id: 'a3', name: '上官婉儿', role: '内容主管', action: '建立了知识关联 "Wiki ↔ 技能系统"', time: '昨天' },
  ],
};

export default function SearchResults() {
  const [filter, setFilter] = useState<'all' | 'knowledge' | 'file' | 'agent'>('all');
  const [sortBy, setSortBy] = useState('relevance');
  const totalCount = SEARCH_RESULTS.knowledge.length + SEARCH_RESULTS.files.length + SEARCH_RESULTS.agents.length;

  const filters = [
    { key: 'all' as const, label: '全部', count: totalCount },
    { key: 'knowledge' as const, label: '知识节点', count: SEARCH_RESULTS.knowledge.length },
    { key: 'file' as const, label: '文件', count: SEARCH_RESULTS.files.length },
    { key: 'agent' as const, label: 'Agent', count: SEARCH_RESULTS.agents.length },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Search Header */}
      <div className="mb-6">
        <div
          className="flex items-center max-w-2xl mx-auto h-10 px-4 rounded-lg border mb-4"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
        >
          <Search className="w-5 h-5 mr-3" style={{ color: 'var(--accent-cyan)' }} />
          <input
            type="text"
            defaultValue="知识 架构"
            className="flex-1 bg-transparent text-base outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-1">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className="px-3 py-1.5 text-sm font-medium rounded transition-all relative"
                style={{
                  color: filter === f.key ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                }}
              >
                {f.label}
                <span className="ml-1 text-xs" style={{ color: 'var(--text-muted)' }}>({f.count})</span>
                {filter === f.key && (
                  <span className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full" style={{ backgroundColor: 'var(--accent-cyan)' }} />
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-8 px-2 rounded border text-xs outline-none"
              style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="relevance">相关度</option>
              <option value="recent">最近更新</option>
              <option value="oldest">最早创建</option>
            </select>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>共找到 {totalCount} 个结果</span>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="space-y-6">
        {/* Knowledge Nodes */}
        {(filter === 'all' || filter === 'knowledge') && SEARCH_RESULTS.knowledge.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <FileText className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
              知识节点 ({SEARCH_RESULTS.knowledge.length})
            </h3>
            <div className="space-y-3">
              {SEARCH_RESULTS.knowledge.map((item) => (
                <Link
                  key={item.id}
                  to={`/kb/${item.id}`}
                  className="block card-base p-4 hover:border-[var(--accent-cyan)] transition-colors"
                >
                  <h4 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                    {item.title.split(/(知识|架构)/).map((part, i) =>
                      part === '知识' || part === '架构' ? (
                        <span key={i} style={{ backgroundColor: 'rgba(34,211,238,0.2)', color: 'var(--accent-cyan)' }}>{part}</span>
                      ) : (
                        <span key={i}>{part}</span>
                      )
                    )}
                  </h4>
                  <p className="text-sm mb-2 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                    {item.snippet.split(/(知识|架构)/).map((part, i) =>
                      part === '知识' || part === '架构' ? (
                        <span key={i} style={{ backgroundColor: 'rgba(34,211,238,0.2)', color: 'var(--accent-cyan)' }}>{part}</span>
                      ) : (
                        <span key={i}>{part}</span>
                      )
                    )}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    {item.tags.map((tag) => (
                      <span key={tag} className="chip text-[10px] py-0 px-1.5">{tag}</span>
                    ))}
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>· {item.links} 关联</span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>· {item.updated}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Files */}
        {(filter === 'all' || filter === 'file') && SEARCH_RESULTS.files.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <FileText className="w-4 h-4" style={{ color: 'var(--accent-violet)' }} />
              文件 ({SEARCH_RESULTS.files.length})
            </h3>
            <div className="space-y-2">
              {SEARCH_RESULTS.files.map((item) => (
                <Link
                  key={item.id}
                  to={`/doc/${item.id}`}
                  className="flex items-center gap-3 card-base p-3 hover:border-[var(--accent-violet)] transition-colors"
                >
                  <FileText className="w-8 h-8 shrink-0" style={{ color: 'var(--accent-violet)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.path}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{item.size}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.updated}</div>
                  </div>
                  {item.indexed && (
                    <span className="chip chip-emerald text-[10px] py-0 px-1.5 shrink-0">已索引</span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Agent */}
        {(filter === 'all' || filter === 'agent') && SEARCH_RESULTS.agents.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Bot className="w-4 h-4" style={{ color: 'var(--accent-emerald)' }} />
              Agent 相关 ({SEARCH_RESULTS.agents.length})
            </h3>
            <div className="space-y-2">
              {SEARCH_RESULTS.agents.map((item) => (
                <div key={item.id} className="flex items-center gap-3 card-base p-3">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{ background: 'linear-gradient(135deg, #22D3EE, #A78BFA)', color: '#0A0E1A' }}
                  >
                    {item.name.charAt(0)}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{item.name}</span>
                      <span className="chip text-[10px] py-0 px-1.5">{item.role}</span>
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{item.action}</div>
                  </div>
                  <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{item.time}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
