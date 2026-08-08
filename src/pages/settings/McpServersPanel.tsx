import { useState } from 'react';
import { Loader2, Network, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';

const DIFY_HINT = 'Dify 端点格式：https://api.dify.ai/mcp/server/{server_code}/mcp（自部署替换为对应域名）。Dify 无需额外 Token，端点 URL 中的 server_code 即凭证。';

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export function McpServersPanel() {
  const addToast = useAppStore((s) => s.addToast);
  const utils = trpc.useUtils();

  const serversQuery = trpc.mcpClient.list.useQuery();
  const createMutation = trpc.mcpClient.create.useMutation({
    onSuccess: () => { void utils.mcpClient.list.invalidate(); },
  });
  const deleteMutation = trpc.mcpClient.delete.useMutation({
    onSuccess: () => { void utils.mcpClient.list.invalidate(); },
  });
  const testConnectionMutation = trpc.mcpClient.testConnection.useMutation();
  const [toolsPreview, setToolsPreview] = useState<{ serverId: number; tools: readonly McpToolDef[] } | null>(null);

  const [form, setForm] = useState({ name: '', url: '', authToken: '' });
  const [testingUrl, setTestingUrl] = useState(false);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      addToast({ type: 'error', title: '请填写名称与 URL' });
      return;
    }
    try {
      await createMutation.mutateAsync({
        name: form.name.trim(),
        url: form.url.trim(),
        authToken: form.authToken.trim() || undefined,
      });
      addToast({ type: 'success', title: 'MCP 服务器已添加' });
      setForm({ name: '', url: '', authToken: '' });
    } catch (error) {
      addToast({ type: 'error', title: '添加失败', description: error instanceof Error ? error.message : undefined });
    }
  };

  const handleTest = async () => {
    if (!form.url.trim()) {
      addToast({ type: 'error', title: '请先填写 URL' });
      return;
    }
    setTestingUrl(true);
    try {
      const info = await testConnectionMutation.mutateAsync({
        url: form.url.trim(),
        authToken: form.authToken.trim() || undefined,
      });
      addToast({ type: 'success', title: `连接成功：${info.name} v${info.version}` });
    } catch (error) {
      addToast({ type: 'error', title: '连接失败', description: error instanceof Error ? error.message : undefined });
    } finally {
      setTestingUrl(false);
    }
  };

  const handleListTools = async (serverId: number) => {
    setToolsPreview(null);
    try {
      const tools = await utils.mcpClient.listRemoteTools.fetch({ serverId });
      setToolsPreview({ serverId, tools });
    } catch (error) {
      addToast({ type: 'error', title: '获取工具列表失败', description: error instanceof Error ? error.message : undefined });
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!window.confirm(`确定删除 MCP 服务器「${name}」吗？`)) return;
    try {
      await deleteMutation.mutateAsync({ id });
      addToast({ type: 'success', title: '已删除' });
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', description: error instanceof Error ? error.message : undefined });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Network className="w-5 h-5" />
          MCP 服务器
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          注册外部 MCP 服务器（如 Dify 工作流），供知识库工作流的「调用 Agent」节点调用。
        </p>
      </div>

      {/* 添加服务器 */}
      <div className="card-base p-4 space-y-3">
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>添加 MCP 服务器</h4>
        <div>
          <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>名称</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="例如：Dify 知识库工作流"
            className="input-base text-xs w-full"
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>端点 URL</label>
          <input
            type="text"
            value={form.url}
            onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
            placeholder="https://api.dify.ai/mcp/server/{server_code}/mcp"
            className="input-base text-xs w-full font-mono"
          />
          <p className="text-[10px] mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{DIFY_HINT}</p>
        </div>
        <div>
          <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Bearer Token（可选）</label>
          <input
            type="password"
            value={form.authToken}
            onChange={(e) => setForm((prev) => ({ ...prev, authToken: e.target.value }))}
            placeholder="Dify 无需填写；其他 MCP 服务器按需填写"
            className="input-base text-xs w-full"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button onClick={() => void handleTest()} disabled={testingUrl} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
            {testingUrl ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            测试连接
          </button>
          <button onClick={() => void handleCreate()} disabled={createMutation.isPending} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5">
            {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            添加
          </button>
        </div>
      </div>

      {/* 已注册列表 */}
      <div className="space-y-2">
        <h4 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>已注册的服务器</h4>
        {serversQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
          </div>
        ) : !serversQuery.data || serversQuery.data.length === 0 ? (
          <div className="card-base p-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            尚未注册任何 MCP 服务器。可在上方添加 Dify 等外部服务器。
          </div>
        ) : (
          serversQuery.data.map((server) => (
            <div key={server.id} className="card-base p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{server.name}</span>
                    <span
                      className="chip text-[10px] py-0.5 px-2"
                      style={{ color: server.enabled ? 'var(--accent-emerald)' : '#ef4444' }}
                    >
                      {server.enabled ? '启用' : '禁用'}
                    </span>
                    {server.hasToken && (
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Token ••••{server.authTokenLast4}</span>
                    )}
                  </div>
                  <div className="text-xs font-mono truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{server.url}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => void handleListTools(server.id)}
                    className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
                    title="列出该服务器暴露的 MCP 工具"
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    工具
                  </button>
                  <button
                    onClick={() => void handleDelete(server.id, server.name)}
                    disabled={deleteMutation.isPending}
                    className="btn-danger text-xs py-1.5 px-3 flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    删除
                  </button>
                </div>
              </div>
              {toolsPreview?.serverId === server.id && (
                <div className="mt-3 pt-3 space-y-1.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  {toolsPreview.tools.length === 0 ? (
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>该服务器未暴露任何工具</div>
                  ) : (
                    toolsPreview.tools.map((tool) => (
                      <div key={tool.name} className="text-xs">
                        <span className="font-mono font-medium" style={{ color: 'var(--accent-cyan)' }}>{tool.name}</span>
                        {tool.description && (
                          <span style={{ color: 'var(--text-muted)' }}> — {tool.description}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
