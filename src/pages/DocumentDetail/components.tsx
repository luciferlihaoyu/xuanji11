import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Download,
  Edit3,
  Trash2,
  FolderOpen,
  FileText,
  Tag,
  Plus,
  X,
  ChevronLeft,
} from 'lucide-react';
import type { KnowledgeNode, KbDocument } from '@db/schema';
import { formatDate, formatFileSize } from './utils';

export function PageLoading() {
  return (
    <div className="flex h-[calc(100vh-48px)] items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="flex flex-col items-center gap-3">
        <div
          className="animate-rotate w-8 h-8 rounded-full border-2"
          style={{ borderColor: 'var(--accent-cyan-dim)', borderTopColor: 'var(--accent-cyan)' }}
        />
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>加载文档...</span>
      </div>
    </div>
  );
}

export function PageError({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex h-[calc(100vh-48px)] items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="text-center max-w-md px-4">
        <FileText className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
        <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{message}</p>
        <Link to="/kb" className="btn-primary text-xs px-4 py-2 inline-flex items-center gap-1">
          <ChevronLeft className="w-4 h-4" /> 返回知识库
        </Link>
      </div>
    </div>
  );
}

interface RightPanelProps {
  doc: KbDocument;
  associatedNodes?: KnowledgeNode[];
  onDownload: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCreateAssociation: () => void;
}

export function RightPanel({
  doc,
  associatedNodes,
  onDownload,
  onEdit,
  onDelete,
  onCreateAssociation,
}: RightPanelProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    if (doc.tags) setTags(doc.tags);
  }, [doc.tags]);

  const addTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      setTags([...tags, newTag.trim()]);
      setNewTag('');
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const displayType = doc.format.toUpperCase();
  const displaySize = formatFileSize(doc.content?.length ?? 0);
  const version = {
    id: 'current',
    date: formatDate(doc.updatedAt),
    editor: '当前版本',
    size: displaySize,
    change: '当前版本',
  };

  return (
    <div
      className="w-[300px] shrink-0 border-l overflow-y-auto"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="p-4">
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{doc.title}</h3>
        <span className="chip text-[10px] py-0.5 px-2 mb-4 inline-block">{displayType}</span>

        <div className="space-y-3 mb-6">
          {[
            { label: '大小', value: displaySize },
            { label: '格式', value: displayType },
            { label: '字符数', value: `${doc.content?.length ?? 0} 字符` },
            { label: '创建时间', value: formatDate(doc.createdAt) },
            { label: '修改时间', value: formatDate(doc.updatedAt) },
          ].map((item) => (
            <div
              key={item.label}
              className="flex justify-between py-1.5 border-b"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
              <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{item.value}</span>
            </div>
          ))}
          <div className="flex justify-between py-1.5 border-b items-center" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>上传者</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>未知</span>
            </div>
          </div>
          <div className="py-1.5">
            <span className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>存储位置</span>
            <code className="text-[10px] break-all" style={{ color: 'var(--text-secondary)' }}>数据库存储</code>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>关联知识</h4>
            <button onClick={onCreateAssociation} className="btn-ghost text-[10px] py-1 px-2 flex items-center gap-1">
              <Plus className="w-3 h-3" />
              创建关联
            </button>
          </div>
          {(associatedNodes ?? []).length > 0 ? (
            <div className="space-y-2">
              {associatedNodes?.map((k) => (
                <Link key={k.id} to="/" className="block p-2 rounded hover:bg-white/5 transition-colors">
                  <div className="text-xs font-medium" style={{ color: 'var(--accent-cyan)' }}>{k.title}</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {(k.content ?? '').slice(0, 60) || '无描述'}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无关联</p>
          )}
        </div>

        <div className="mb-6">
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-1" style={{ color: 'var(--text-primary)' }}>
            <Tag className="w-3.5 h-3.5" />
            标签
          </h4>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.map((tag) => (
              <span key={tag} className="chip chip-violet text-[10px] py-0.5 px-2 flex items-center gap-1">
                {tag}
                <button onClick={() => removeTag(tag)} className="hover:text-[var(--accent-rose)]">
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag()}
              placeholder="添加标签..."
              className="input-base text-xs h-7 flex-1"
            />
            <button onClick={addTag} className="btn-secondary text-xs h-7 px-2">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="mb-6">
          <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>版本历史</h4>
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex flex-col items-center">
                <span className="w-2 h-2 rounded-full mt-1" style={{ backgroundColor: 'var(--accent-cyan)' }} />
              </div>
              <div className="pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>v1</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{version.date}</span>
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{version.editor}</div>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{version.size} · {version.change}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onDownload} className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5">
            <Download className="w-3.5 h-3.5" />
            下载
          </button>
          <button onClick={onEdit} className="btn-secondary w-full text-xs py-2 flex items-center justify-center gap-1.5">
            <Edit3 className="w-3.5 h-3.5" />
            编辑
          </button>
          <Link to="/kb" className="btn-ghost w-full text-xs py-2 flex items-center justify-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" />
            在文件夹中查看
          </Link>
          <button onClick={onDelete} className="btn-danger w-full text-xs py-2 flex items-center justify-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" />
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
