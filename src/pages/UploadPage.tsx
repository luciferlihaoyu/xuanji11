import { useState, useCallback } from 'react';
import { Upload, File, FileText, Image, Music, Video, Code, Archive, X, Loader2 } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

interface UploadTask {
  id: string;
  fileName: string;
  fileSize: string;
  fileType: string;
  progress: number;
  status: 'queued' | 'uploading' | 'processing' | 'completed' | 'failed';
  speed?: string;
}

const fileTypeIcons: Record<string, { icon: any; color: string }> = {
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

const initialTasks: UploadTask[] = [
  { id: '1', fileName: '系统架构文档.pdf', fileSize: '2.5 MB', fileType: 'pdf', progress: 100, status: 'completed' },
  { id: '2', fileName: 'Agent 记忆机制.md', fileSize: '12 KB', fileType: 'md', progress: 100, status: 'completed' },
  { id: '3', fileName: '技术架构图.png', fileSize: '1.8 MB', fileType: 'png', progress: 85, status: 'uploading', speed: '2.4 MB/s' },
  { id: '4', fileName: '会议录音.mp3', fileSize: '15 MB', fileType: 'mp3', progress: 42, status: 'uploading', speed: '3.1 MB/s' },
  { id: '5', fileName: '数据分析报告.xlsx', fileSize: '856 KB', fileType: 'xlsx', progress: 0, status: 'queued' },
];

export default function UploadPage() {
  const { addToast } = useAppStore();
  const [dragActive, setDragActive] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>(initialTasks);
  const [processingSettings, setProcessingSettings] = useState({
    autoExtract: true,
    autoVectorize: true,
    autoKeywords: true,
    autoRelate: true,
    autoTag: true,
    notifyAgents: false,
    vectorModel: 'text-embedding-3-large',
  });

  const activeTasks = tasks.filter((t) => t.status === 'uploading' || t.status === 'queued' || t.status === 'processing');
  const completedTasks = tasks.filter((t) => t.status === 'completed');

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files?.length > 0) {
      const newTasks: UploadTask[] = Array.from(e.dataTransfer.files).map((file, i) => ({
        id: `new-${Date.now()}-${i}`,
        fileName: file.name,
        fileSize: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
        fileType: file.name.split('.').pop() || '',
        progress: 0,
        status: 'queued' as const,
      }));
      setTasks((prev) => [...prev, ...newTasks]);
      addToast({ type: 'info', title: `已添加 ${newTasks.length} 个文件到上传队列` });
    }
  }, [addToast]);

  const removeTask = (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="p-6 max-w-5xl mx-auto" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Upload Zone */}
      <div
        className="mb-6 rounded-xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center min-h-[280px]"
        style={{
          backgroundColor: dragActive ? 'rgba(34,211,238,0.05)' : 'var(--bg-secondary)',
          borderColor: dragActive ? 'var(--accent-cyan)' : 'var(--border-subtle)',
        }}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <Upload
          className="w-12 h-12 mb-4 transition-colors"
          style={{ color: dragActive ? 'var(--accent-cyan)' : 'var(--text-muted)' }}
        />
        <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          拖拽文件到此处上传
        </h3>
        <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>或点击选择文件</p>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          支持 PDF、Word、图片、视频、代码等所有格式，最大 500MB/文件
        </p>
        <label className="btn-primary text-sm py-2 px-6 cursor-pointer flex items-center gap-2">
          <Upload className="w-4 h-4" />
          选择文件
          <input type="file" multiple className="hidden" onChange={(e) => {
            if (e.target.files?.length) {
              const newTasks = Array.from(e.target.files).map((file, i) => ({
                id: `file-${Date.now()}-${i}`,
                fileName: file.name,
                fileSize: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
                fileType: file.name.split('.').pop() || '',
                progress: 0,
                status: 'queued' as const,
              }));
              setTasks((prev) => [...prev, ...newTasks]);
            }
          }} />
        </label>
      </div>

      {/* Upload Queue */}
      {activeTasks.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
            上传队列 ({activeTasks.length})
          </h3>
          <div className="space-y-2">
            {activeTasks.map((task) => {
              const { icon: Icon, color } = getFileIcon(task.fileName);
              return (
                <div
                  key={task.id}
                  className="flex items-center gap-3 p-3 rounded-md border"
                  style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
                >
                  <div
                    className="w-8 h-8 rounded flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${color}20` }}
                  >
                    <Icon className="w-4 h-4" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{task.fileName}</span>
                      <span className="text-xs shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>{task.fileSize}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                        <div
                          className="h-full rounded-full transition-all duration-300 gradient-bar"
                          style={{
                            width: `${task.progress}%`,
                            opacity: task.status === 'processing' ? 0.7 : 1,
                          }}
                        />
                      </div>
                      <span className="text-xs w-10 text-right" style={{ color: 'var(--text-secondary)' }}>
                        {task.progress}%
                      </span>
                      {task.speed && (
                        <span className="text-xs w-16 text-right" style={{ color: 'var(--text-muted)' }}>{task.speed}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {task.status === 'uploading' && <Loader2 className="w-4 h-4 animate-rotate" style={{ color: 'var(--accent-cyan)' }} />}
                    {task.status === 'processing' && <Loader2 className="w-4 h-4 animate-rotate" style={{ color: 'var(--accent-amber)' }} />}
                    <button onClick={() => removeTask(task.id)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}>
                      <X className="w-4 h-4" />
                    </button>
                  </div>
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>已完成 ({completedTasks.length})</h3>
            <button
              onClick={() => setTasks((prev) => prev.filter((t) => t.status !== 'completed'))}
              className="btn-ghost text-xs py-1 px-2"
            >
              清空已完成
            </button>
          </div>
          <div className="space-y-1">
            {completedTasks.map((task) => {
              const { icon: Icon, color } = getFileIcon(task.fileName);
              return (
                <div key={task.id} className="flex items-center gap-3 px-3 py-2 rounded-md opacity-60 hover:opacity-100 transition-opacity">
                  <Icon className="w-4 h-4" style={{ color }} />
                  <span className="text-sm flex-1" style={{ color: 'var(--text-secondary)' }}>{task.fileName}</span>
                  <span className="chip chip-emerald text-[10px] py-0.5 px-2">已完成</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Processing Settings */}
      <div className="border rounded-lg p-4" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-secondary)' }}>
        <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>上传后自动处理</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {[
            { key: 'autoExtract', label: '自动提取文本', desc: 'OCR / 文本解析' },
            { key: 'autoVectorize', label: '自动向量化', desc: '转换为 Embedding 向量' },
            { key: 'autoKeywords', label: '自动提取关键词', desc: 'AI 关键词提取' },
            { key: 'autoRelate', label: '自动关联相似知识', desc: '语义相似度匹配' },
            { key: 'autoTag', label: '自动打标签', desc: 'AI 自动分类' },
            { key: 'notifyAgents', label: '通知相关 Agent', desc: '通知负责 Agent 审核' },
          ].map((item) => (
            <label key={item.key} className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={processingSettings[item.key as keyof typeof processingSettings] as boolean}
                onChange={(e) => setProcessingSettings((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                className="mt-0.5 w-4 h-4 rounded"
                style={{ accentColor: 'var(--accent-cyan)' }}
              />
              <div>
                <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{item.label}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.desc}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--text-primary)' }}>
            向量化模型
          </label>
          <select
            className="input-base text-xs max-w-xs"
            value={processingSettings.vectorModel}
            onChange={(e) => setProcessingSettings((prev) => ({ ...prev, vectorModel: e.target.value }))}
          >
            <option value="text-embedding-3-large">OpenAI text-embedding-3-large</option>
            <option value="text-embedding-3-small">OpenAI text-embedding-3-small</option>
            <option value="bge-large-zh">BGE-large-zh</option>
            <option value="m3e-base">M3E-base</option>
            <option value="custom">自定义...</option>
          </select>
        </div>
      </div>
    </div>
  );
}
