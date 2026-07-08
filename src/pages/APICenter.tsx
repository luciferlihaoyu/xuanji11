import { useState, useEffect } from 'react';
import { Copy, Check, Send, Lock, Globe, Key, ChevronDown, BookOpen, Loader2, Trash2, Plus } from 'lucide-react';
import { useAgents, type ApiKey, type GeneratedApiKey } from '@/hooks/useAgents';
import { useAppStore } from '@/store/useAppStore';

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

interface DebugHeader {
  key: string;
  value: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    description: '系统健康检查，返回服务运行状态和时间戳',
    category: '系统',
    auth: false,
    responseExample: '{"status":"ok","ts":1720000000000}',
  },
  {
    id: 'trpc',
    method: 'POST',
    path: '/api/trpc/*',
    description: 'tRPC 远程调用端点，所有业务 RPC 通过此处路由',
    category: '系统',
    auth: true,
    params: [
      { name: '*', type: 'string', required: true, description: 'tRPC 过程路径，如 agent.list' },
      { name: 'input', type: 'object', required: false, description: '过程输入参数（JSON）' },
    ],
    requestExample: 'POST /api/trpc\n{ "0": { "json": { "agent": { "list": {} } } } }',
    responseExample: '{"result":{"data":{"json":[]}}}',
  },
  {
    id: 'mcp',
    method: 'POST',
    path: '/api/mcp',
    description: 'MCP 工具调用端点，支持 JSON-RPC 工具调用与 SSE 初始化',
    category: 'Agent',
    auth: true,
    params: [
      { name: 'jsonrpc', type: 'string', required: false, description: 'JSON-RPC 版本，通常为 2.0' },
      { name: 'method', type: 'string', required: true, description: '方法名：initialize、tools/list、tools/call' },
      { name: 'params', type: 'object', required: false, description: '工具参数' },
    ],
    requestExample: 'POST /api/mcp\n{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "method": "tools/list"\n}',
    responseExample: '{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "result": {\n    "tools": [\n      { "name": "knowledge_search", "description": "..." }\n    ]\n  }\n}',
  },
  {
    id: 'upload',
    method: 'POST',
    path: '/api/upload',
    description: '上传文件到服务器，支持 multipart/form-data，最大 20MB',
    category: '文件',
    auth: true,
    params: [
      { name: 'file', type: 'binary', required: true, description: '文件内容' },
    ],
    requestExample: 'POST /api/upload\nContent-Type: multipart/form-data\n\nfile: <binary>',
    responseExample: '{\n  "id": 1,\n  "filename": "uuid.pdf",\n  "originalName": "document.pdf",\n  "mimeType": "application/pdf",\n  "size": 2457600,\n  "url": "/api/files/1"\n}',
  },
  {
    id: 'files',
    method: 'GET',
    path: '/api/files/:id',
    description: '获取已上传文件的内容或下载流',
    category: '文件',
    auth: true,
    params: [
      { name: 'id', type: 'integer', required: true, description: '文件记录 ID' },
    ],
    requestExample: 'GET /api/files/1',
    responseExample: '<binary file content>',
  },
];

const CATEGORIES = [...new Set(ENDPOINTS.map((e) => e.category))];

const methodColors: Record<string, { bg: string; text: string }> = {
  GET: { bg: 'rgba(52,211,153,0.15)', text: '#34D399' },
  POST: { bg: 'rgba(34,211,238,0.15)', text: '#22D3EE' },
  PUT: { bg: 'rgba(251,191,36,0.15)', text: '#FBBF24' },
  DELETE: { bg: 'rgba(251,113,133,0.15)', text: '#FB7185' },
};

const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '从未';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err || '未知错误');
}

