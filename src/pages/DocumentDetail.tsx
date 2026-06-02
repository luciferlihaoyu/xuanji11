import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Edit3, Trash2, FolderOpen, FileText, Tag, Plus, X, ChevronLeft, ZoomIn, ZoomOut, RotateCcw, Maximize2 } from 'lucide-react';

const DOCUMENT = {
  id: 'doc1',
  name: '系统架构文档.pdf',
  type: 'PDF',
  size: '2.5 MB',
  createdAt: '2026-05-15',
  updatedAt: '2026-06-01',
  uploadedBy: { name: '美智子（女娲）', avatar: '☸' },
  storagePath: '/home/node/.openclaw/wiki/系统架构/系统架构文档.pdf',
  storageType: 'local' as const,
  pages: 24,
};

const ASSOCIATED_KNOWLEDGE = [
  { id: 'k1', name: 'OpenClaw 系统架构', context: '本文档详细描述了系统架构设计' },
  { id: 'k2', name: 'MAAP 通信协议', context: '协议规范参考了本架构文档' },
];

const VERSIONS = [
  { id: 'v3', date: '2026-06-01', editor: '美智子（女娲）', size: '2.5 MB', change: '+12 页' },
  { id: 'v2', date: '2026-05-20', editor: '羲和', size: '1.8 MB', change: '+8 页' },
  { id: 'v1', date: '2026-05-15', editor: '美智子（女娲）', size: '980 KB', change: '初始版本' },
];

