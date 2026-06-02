import { useState } from 'react';
import { Copy, Check, Send, Lock, Globe, Key, ChevronDown, BookOpen } from 'lucide-react';

interface Endpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  description: string;
  category: string;
  auth: boolean;
  params?: { name: string; type: string; required: boolean; description: string }[];
  requestExample?: string;
  responseExample?: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    id: 'e1', method: 'GET', path: '/knowledge', description: '获取知识列表，支持分页和筛选',
    category: '知识库', auth: true,
    params: [
      { name: 'page', type: 'integer', required: false, description: '页码，默认 1' },
      { name: 'limit', type: 'integer', required: false, description: '每页数量，默认 20' },
      { name: 'category', type: 'string', required: false, description: '类别过滤' },
    ],
    requestExample: 'GET /api/v1/knowledge?page=1&limit=20',
    responseExample: `{\n  "total": 1247,\n  "page": 1,\n  "items": [\n    {\n      "id": "kn_001",\n      "name": "OpenClaw 系统架构",\n      "category": "core",\n      "updated_at": "2026-06-01T12:00:00Z"\n    }\n  ]\n}`,
  },
  {
    id: 'e2', method: 'POST', path: '/knowledge', description: '创建新的知识节点',
    category: '知识库', auth: true,
    params: [
      { name: 'name', type: 'string', required: true, description: '知识节点名称' },
      { name: 'content', type: 'string', required: true, description: '内容（Markdown）' },
      { name: 'category', type: 'string', required: false, description: '类别' },
      { name: 'tags', type: 'array', required: false, description: '标签列表' },
    ],
    requestExample: 'POST /api/v1/knowledge\n{\n  "name": "新知识点",\n  "content": "# 标题\\n内容...",\n  "category": "core",\n  "tags": ["标签1", "标签2"]\n}',
    responseExample: `{\n  "id": "kn_002",\n  "name": "新知识点",\n  "created_at": "2026-06-02T10:00:00Z"\n}`,
  },
  {
    id: 'e3', method: 'GET', path: '/knowledge/:id', description: '获取单个知识节点详情',
    category: '知识库', auth: true,
    params: [
      { name: 'id', type: 'string', required: true, description: '知识节点 ID' },
    ],
    requestExample: 'GET /api/v1/knowledge/kn_001',
    responseExample: `{\n  "id": "kn_001",\n  "name": "OpenClaw 系统架构",\n  "content": "# OpenClaw...",\n  "category": "core",\n  "tags": ["系统架构", "OpenClaw"],\n  "created_at": "2026-05-15T08:00:00Z",\n  "updated_at": "2026-06-01T12:00:00Z"\n}`,
  },
  {
    id: 'e4', method: 'GET', path: '/graph/nodes', description: '获取知识图谱所有节点',
    category: '图谱', auth: true,
    responseExample: `{\n  "nodes": [\n    {\n      "id": "n1",\n      "name": "OpenClaw 系统架构",\n      "category": "core",\n      "importance": 10,\n      "connections": 8\n    }\n  ],\n  "total": 1247\n}`,
  },
  {
    id: 'e5', method: 'POST', path: '/graph/edges', description: '创建知识节点之间的关联',
    category: '图谱', auth: true,
    params: [
      { name: 'source', type: 'string', required: true, description: '源节点 ID' },
      { name: 'target', type: 'string', required: true, description: '目标节点 ID' },
      { name: 'strength', type: 'integer', required: false, description: '关联强度 1-5' },
    ],
    requestExample: 'POST /api/v1/graph/edges\n{\n  "source": "n1",\n  "target": "n2",\n  "strength": 4\n}',
    responseExample: `{\n  "id": "edge_001",\n  "source": "n1",\n  "target": "n2",\n  "strength": 4,\n  "created_at": "2026-06-02T10:00:00Z"\n}`,
  },
  {
    id: 'e6', method: 'GET', path: '/agents', description: '获取已连接的 Agent 列表',
    category: 'Agent', auth: true,
    responseExample: `{\n  "agents": [\n    {\n      "id": "agent-meizhizi",\n      "name": "美智子（女娲）",\n      "role": "CTO",\n      "status": "online",\n      "department": "技术部"\n    }\n  ]\n}`,
  },
  {
    id: 'e7', method: 'POST', path: '/agents/:id/query', description: '向指定 Agent 发送查询',
    category: 'Agent', auth: true,
    params: [
      { name: 'id', type: 'string', required: true, description: 'Agent ID' },
      { name: 'query', type: 'string', required: true, description: '查询内容' },
      { name: 'context', type: 'object', required: false, description: '上下文信息' },
    ],
    requestExample: 'POST /api/v1/agents/agent-meizhizi/query\n{\n  "query": "分析知识图谱中关联度最高的节点",\n  "context": { "limit": 5 }\n}',
    responseExample: `{\n  "response": "关联度最高的节点是 'OpenClaw 系统架构'...",\n  "usage": {\n    "tokens": 256,\n    "model": "mimo-v2.5-pro"\n  }\n}`,
  },
  {
    id: 'e8', method: 'POST', path: '/vectorize', description: '向量化文本内容',
    category: '向量化', auth: true,
    params: [
      { name: 'text', type: 'string', required: true, description: '要向量化的文本' },
      { name: 'model', type: 'string', required: false, description: '向量化模型' },
    ],
    requestExample: 'POST /api/v1/vectorize\n{\n  "text": "OpenClaw 是一套多 Agent 协作系统",\n  "model": "text-embedding-3-large"\n}',
    responseExample: `{\n  "embedding": [0.023, -0.156, 0.089, ...],\n  "dimensions": 3072,\n  "model": "text-embedding-3-large"\n}`,
  },
  {
    id: 'e9', method: 'POST', path: '/vectorize/search', description: '向量语义搜索',
    category: '向量化', auth: true,
    params: [
      { name: 'query', type: 'string', required: true, description: '搜索查询' },
      { name: 'top_k', type: 'integer', required: false, description: '返回数量，默认 10' },
      { name: 'threshold', type: 'float', required: false, description: '相似度阈值 0-1' },
    ],
    requestExample: 'POST /api/v1/vectorize/search\n{\n  "query": "Agent 记忆机制",\n  "top_k": 5,\n  "threshold": 0.7\n}',
    responseExample: `{\n  "results": [\n    {\n      "id": "kn_004",\n      "name": "Agent 记忆机制",\n      "score": 0.95,\n      "content": "每日日志 → Dreaming..."\n    }\n  ]\n}`,
  },
  {
    id: 'e10', method: 'GET', path: '/workflows', description: '获取工作流列表',
    category: '工作流', auth: true,
    responseExample: `{\n  "workflows": [\n    {\n      "id": "wf_001",\n      "name": "新人上手",\n      "status": "active",\n      "created_at": "2026-05-01"\n    }\n  ]\n}`,
  },
  {
    id: 'e11', method: 'POST', path: '/workflows/:id/run', description: '运行指定工作流',
    category: '工作流', auth: true,
    responseExample: `{\n  "execution_id": "exec_001",\n  "status": "running",\n  "started_at": "2026-06-02T10:00:00Z"\n}`,
  },
  {
    id: 'e12', method: 'POST', path: '/storage/upload', description: '上传文件到知识库',
    category: '存储', auth: true,
    requestExample: 'POST /api/v1/storage/upload\nContent-Type: multipart/form-data\n\nfile: <binary>\ntarget_folder: "/documents"\nauto_process: true',
    responseExample: `{\n  "file_id": "file_001",\n  "name": "document.pdf",\n  "size": 2457600,\n  "status": "processing"\n}`,
  },
];