export default function APICenter() {
  const { addToast } = useAppStore();
  const { agents, listApiKeys, generateApiKey, revokeApiKey, isGeneratingApiKey, isRevokingApiKey } = useAgents();

  const [selectedEndpoint, setSelectedEndpoint] = useState<Endpoint>(ENDPOINTS[0]);
  const [copied, setCopied] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugResponse, setDebugResponse] = useState<string>('');
  const [debugResponseHeaders, setDebugResponseHeaders] = useState<string>('');
  const [debugStatus, setDebugStatus] = useState<number | null>(null);
  const [debugMethod, setDebugMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE'>(selectedEndpoint.method);
  const [debugUrl, setDebugUrl] = useState<string>(`${baseUrl}${selectedEndpoint.path}`);
  const [debugHeaders, setDebugHeaders] = useState<DebugHeader[]>([
    { key: 'Authorization', value: 'Bearer ' },
    { key: 'Content-Type', value: 'application/json' },
  ]);
  const [debugBody, setDebugBody] = useState<string>('');

  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [keyName, setKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState<GeneratedApiKey | null>(null);
  const [revokeConfirmId, setRevokeConfirmId] = useState<number | null>(null);

  const allAgents = agents;

  // Reset debug form when selected endpoint changes
  useEffect(() => {
    setDebugMethod(selectedEndpoint.method);
    setDebugUrl(`${baseUrl}${selectedEndpoint.path}`);
    setDebugResponse('');
    setDebugResponseHeaders('');
    setDebugStatus(null);
    if (selectedEndpoint.method !== 'GET' && selectedEndpoint.requestExample) {
      const lines = selectedEndpoint.requestExample.split('\n');
      if (lines.length > 1 && lines[0].startsWith('GET ') || lines[0].startsWith('POST ') || lines[0].startsWith('PUT ') || lines[0].startsWith('DELETE ')) {
        setDebugBody(lines.slice(1).join('\n').trim() || '{}');
      } else {
        setDebugBody(selectedEndpoint.requestExample);
      }
    } else {
      setDebugBody('');
    }
  }, [selectedEndpoint]);

  // Fetch API keys when token modal opens
  useEffect(() => {
    if (!tokenModalOpen) {
      setApiKeys([]);
      setSelectedAgentId('');
      setKeyName('');
      setGeneratedKey(null);
      setRevokeConfirmId(null);
      return;
    }

    async function loadAllKeys() {
      setApiKeysLoading(true);
      try {
        const allKeys: ApiKey[] = [];
        for (const agent of agents) {
          const keys = await listApiKeys(agent.id);
          allKeys.push(...keys.map((k) => ({ ...k, agentName: agent.name })));
        }
        allKeys.sort((a, b) => {
          const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bDate - aDate;
        });
        setApiKeys(allKeys);
      } catch (err) {
        addToast({ type: 'error', title: getErrorMessage(err) });
      } finally {
        setApiKeysLoading(false);
      }
    }

    loadAllKeys();
  }, [tokenModalOpen, agents, listApiKeys, addToast]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sendRequest = async () => {
    setDebugLoading(true);
    setDebugResponse('');
    setDebugResponseHeaders('');
    setDebugStatus(null);
    try {
      const headers = new Headers();
      for (const h of debugHeaders) {
        if (h.key.trim()) {
          headers.set(h.key.trim(), h.value);
        }
      }

      let body: string | undefined;
      if (debugMethod !== 'GET' && debugBody.trim()) {
        body = debugBody;
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
      }

      const start = performance.now();
      const res = await fetch(debugUrl, {
        method: debugMethod,
        headers,
        body,
        credentials: 'include',
      });
      const duration = Math.round(performance.now() - start);

      const resText = await res.text();
      setDebugStatus(res.status);
      setDebugResponse(formatJson(resText));

      const headerEntries: string[] = [];
      res.headers.forEach((value, key) => headerEntries.push(`${key}: ${value}`));
      setDebugResponseHeaders(headerEntries.length > 0 ? `HTTP/1.1 ${res.status} ${res.statusText}\n${headerEntries.join('\n')}\n\n耗时: ${duration}ms` : `HTTP/1.1 ${res.status} ${res.statusText}\n\n耗时: ${duration}ms`);
    } catch (err) {
      setDebugStatus(0);
      setDebugResponse(`Error: ${getErrorMessage(err)}`);
      setDebugResponseHeaders('');
      addToast({ type: 'error', title: getErrorMessage(err) });
    } finally {
      setDebugLoading(false);
    }
  };

  const handleAddHeader = () => {
    setDebugHeaders([...debugHeaders, { key: '', value: '' }]);
  };

  const handleRemoveHeader = (index: number) => {
    setDebugHeaders(debugHeaders.filter((_, i) => i !== index));
  };

  const handleHeaderChange = (index: number, field: 'key' | 'value', value: string) => {
    const next = [...debugHeaders];
    next[index][field] = value;
    setDebugHeaders(next);
  };

  const handleCreateKey = async () => {
    if (!selectedAgentId || !keyName.trim()) {
      addToast({ type: 'error', title: '请选择 Agent 并填写密钥名称' });
      return;
    }
    try {
      const result = await generateApiKey(selectedAgentId, keyName.trim());
      setGeneratedKey(result);
      setKeyName('');
      setSelectedAgentId('');
      addToast({ type: 'success', title: 'API 密钥已生成' });
      // Refresh keys
      setApiKeysLoading(true);
      const allKeys: ApiKey[] = [];
      for (const agent of agents) {
        const keys = await listApiKeys(agent.id);
        allKeys.push(...keys.map((k) => ({ ...k, agentName: agent.name })));
      }
      allKeys.sort((a, b) => {
        const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bDate - aDate;
      });
      setApiKeys(allKeys);
      setApiKeysLoading(false);
    } catch (err) {
      addToast({ type: 'error', title: getErrorMessage(err) });
    }
  };

  const handleRevokeKey = async (keyId: number) => {
    try {
      await revokeApiKey(keyId);
      setRevokeConfirmId(null);
      setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
      addToast({ type: 'info', title: '密钥已撤销' });
    } catch (err) {
      addToast({ type: 'error', title: getErrorMessage(err) });
    }
  };

  const handleCopyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      addToast({ type: 'success', title: '已复制到剪贴板' });
    } catch {
      addToast({ type: 'error', title: '复制失败' });
    }
  };

  return (
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Left Nav */}
      <div className="w-[280px] shrink-0 border-r flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
        <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} />
            <code className="text-xs" style={{ color: 'var(--text-primary)' }}>{baseUrl}</code>
            <button onClick={() => handleCopy(baseUrl)} className="p-1 rounded hover:bg-white/5">
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
                    value={debugMethod}
                    onChange={(e) => setDebugMethod(e.target.value as 'GET' | 'POST' | 'PUT' | 'DELETE')}
                  >
                    <option>GET</option>
                    <option>POST</option>
                    <option>PUT</option>
                    <option>DELETE</option>
                  </select>
                  <input
                    type="text"
                    value={debugUrl}
                    onChange={(e) => setDebugUrl(e.target.value)}
                    className="input-base text-xs flex-1"
                  />
                </div>

                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Headers</span>
                    <button onClick={handleAddHeader} className="text-[10px] flex items-center gap-1" style={{ color: 'var(--accent-cyan)' }}>
                      <Plus className="w-3 h-3" />添加
                    </button>
                  </div>
                  <div className="space-y-2">
                    {debugHeaders.map((h, index) => (
                      <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                        <input
                          type="text"
                          value={h.key}
                          onChange={(e) => handleHeaderChange(index, 'key', e.target.value)}
                          placeholder="Key"
                          className="input-base text-xs"
                        />
                        <input
                          type="text"
                          value={h.value}
                          onChange={(e) => handleHeaderChange(index, 'value', e.target.value)}
                          placeholder="Value"
                          className="input-base text-xs"
                        />
                        <button onClick={() => handleRemoveHeader(index)} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--accent-rose)' }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>

                {debugMethod !== 'GET' && (
                  <div className="mb-3">
                    <span className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-muted)' }}>Body (JSON)</span>
                    <textarea
                      className="input-base text-xs h-32 resize-none font-mono"
                      value={debugBody}
                      onChange={(e) => setDebugBody(e.target.value)}
                    />
                  </div>
                )}

                <button onClick={sendRequest} disabled={debugLoading} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 mb-4">
                  {debugLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {debugLoading ? '发送中...' : '发送请求'}
                </button>

                {debugStatus !== null && (
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span
                        className="text-xs font-bold px-2 py-1 rounded"
                        style={{ backgroundColor: debugStatus > 0 && debugStatus < 300 ? 'rgba(52,211,153,0.15)' : 'rgba(251,113,133,0.15)', color: debugStatus > 0 && debugStatus < 300 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}
                      >
                        {debugStatus} {debugStatus > 0 && debugStatus < 300 ? 'OK' : 'Error'}
                      </span>
                    </div>
                    {debugResponseHeaders && (
                      <pre className="rounded-md p-4 overflow-x-auto text-xs mb-2" style={{ backgroundColor: '#0D1117', border: '1px solid var(--border-subtle)', color: '#E2E8F0' }}>
                        <code>{debugResponseHeaders}</code>
                      </pre>
                    )}
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
          <div className="animate-scale-in rounded-lg border p-6 w-[500px] max-h-[80vh] overflow-y-auto" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>API Token 管理</h3>
              <button onClick={() => setTokenModalOpen(false)} className="p-1 rounded hover:bg-white/5">
                <BookOpen className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            {/* Create form */}
            <div className="card-base mb-4 space-y-3">
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>选择 Agent *</label>
                <select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="input-base text-xs w-full"
                >
                  <option value="">请选择 Agent</option>
                  {allAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}（{agent.department}）</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>密钥名称 *</label>
                <input
                  type="text"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="如：生产环境密钥"
                  className="input-base text-xs w-full"
                />
              </div>
              <button
                onClick={handleCreateKey}
                disabled={isGeneratingApiKey || !selectedAgentId || !keyName.trim()}
                className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5"
              >
                {isGeneratingApiKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                {isGeneratingApiKey ? '生成中...' : '创建新 Token'}
              </button>
            </div>

            {/* Generated key display */}
            {generatedKey && (
              <div className="bg-yellow-900/20 border border-yellow-500/30 rounded p-3 mb-4">
                <p className="text-xs mb-2" style={{ color: 'var(--accent-amber)' }}>
                  重要：请立即复制此密钥，它不会再次显示。
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={generatedKey.key}
                    className="input-base text-xs flex-1 font-mono"
                    onClick={(e) => e.currentTarget.select()}
                  />
                  <button onClick={() => handleCopyKey(generatedKey.key)} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5">
                    <Copy className="w-3.5 h-3.5" />复制
                  </button>
                  <button onClick={() => setGeneratedKey(null)} className="btn-ghost text-xs py-2 px-3">关闭</button>
                </div>
              </div>
            )}

            {/* Key list */}
            <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>已创建密钥</h4>
            {apiKeysLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>加载中...</span>
              </div>
            ) : apiKeys.length === 0 ? (
              <div className="text-xs py-6 text-center border rounded-md" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                暂无 API 密钥，请先创建 Agent
              </div>
            ) : (
              <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                {apiKeys.map((key) => (
                  <div key={key.id} className="card-base p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono" style={{ color: 'var(--accent-cyan)' }}>{key.keyPrefix || '****'}...</span>
                          <span className={`chip text-[10px] py-0.5 px-2 ${key.isActive === 'true' ? 'chip-emerald' : 'chip-rose'}`}>
                            {key.isActive === 'true' ? '活跃' : '已撤销'}
                          </span>
                        </div>
                        <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{key.name}</div>
                        {(key as ApiKey & { agentName?: string }).agentName && (
                          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Agent: {(key as ApiKey & { agentName?: string }).agentName}</div>
                        )}
                      </div>
                      {key.isActive === 'true' && (
                        <button
                          onClick={() => setRevokeConfirmId(key.id)}
                          className="p-1.5 rounded hover:bg-white/5"
                          style={{ color: 'var(--accent-rose)' }}
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mb-1">
                      {(key.scopes || []).slice(0, 4).map((scope) => (
                        <span key={scope} className="chip text-[10px] py-0 px-1.5">{scope}</span>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span>创建: {formatDate(key.createdAt)}</span>
                      <span>·</span>
                      <span>最后使用: {formatDate(key.lastUsedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Revoke confirmation */}
      {revokeConfirmId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(10,14,26,0.8)' }}>
          <div className="animate-scale-in rounded-lg border p-5 w-[360px]" style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
            <h4 className="text-base font-bold mb-2" style={{ color: 'var(--text-primary)' }}>确认删除密钥</h4>
            <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>删除后，使用此密钥的所有请求将立即被拒绝。此操作不可撤销。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setRevokeConfirmId(null)} className="btn-ghost text-xs py-2 px-4">取消</button>
              <button onClick={() => handleRevokeKey(revokeConfirmId)} disabled={isRevokingApiKey} className="btn-danger text-xs py-2 px-4">
                {isRevokingApiKey ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