export default function DocumentDetail() {
  const [tags, setTags] = useState(['系统架构', '设计文档', 'PDF']);
  const [newTag, setNewTag] = useState('');
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);

  const addTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      setTags([...tags, newTag.trim()]);
      setNewTag('');
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  return (
    <div className="flex h-[calc(100vh-48px)]" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Preview Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div
          className="flex items-center justify-between px-4 py-2 border-b shrink-0"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Link to="/kb" className="flex items-center gap-1 hover:text-[var(--accent-cyan)] transition-colors">
              <ChevronLeft className="w-4 h-4" />
              返回知识库
            </Link>
            <span>/</span>
            <span>系统架构</span>
            <span>/</span>
            <span style={{ color: 'var(--text-primary)' }}>{DOCUMENT.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}>
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs w-12 text-center" style={{ color: 'var(--text-muted)' }}>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(3, z + 0.1))} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}>
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-px h-5 mx-2" style={{ backgroundColor: 'var(--border-subtle)' }} />
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}>
              <RotateCcw className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}>
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Preview Content */}
        <div className="flex-1 flex items-center justify-center overflow-auto p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
          <div
            className="bg-white rounded-md shadow-lg overflow-hidden transition-transform"
            style={{
              width: `${210 * 4 * zoom}px`,
              height: `${297 * 4 * zoom}px`,
              maxWidth: '90%',
            }}
          >
            <div className="w-full h-full flex flex-col items-center justify-center" style={{ background: 'linear-gradient(135deg, #f8fafc, #e2e8f0)' }}>
              <FileText className="w-16 h-16 mb-4" style={{ color: '#94A3B8' }} />
              <p className="text-lg font-semibold" style={{ color: '#475569' }}>{DOCUMENT.name}</p>
              <p className="text-sm mt-1" style={{ color: '#94A3B8' }}>{DOCUMENT.pages} 页 · {DOCUMENT.size}</p>
              <div className="mt-6 p-4 rounded-md max-w-md" style={{ backgroundColor: 'rgba(255,255,255,0.5)' }}>
                <p className="text-xs text-center leading-relaxed" style={{ color: '#64748B' }}>
                  此文档包含 OpenClaw 系统的完整架构设计，
                  <br />包括天庭 Hub、Wiki 知识库、技能系统等核心组件的详细说明。
                </p>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs" style={{ color: '#94A3B8' }}>
                <span>Page {currentPage} of {DOCUMENT.pages}</span>
              </div>
              {/* Page navigation */}
              <div className="flex items-center gap-2 mt-4">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="px-3 py-1 rounded text-xs border disabled:opacity-30"
                  style={{ borderColor: '#CBD5E1', color: '#475569' }}
                >
                  上一页
                </button>
                <span className="text-xs" style={{ color: '#64748B' }}>
                  {currentPage} / {DOCUMENT.pages}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(DOCUMENT.pages, p + 1))}
                  disabled={currentPage >= DOCUMENT.pages}
                  className="px-3 py-1 rounded text-xs border disabled:opacity-30"
                  style={{ borderColor: '#CBD5E1', color: '#475569' }}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel */}
      <div
        className="w-[300px] shrink-0 border-l overflow-y-auto"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="p-4">
          {/* File Info */}
          <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{DOCUMENT.name}</h3>
          <span className="chip text-[10px] py-0.5 px-2 mb-4 inline-block">{DOCUMENT.type}</span>

          <div className="space-y-3 mb-6">
            {[
              { label: '大小', value: DOCUMENT.size },
              { label: '格式', value: DOCUMENT.type },
              { label: '页数', value: `${DOCUMENT.pages} 页` },
              { label: '创建时间', value: DOCUMENT.createdAt },
              { label: '修改时间', value: DOCUMENT.updatedAt },
            ].map((item) => (
              <div key={item.label} className="flex justify-between py-1.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{item.value}</span>
              </div>
            ))}
            <div className="flex justify-between py-1.5 border-b items-center" style={{ borderColor: 'var(--border-subtle)' }}>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>上传者</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{DOCUMENT.uploadedBy.name}</span>
              </div>
            </div>
            <div className="py-1.5">
              <span className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>存储位置</span>
              <code className="text-[10px] break-all" style={{ color: 'var(--text-secondary)' }}>{DOCUMENT.storagePath}</code>
            </div>
          </div>

          {/* Associated Knowledge */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>关联知识</h4>
              <button className="btn-ghost text-[10px] py-1 px-2 flex items-center gap-1">
                <Plus className="w-3 h-3" />
                创建关联
              </button>
            </div>
            {ASSOCIATED_KNOWLEDGE.length > 0 ? (
              <div className="space-y-2">
                {ASSOCIATED_KNOWLEDGE.map((k) => (
                  <Link key={k.id} to={`/kb/${k.id}`} className="block p-2 rounded hover:bg-white/5 transition-colors">
                    <div className="text-xs font-medium" style={{ color: 'var(--accent-cyan)' }}>{k.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{k.context}</div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无关联</p>
            )}
          </div>

          {/* Tags */}
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

          {/* Version History */}
          <div className="mb-6">
            <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>版本历史</h4>
            <div className="space-y-2">
              {VERSIONS.map((v, i) => (
                <div key={v.id} className="flex items-start gap-2">
                  <div className="flex flex-col items-center">
                    <span className="w-2 h-2 rounded-full mt-1" style={{ backgroundColor: i === 0 ? 'var(--accent-cyan)' : 'var(--border-active)' }} />
                    {i < VERSIONS.length - 1 && <div className="w-px flex-1 mt-1" style={{ backgroundColor: 'var(--border-subtle)' }} />}
                  </div>
                  <div className="pb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>v{VERSIONS.length - i}</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{v.date}</span>
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{v.editor}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{v.size} · {v.change}</div>
                    {i > 0 && (
                      <button className="text-[10px] mt-1" style={{ color: 'var(--accent-cyan)' }}>
                        恢复此版本
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5">
              <Download className="w-3.5 h-3.5" />
              下载
            </button>
            <button className="btn-secondary w-full text-xs py-2 flex items-center justify-center gap-1.5">
              <Edit3 className="w-3.5 h-3.5" />
              编辑关联
            </button>
            <Link to="/kb" className="btn-ghost w-full text-xs py-2 flex items-center justify-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5" />
              在文件夹中查看
            </Link>
            <button className="btn-danger w-full text-xs py-2 flex items-center justify-center gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
