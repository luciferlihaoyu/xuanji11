import { useState, useCallback, useEffect } from 'react';
import { Upload, File, FileText, Image, Music, Video, Code, Archive, X, Loader2, Trash2, Eye } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

interface UploadFile {
  id?: number;
  fileName: string;
  fileSize: string;
  fileType: string;
  mimeType: string;
  progress: number;
  status: 'queued' | 'uploading' | 'completed' | 'failed';
  ingestionStatus?: string;
  ingestionError?: string;
  speed?: string;
  url?: string;
}

const fileTypeIcons: Record<string, { icon: typeof File; color: string }> = {
  pdf: { icon: FileText, color: '#FB7185' },
  doc: { icon: FileText, color: '#60A5FA' },
  image: { icon: Image, color: '#A78BFA' },
  video: { icon: Video, color: '#FB923C' },
  audio: { icon: Music, color: '#34D399' },
  code: { icon: Code, color: '#22D3EE' },
  zip: { icon: Archive, color: '#FBBF24' },
};

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return fileTypeIcons.pdf;
  if (['doc', 'docx', 'txt', 'md'].includes(ext)) return fileTypeIcons.doc;
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return fileTypeIcons.image;
  if (['mp4', 'avi', 'mov', 'mkv'].includes(ext)) return fileTypeIcons.video;
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return fileTypeIcons.audio;
  if (['js', 'ts', 'py', 'html', 'css', 'json', 'xml', 'java', 'cpp', 'go', 'rs'].includes(ext)) return fileTypeIcons.code;
  if (['zip', 'rar', '7z', 'tar'].includes(ext)) return fileTypeIcons.zip;
  return { icon: File, color: '#94A3B8' };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function UploadPage() {
  const { addToast } = useAppStore();
  const [dragActive, setDragActive] = useState(false);
  const [tasks, setTasks] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);

  // 加载已上传文件列表
  useEffect(() => {
    fetchUploadedList();
  }, []);

  useEffect(() => {
    const completedIds = tasks.filter((t) => t.status === 'completed' && t.id && !t.ingestionStatus).map((t) => t.id as number);
    if (completedIds.length === 0) return;

    const poll = async () => {
      for (const id of completedIds) {
        try {
          const res = await fetch(`/api/upload/${id}/ingestion`);
          const data = await res.json();
          if (data.success && data.items && data.items.length > 0) {
            const item = data.items[0];
            setTasks((prev) =>
              prev.map((t) =>
                t.id === id
                  ? { ...t, ingestionStatus: item.status, ingestionError: item.error || undefined }
                  : t
              )
            );
          }
        } catch (err) {
          console.error('获取入库状态失败:', err);
        }
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [tasks]);

  const fetchUploadedList = async () => {
    try {
      const res = await fetch('/api/upload/list');
      const data = await res.json();
      if (data.success && data.files) {
        const existing: UploadFile[] = data.files.map((f: Record<string, unknown>) => ({
          id: f.id as number,
          fileName: f.originalName as string,
          fileSize: formatSize(f.size as number),
          fileType: (f.originalName as string).split('.').pop() || '',
          mimeType: f.mimeType as string,
          progress: 100,
          status: 'completed' as const,
          url: `/api/files/${f.filename}`,
        }));
        setTasks(existing);
      }
    } catch (err) {
      console.error('获取文件列表失败:', err);
    }
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(e.type === 'dragenter' || e.type === 'dragover');
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  }, []);

  const handleFiles = (files: File[]) => {
    const newTasks: UploadFile[] = files.map((file) => ({
      fileName: file.name,
      fileSize: formatSize(file.size),
      fileType: file.name.split('.').pop() || '',
      mimeType: file.type,
      progress: 0,
      status: 'queued' as const,
    }));
    setTasks((prev) => [...prev, ...newTasks]);
    uploadFiles(files);
  };

  const uploadFiles = async (files: File[]) => {
    setUploading(true);
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));

    try {
      // 模拟进度更新
      const progressInterval = setInterval(() => {
        setTasks((prev) =>
          prev.map((t) =>
            t.status === 'queued' || t.status === 'uploading'
              ? { ...t, status: 'uploading' as const, progress: Math.min(t.progress + 10, 90) }
              : t
          )
        );
      }, 300);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      clearInterval(progressInterval);
      const data = await res.json();

      if (data.success) {
        // 更新为完成状态
        setTasks((prev) =>
          prev.map((t) => {
            if (t.status === 'uploading' || t.status === 'queued') {
              const matched = data.files.find(
                (f: Record<string, unknown>) => f.originalName === t.fileName
              );
              return {
                ...t,
                progress: 100,
                status: 'completed' as const,
                id: matched?.id,
                url: matched?.url,
              };
            }
            return t;
          })
        );
        addToast({ type: 'success', title: `成功上传 ${data.count} 个文件` });
      } else {
        throw new Error(data.error || '上传失败');
      }
    } catch (err) {
      setTasks((prev) =>
        prev.map((t) =>
          t.status === 'uploading' || t.status === 'queued'
            ? { ...t, status: 'failed' as const, progress: 0 }
            : t
        )
      );
      addToast({
        type: 'error',
        title: '上传失败',
        description: err instanceof Error ? err.message : '请检查网络连接',
      });
    } finally {
      setUploading(false);
    }
  };

  const removeTask = async (task: UploadFile) => {
    if (task.id) {
      try {
        await fetch(`/api/upload/${task.id}`, { method: 'DELETE' });
      } catch (err) {
        console.error('删除文件失败:', err);
      }
    }
    setTasks((prev) => prev.filter((t) => t.fileName !== task.fileName || t.status !== task.status));
  };

  const activeTasks = tasks.filter((t) => t.status === 'uploading' || t.status === 'queued');
  const completedTasks = tasks.filter((t) => t.status === 'completed');
  const failedTasks = tasks.filter((t) => t.status === 'failed');

  return (
    <div className="p-6 max-w-5xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Upload Zone */}
      <div
        className="mb-6 rounded-xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center min-h-[240px]"
        style={{
          backgroundColor: dragActive ? 'rgba(100,180,255,0.08)' : 'var(--bg-secondary)',
          borderColor: dragActive ? 'var(--accent)' : 'var(--border-subtle)',
        }}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <Upload className="w-12 h-12 mb-4" style={{ color: dragActive ? 'var(--accent)' : 'var(--text-muted)' }} />
        <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          拖拽文件到此处上传
        </h3>
        <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>或点击选择文件</p>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          支持 PDF、Word、图片、视频、代码等所有格式，最大 50MB/文件
        </p>
        <label className="btn-primary text-sm py-2 px-6 cursor-pointer flex items-center gap-2">
          <Upload className="w-4 h-4" />
          {uploading ? '上传中...' : '选择文件'}
          <input
            type="file"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              if (e.target.files?.length) {
                handleFiles(Array.from(e.target.files));
                e.target.value = '';
              }
            }}
          />
        </label>
      </div>

      {/* Active Uploads */}
      {activeTasks.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
            正在上传 ({activeTasks.length})
          </h3>
          <div className="space-y-2">
            {activeTasks.map((task, i) => {
              const { icon: Icon, color } = getFileIcon(task.fileName);
              return (
                <div key={`active-${i}`} className="flex items-center gap-3 p-3 rounded-md border" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
                  <div className="w-8 h-8 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}20` }}>
                    <Icon className="w-4 h-4" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{task.fileName}</span>
                      <span className="text-xs shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>{task.fileSize}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${task.progress}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-hover))' }} />
                      </div>
                      <span className="text-xs w-10 text-right" style={{ color: 'var(--text-secondary)' }}>{task.progress}%</span>
                    </div>
                  </div>
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completed */}
      {completedTasks.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>已上传 ({completedTasks.length})</h3>
            <button onClick={() => setTasks((prev) => prev.filter((t) => t.status !== 'completed'))} className="btn-ghost text-xs py-1 px-2">
              清空已完成
            </button>
          </div>
          <div className="space-y-1">
            {completedTasks.map((task, i) => {
              const { icon: Icon, color } = getFileIcon(task.fileName);
              return (
                <div key={`done-${task.id || i}`} className="flex items-center gap-3 px-3 py-2.5 rounded-md group hover:bg-white/5 transition-colors">
                  <div className="w-8 h-8 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}20` }}>
                    <Icon className="w-4 h-4" style={{ color }} />
                  </div>
                  <span className="text-sm flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{task.fileName}</span>
                  <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>{task.fileSize}</span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {task.url && (
                      <a href={task.url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--accent)' }} title="查看">
                        <Eye className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button onClick={() => removeTask(task)} className="p-1.5 rounded hover:bg-red-500/10" style={{ color: '#ef4444' }} title="删除">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {task.ingestionStatus ? (
                    <span
                      className="chip text-[10px] py-0.5 px-2 shrink-0"
                      style={{
                        backgroundColor: task.ingestionStatus === 'completed' ? 'rgba(52,211,153,0.15)' : task.ingestionStatus === 'failed' || task.ingestionStatus === 'unsupported' ? 'rgba(239,68,68,0.15)' : 'rgba(251,191,36,0.15)',
                        color: task.ingestionStatus === 'completed' ? '#34D399' : task.ingestionStatus === 'failed' || task.ingestionStatus === 'unsupported' ? '#EF4444' : '#FBBF24',
                      }}
                    >
                      {task.ingestionStatus === 'completed' ? '已入库' : task.ingestionStatus === 'unsupported' ? '不支持' : task.ingestionStatus}
                    </span>
                  ) : (
                    <span className="chip chip-emerald text-[10px] py-0.5 px-2 shrink-0">已完成</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Failed */}
      {failedTasks.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3" style={{ color: '#ef4444' }}>上传失败 ({failedTasks.length})</h3>
          <div className="space-y-1">
            {failedTasks.map((task, i) => (
              <div key={`fail-${i}`} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ backgroundColor: 'rgba(239,68,68,0.05)' }}>
                <X className="w-4 h-4" style={{ color: '#ef4444' }} />
                <span className="text-sm flex-1" style={{ color: 'var(--text-secondary)' }}>{task.fileName}</span>
                <button onClick={() => removeTask(task)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