const CATEGORIES = [...new Set(ENDPOINTS.map((e) => e.category))];

const methodColors: Record<string, { bg: string; text: string }> = {
  GET: { bg: 'rgba(52,211,153,0.15)', text: '#34D399' },
  POST: { bg: 'rgba(34,211,238,0.15)', text: '#22D3EE' },
  PUT: { bg: 'rgba(251,191,36,0.15)', text: '#FBBF24' },
  DELETE: { bg: 'rgba(251,113,133,0.15)', text: '#FB7185' },
};

export default function APICenter() {
  const [selectedEndpoint, setSelectedEndpoint] = useState<Endpoint>(ENDPOINTS[0]);
  const [copied, setCopied] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugResponse, setDebugResponse] = useState<string>('');
  const [debugStatus, setDebugStatus] = useState<number | null>(null);
  const [tokenModalOpen, setTokenModalOpen] = useState(false);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sendRequest = () => {
    setDebugStatus(200);
    setDebugResponse(selectedEndpoint.responseExample || '{\n  "status": "success"\n}');
  };

  return (
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Left Nav */}
      <div className="w-[280px] shrink-0 border-r flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
        <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            <code className="text-xs" style={{ color: 'var(--text-primary)' }}>https://api.xuanji.io/v1</code>
            <button onClick={() => handleCopy('https://api.xuanji.io/v1')} className="p-1 rounded hover:bg-white/5">
              {copied ? <Check className="w-3 h-3" style={{ color: 'var(--accent-emerald)' }} /> : <Copy className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />}
            </button>
          </div>
          <button onClick={() => setTokenModalOpen(true)} className="btn-secondary w-full text-xs py-1.5 flex items-center justify-center gap-1.5">
            <Key className="w-3.5 h-3.5" />
            管理 Token
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {CATEGORIES.map((cat) => (
            <div key={cat}>
              <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {cat}
              </div>
              {ENDPOINTS.filter((e) => e.category === cat).map((ep) => {
                const isSelected = selectedEndpoint.id === ep.id;
                const colors = methodColors[ep.method];
                return (
                  <button
                    key={ep.id}
                    onClick={() => { setSelectedEndpoint(ep); setDebugResponse(''); setDebugStatus(null); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: isSelected ? 'rgba(34,211,238,0.1)' : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                      style={{ backgroundColor: colors.bg, color: colors.text }}
                    >
                      {ep.method}
                    </span>
                    <code className="text-xs truncate" style={{ color: isSelected ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>
                      {ep.path}
                    </code>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Right Detail */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6">
          {/* Endpoint Header */}
          <div className="flex items-center gap-3 mb-2">
            <span
              className="text-sm font-bold px-3 py-1.5 rounded"
              style={{ backgroundColor: methodColors[selectedEndpoint.method].bg, color: methodColors[selectedEndpoint.method].text }}
            >
              {selectedEndpoint.method}
            </span>
            <code className="text-xl font-mono" style={{ color: 'var(--text-primary)' }}>{selectedEndpoint.path}</code>
            <button onClick={() => handleCopy(selectedEndpoint.path)} className="p-1.5 rounded hover:bg-white/5">
              <Copy className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>

          <div className="flex items-center gap-2 mb-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{selectedEndpoint.description}</p>
            {selectedEndpoint.auth && (
              <span className="chip chip-amber text-[10px] py-0.5 px-2 flex items-center gap-1">
                <Lock className="w-3 h-3" />
                需要 Token
              </span>
            )}
          </div>

          {/* Parameters */}
          {selectedEndpoint.params && selectedEndpoint.params.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>参数</h3>
              <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                      {['名称', '类型', '必填', '说明'].map((h) => (
                        <th key={h} className="text-left px-4 py-2.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedEndpoint.params.map((p, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                        <td className="px-4 py-2">
                          <code className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{p.name}</code>
                        </td>
                        <td className="px-4 py-2">
                          <span className="chip text-[10px] py-0.5 px-2">{p.type}</span>
                        </td>
                        <td className="px-4 py-2">
                          {p.required ? (
                            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--accent-rose)' }}>
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--accent-rose)' }} />
                              必填
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>可选</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Examples */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>示例</h3>

            {selectedEndpoint.requestExample && (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>请求</span>
                  <button onClick={() => handleCopy(selectedEndpoint.requestExample!)} className="p-1 rounded hover:bg-white/5">
                    <Copy className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
                <pre className="rounded-md p-4 overflow-x-auto text-xs" style={{ backgroundColor: '#0D1117', border: '1px solid var(--border-subtle)', color: '#E2E8F0' }}>
                  <code>{selectedEndpoint.requestExample}</code>
                </pre>
              </div>
            )}

            {selectedEndpoint.responseExample && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>响应</span>
                  <button onClick={() => handleCopy(selectedEndpoint.responseExample!)} className="p-1 rounded hover:bg-white/5">
                    <Copy className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
                <pre className="rounded-md p-4 overflow-x-auto text-xs" style={{ backgroundColor: '#0D1117', border: '1px solid var(--border-subtle)', color: '#E2E8F0' }}>
                  <code>{selectedEndpoint.responseExample}</code>
                </pre>
              </div>
            )}
          </div>

          {/* Debug Panel */}
          <div className="mb-6">
            <button
              onClick={() => setDebugOpen(!debugOpen)}
              className="flex items-center gap-2 text-sm font-medium mb-3"
              style={{ color: 'var(--accent-cyan)' }}
            >
              <Send className="w-4 h-4" />
              在线调试
              <ChevronDown className={`w-4 h-4 transition-transform ${debugOpen ? 'rotate-180' : ''}`} />
            </button>

            {debugOpen && (
              <div className="border rounded-md p-4" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-secondary)' }}>
                <div className="flex gap-2 mb-3">
                  <select
                    className="h-8 px-2 rounded border text-xs outline-none"
                    style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    defaultValue={selectedEndpoint.method}
                  >
                    <option>GET</option>
                    <option>POST</option>
                    <option>PUT</option>
                    <option>DELETE</option>
                  </select>
                  <input
                    type="text"
                    defaultValue={`https://api.xuanji.io/v1${selectedEndpoint.path}`}
                    className="input-base text-xs flex-1"
                  />
                </div>

                <div className="mb-3">
                  <span className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-muted)' }}>Headers</span>
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <input type="text" defaultValue="Authorization" className="input-base text-xs" readOnly />
                    <input type="text" defaultValue="Bearer sk-nxm-..." className="input-base text-xs" />
                    <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--accent-rose)' }}>×</button>
                  </div>
                </div>

                {selectedEndpoint.method !== 'GET' && (
                  <div className="mb-3">
                    <span className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-muted)' }}>Body (JSON)</span>
                    <textarea
                      className="input-base text-xs h-32 resize-none font-mono"
                      defaultValue={selectedEndpoint.requestExample?.split('\n').slice(1).join('\n') || '{}' }
                    />
                  </div>
                )}

                <button onClick={sendRequest} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 mb-4">
                  <Send className="w-3.5 h-3.5" />
                  发送请求
                </button>

                {debugStatus && (
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span
                        className="text-xs font-bold px-2 py-1 rounded"
                        style={{ backgroundColor: debugStatus < 300 ? 'rgba(52,211,153,0.15)' : 'rgba(251,113,133,0.15)', color: debugStatus < 300 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}
                      >
                        {debugStatus} {debugStatus < 300 ? 'OK' : 'Error'}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>234ms</span>
                    </div>
                    <pre className="rounded-md p-4 overflow-x-auto text-xs" style={{ backgroundColor: '#0D1117', border: '1px solid var(--border-subtle)', color: '#E2E8F0' }}>
                      <code>{debugResponse}</code>
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Token Modal */}
      {tokenModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-6 w-[500px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>API Token 管理</h3>
              <button onClick={() => setTokenModalOpen(false)} className="p-1 rounded hover:bg-white/5">
                <BookOpen className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            <div className="space-y-3 mb-4">
              {[
                { name: '开发环境', token: 'sk-nxm-dev-...x7k9', scope: ['读写'], created: '2026-05-15' },
                { name: '生产环境', token: 'sk-nxm-prod-...a3m2', scope: ['只读'], created: '2026-05-20' },
              ].map((t) => (
                <div key={t.name} className="card-base flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t.name}</div>
                    <code className="text-xs" style={{ color: 'var(--text-muted)' }}>{t.token}</code>
                    <div className="flex gap-1 mt-1">
                      {t.scope.map((s) => (
                        <span key={s} className="chip text-[10px] py-0 px-1.5">{s}</span>
                      ))}
                    </div>
                  </div>
                  <button className="btn-danger text-[10px] py-1 px-2">删除</button>
                </div>
              ))}
            </div>

            <button className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5">
              <Key className="w-3.5 h-3.5" />
              创建新 Token
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
