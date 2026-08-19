import { useState } from 'react';
import { FolderOpen, File, ArrowLeft, Download, Loader2, RefreshCw } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAppStore } from '@/store/useAppStore';

interface BrowserFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedAt?: Date | string;
}

function fmtSize(size?: number): string {
  if (!size) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 网盘文件浏览器：浏览目录 + 导入文件到知识库 */
export function ConnectorBrowser({ platform }: { platform: string }) {
  const addToast = useAppStore((s) => s.addToast);
  const [path, setPath] = useState('/');
  const [importing, setImporting] = useState<string | null>(null);

  const browseQuery = trpc.connector.browseFiles.useQuery(
    { platform, path },
    { retry: 1, staleTime: 30_000 }
  );
  const ingestMutation = trpc.connector.ingestFiles.useMutation();

  const files = (browseQuery.data?.files ?? []) as BrowserFile[];
  const error = browseQuery.data && !browseQuery.data.success ? browseQuery.data.error : undefined;

  const parentPath = path === '/' ? null : (path.slice(0, path.lastIndexOf('/')) || '/');

  const handleIngest = async (file: BrowserFile) => {
    setImporting(file.id);
    try {
      const res = await ingestMutation.mutateAsync({
        platform,
        files: [{ path: file.id, name: file.name, size: file.size }],
      });
      const r = res.results[0];
      if (r?.ok) {
        addToast({ type: 'success', title: `已导入「${file.name}」`, description: '文本类文件会自动分块并向量化' });
      } else {
        addToast({ type: 'error', title: `导入失败`, description: r?.error ?? undefined });
      }
    } catch (e) {
      addToast({ type: 'error', title: '导入失败', description: e instanceof Error ? e.message : undefined });
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="mt-3 rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
          {parentPath !== null && (
            <button onClick={() => setPath(parentPath)} className="p-0.5 rounded hover:opacity-70" title="返回上级">
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="truncate max-w-56">{path}</span>
        </div>
        <button onClick={() => void browseQuery.refetch()} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }} title="刷新">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {browseQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs py-3" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取中...
        </div>
      ) : error ? (
        <div className="text-[11px] py-2" style={{ color: '#ef4444' }}>{error}</div>
      ) : files.length === 0 ? (
        <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>空目录</div>
      ) : (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {files.map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-[rgba(255,255,255,0.03)]">
              <button
                className="flex items-center gap-2 min-w-0 text-left"
                onClick={() => f.type === 'folder' && setPath(f.id)}
                disabled={f.type !== 'folder'}
              >
                {f.type === 'folder'
                  ? <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: '#fbbf24' }} />
                  : <File className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />}
                <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{f.name}</span>
                {f.type === 'file' && (
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{fmtSize(f.size)}</span>
                )}
              </button>
              {f.type === 'file' && (
                <button
                  onClick={() => void handleIngest(f)}
                  disabled={importing === f.id}
                  className="flex items-center gap-1 text-[10px] px-2 py-1 rounded shrink-0 transition-colors"
                  style={{ color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)' }}
                >
                  {importing === f.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                  导入知识库
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
