import { useState, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { Play, Pause, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, Save, ChevronDown, Copy, Trash2, Power, Plus, X, Check, GripVertical } from 'lucide-react';

interface WFNode {
  id: string;
  type: string;
  category: string;
  label: string;
  x: number;
  y: number;
  description: string;
  config: Record<string, any>;
  status: 'idle' | 'running' | 'success' | 'error';
}

interface WFEdge {
  id: string;
  source: string;
  target: string;
}

const NODE_CATEGORIES: Record<string, { label: string; color: string; bg: string }> = {
  trigger: { label: '触发器', color: '#00e5ff', bg: 'rgba(0,229,255,0.1)' },
  processing: { label: '知识处理', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
  connection: { label: '知识连接', color: '#00d68f', bg: 'rgba(0,214,143,0.1)' },
  agent: { label: 'Agent', color: '#ffb347', bg: 'rgba(255,179,71,0.1)' },
  output: { label: '输出', color: '#ff6b81', bg: 'rgba(255,107,129,0.1)' },
  logic: { label: '逻辑', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
};

const SAMPLE_NODES: WFNode[] = [
  { id: 'n1', type: 'file-upload', category: 'trigger', label: '文件上传触发', x: 80, y: 200, description: '当有新文件上传时触发', config: {}, status: 'idle' },
  { id: 'n2', type: 'text-extract', category: 'processing', label: '文本提取', x: 320, y: 160, description: 'OCR/文本解析', config: {}, status: 'idle' },
  { id: 'n3', type: 'vectorize', category: 'processing', label: '向量化', x: 560, y: 160, description: 'Embedding 转换', config: { model: 'text-embedding-3-large' }, status: 'idle' },
  { id: 'n4', type: 'keywords', category: 'processing', label: '关键词提取', x: 320, y: 340, description: '自动提取关键词', config: {}, status: 'idle' },
  { id: 'n5', type: 'find-similar', category: 'connection', label: '查找相似知识', x: 800, y: 120, description: '语义相似度搜索', config: {}, status: 'idle' },
  { id: 'n6', type: 'create-link', category: 'connection', label: '建立关联', x: 800, y: 260, description: '创建知识链接', config: {}, status: 'idle' },
  { id: 'n7', type: 'notify-agent', category: 'agent', label: '通知 Agent', x: 1040, y: 160, description: '通知相关 Agent', config: {}, status: 'idle' },
  { id: 'n8', type: 'save-result', category: 'output', label: '保存结果', x: 1040, y: 360, description: '保存到知识库', config: {}, status: 'idle' },
];

const SAMPLE_EDGES: WFEdge[] = [
  { id: 'e1', source: 'n1', target: 'n2' },
  { id: 'e2', source: 'n2', target: 'n3' },
  { id: 'e3', source: 'n2', target: 'n4' },
  { id: 'e4', source: 'n3', target: 'n5' },
  { id: 'e5', source: 'n3', target: 'n6' },
  { id: 'e6', source: 'n5', target: 'n7' },
  { id: 'e7', source: 'n6', target: 'n7' },
  { id: 'e8', source: 'n4', target: 'n8' },
];

const COMPONENT_LIBRARY = [
  { category: 'trigger', items: [
    { type: 'file-upload', label: '文件上传触发', desc: '新文件上传时触发' },
    { type: 'cron', label: '定时触发', desc: '按计划时间触发' },
    { type: 'webhook', label: 'Webhook 触发', desc: '接收 HTTP 请求触发' },
  ]},
  { category: 'processing', items: [
    { type: 'text-extract', label: '文本提取', desc: 'OCR/文本解析' },
    { type: 'vectorize', label: '向量化', desc: 'Embedding 转换' },
    { type: 'keywords', label: '关键词提取', desc: '自动提取关键词' },
    { type: 'summarize', label: '摘要生成', desc: '生成内容摘要' },
  ]},
  { category: 'connection', items: [
    { type: 'find-similar', label: '查找相似知识', desc: '语义相似度搜索' },
    { type: 'create-link', label: '建立关联', desc: '创建知识链接' },
  ]},
  { category: 'agent', items: [
    { type: 'call-agent', label: '调用 Agent', desc: '调用指定 Agent' },
    { type: 'notify-agent', label: '通知 Agent', desc: '发送通知给 Agent' },
  ]},
  { category: 'output', items: [
    { type: 'save-result', label: '保存结果', desc: '保存到知识库' },
    { type: 'send-notification', label: '发送通知', desc: '推送通知' },
  ]},
  { category: 'logic', items: [
    { type: 'condition', label: '条件分支', desc: 'IF/ELSE 分支' },
    { type: 'delay', label: '延迟', desc: '等待指定时间' },
  ]},
];

export default function WorkflowBuilder() {
  const { addToast } = useAppStore();
  const [nodes, setNodes] = useState<WFNode[]>(SAMPLE_NODES);
  const [edges, setEdges] = useState<WFEdge[]>(SAMPLE_EDGES);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['trigger', 'processing', 'connection']));
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  // Drag node
  const handleMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setDraggingNode(nodeId);
    setDragOffset({ x: e.clientX - node.x * zoom - pan.x, y: e.clientY - node.y * zoom - pan.y });
    setSelectedNode(nodeId);
  }, [nodes, zoom, pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : e.clientX;
    const my = rect ? e.clientY - rect.top : e.clientY;
    setMousePos({ x: mx, y: my });

    if (!draggingNode) return;
    const newX = (e.clientX - dragOffset.x - pan.x) / zoom;
    const newY = (e.clientY - dragOffset.y - pan.y) / zoom;
    setNodes((prev) => prev.map((n) => n.id === draggingNode ? { ...n, x: newX, y: newY } : n));
  }, [draggingNode, dragOffset, zoom, pan]);

  const handleMouseUp = useCallback(() => setDraggingNode(null), []);

  // Pan canvas
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      const startX = e.clientX - pan.x;
      const startY = e.clientY - pan.y;
      const moveHandler = (ev: MouseEvent) => {
        setPan({ x: ev.clientX - startX, y: ev.clientY - startY });
      };
      const upHandler = () => {
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
      };
      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', upHandler);
    }
  };

  // Create connection
  const handlePortClick = (nodeId: string, isOutput: boolean) => {
    if (isOutput) {
      if (connectingFrom === nodeId) { setConnectingFrom(null); return; }
      setConnectingFrom(nodeId);
    } else {
      if (connectingFrom && connectingFrom !== nodeId) {
        const edgeId = `e-${connectingFrom}-${nodeId}`;
        if (!edges.find((e) => e.source === connectingFrom && e.target === nodeId)) {
          setEdges((prev) => [...prev, { id: edgeId, source: connectingFrom, target: nodeId }]);
          addToast({ type: 'success', title: '连线已创建' });
        }
        setConnectingFrom(null);
      }
    }
  };

  // Add node from palette
  const addNode = (type: string, category: string, label: string) => {
    const newNode: WFNode = {
      id: `n-${Date.now()}`,
      type,
      category,
      label,
      x: 200 + Math.random() * 200,
      y: 200 + Math.random() * 100,
      description: '',
      config: {},
      status: 'idle',
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNode(newNode.id);
    addToast({ type: 'success', title: `已添加「${label}」节点` });
  };

  // Delete node
  const deleteNode = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
    setSelectedNode(null);
  };

  // Duplicate node
  const duplicateNode = (node: WFNode) => {
    const newNode: WFNode = { ...node, id: `n-${Date.now()}`, x: node.x + 30, y: node.y + 30, status: 'idle' };
    setNodes((prev) => [...prev, newNode]);
  };

  // Run workflow
  const runWorkflow = () => {
    setIsRunning(true);
    setNodes((prev) => prev.map((n) => ({ ...n, status: 'idle' })));

    let step = 0;
    const interval = setInterval(() => {
      setNodes((prev) => {
        const next = [...prev];
        if (step < next.length) {
          next[step] = { ...next[step], status: 'running' };
          if (step > 0) next[step - 1] = { ...next[step - 1], status: 'success' };
        } else if (step === next.length) {
          next[next.length - 1] = { ...next[next.length - 1], status: 'success' };
        }
        return next;
      });
      step++;
      if (step > nodes.length) { clearInterval(interval); setIsRunning(false); addToast({ type: 'success', title: '工作流执行完成' }); }
    }, 600);
  };

  const selectedNodeData = nodes.find((n) => n.id === selectedNode);
  const connectingFromNode = connectingFrom ? nodes.find((n) => n.id === connectingFrom) : null;

  // Edge path
  const getEdgePath = (edge: WFEdge) => {
    const s = nodes.find((n) => n.id === edge.source);
    const t = nodes.find((n) => n.id === edge.target);
    if (!s || !t) return '';
    const dx = t.x - s.x, dy = t.y - s.y;
    const dr = Math.sqrt(dx * dx + dy * dy) * 1.2;
    return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
  };

  return (
    <div className="flex" style={{ height: 'calc(100vh - 48px)', backgroundColor: 'var(--bg-primary)' }}>
      {/* Left Palette */}
      <div className="w-[220px] shrink-0 border-r flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
        <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-cyan)' }}>组件库</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {COMPONENT_LIBRARY.map((group) => {
            const catInfo = NODE_CATEGORIES[group.category];
            const expanded = expandedCategories.has(group.category);
            return (
              <div key={group.category}>
                <button className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium" style={{ color: 'var(--text-secondary)' }} onClick={() => toggleCategory(group.category)}>
                  <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? '' : '-rotate-90'}`} style={{ color: 'var(--text-muted)' }} />
                  <span style={{ color: catInfo.color }}>◆</span>
                  <span>{catInfo.label}</span>
                </button>
                {expanded && (
                  <div className="pb-1">
                    {group.items.map((item) => (
                      <div key={item.type} draggable onDragStart={() => {}} onClick={() => addNode(item.type, group.category, item.label)}
                        className="flex items-center gap-2 px-3 py-1.5 mx-2 rounded cursor-pointer text-xs transition-colors hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}>
                        <Plus className="w-3 h-3 shrink-0" style={{ color: catInfo.color }} />
                        <div><div className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.label}</div><div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.desc}</div></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0 h-11" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <input type="text" defaultValue="新人上手工作流" className="bg-transparent text-sm font-semibold outline-none sci-corner px-2 py-0.5" style={{ color: 'var(--text-primary)' }} />
            <span className="chip chip-amber text-[10px] py-0.5 px-2">草稿</span>
          </div>
          <div className="flex items-center gap-1">
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }} title="撤销"><Undo2 className="w-4 h-4" /></button>
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }} title="重做"><Redo2 className="w-4 h-4" /></button>
            <div className="w-px h-5 mx-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }} onClick={() => setZoom((z) => Math.max(0.25, z - 0.1))}><ZoomOut className="w-4 h-4" /></button>
            <span className="text-xs w-10 text-center font-mono" style={{ color: 'var(--text-muted)' }}>{Math.round(zoom * 100)}%</span>
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }} onClick={() => setZoom((z) => Math.min(2, z + 0.1))}><ZoomIn className="w-4 h-4" /></button>
            <button className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-secondary)' }}><Maximize2 className="w-4 h-4" /></button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={runWorkflow} disabled={isRunning} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
              {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}{isRunning ? '运行中' : '调试运行'}
            </button>
            <button className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"><Save className="w-3.5 h-3.5" />保存</button>
          </div>
        </div>

        {/* Canvas Area */}
        <div ref={canvasRef} className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
          style={{ backgroundColor: 'var(--bg-primary)' }}
          onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseDown={handleCanvasMouseDown}>
          {/* Grid */}
          <div className="absolute inset-0 opacity-30 bg-grid" style={{ backgroundSize: `${20 * zoom}px ${20 * zoom}px`, transform: `translate(${pan.x % (20 * zoom)}px, ${pan.y % (20 * zoom)}px)` }} />

          {/* SVG Layer */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
            <defs>
              <marker id="edgeArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 L 2 5 z" fill="var(--accent-cyan)" opacity="0.6" />
              </marker>
            </defs>
            {edges.map((edge) => (
              <g key={edge.id}>
                <path d={getEdgePath(edge)} fill="none" stroke={selectedNode === edge.source || selectedNode === edge.target ? 'var(--accent-cyan)' : 'var(--border-active)'} strokeWidth={selectedNode === edge.source || selectedNode === edge.target ? 2 : 1} opacity={0.5} markerEnd="url(#edgeArrow)" />
                {isRunning && <circle r="2.5" fill="var(--accent-cyan)"><animateMotion dur="1.5s" repeatCount="indefinite" path={getEdgePath(edge)} /></circle>}
              </g>
            ))}
            {/* Connecting line */}
            {connectingFromNode && (
              <line x1={connectingFromNode.x} y1={connectingFromNode.y} x2={(mousePos.x - pan.x) / zoom} y2={(mousePos.y - pan.y) / zoom} stroke="var(--accent-cyan)" strokeWidth="1.5" strokeDasharray="4,4" opacity="0.7" />
            )}
          </svg>

          {/* Node Layer */}
          <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
            {nodes.map((node) => {
              const catInfo = NODE_CATEGORIES[node.category];
              const isSelected = selectedNode === node.id;
              const isConnecting = connectingFrom === node.id;
              return (
                <div key={node.id} className="absolute select-none" style={{ left: node.x, top: node.y, transform: 'translate(-50%, -50%)', cursor: draggingNode === node.id ? 'grabbing' : 'grab', zIndex: isSelected ? 10 : 1 }}
                  onMouseDown={(e) => handleMouseDown(e, node.id)}>
                  <div className="min-w-[150px] rounded-lg overflow-hidden transition-all duration-200 sci-corner" style={{ backgroundColor: 'var(--bg-panel)', border: `1.5px solid ${isSelected || isConnecting ? catInfo.color : `${catInfo.color}40`}`, boxShadow: isSelected ? `0 0 20px ${catInfo.bg}, 0 4px 12px rgba(0,0,0,0.4)` : `0 2px 8px rgba(0,0,0,0.3)` }}>
                    <div className="h-[3px]" style={{ backgroundColor: catInfo.color }} />
                    <div className="px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <GripVertical className="w-3 h-3 shrink-0" style={{ color: 'var(--text-dim)' }} />
                        <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{node.label}</span>
                        {node.status === 'running' && <div className="animate-rotate w-3 h-3 border-2 border-t-transparent rounded-full ml-auto" style={{ borderColor: catInfo.color, borderTopColor: 'transparent' }} />}
                        {node.status === 'success' && <Check className="w-3 h-3 ml-auto" style={{ color: 'var(--accent-emerald)' }} />}
                      </div>
                      <p className="text-[9px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{node.description}</p>
                    </div>
                    {/* Ports */}
                    <div className="relative h-4">
                      <button onClick={(e) => { e.stopPropagation(); handlePortClick(node.id, false); }} className="absolute left-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 transition-all hover:scale-125" style={{ borderColor: catInfo.color, backgroundColor: connectingFrom && connectingFrom !== node.id ? `${catInfo.color}40` : 'var(--bg-panel)' }} title="输入" />
                      <button onClick={(e) => { e.stopPropagation(); handlePortClick(node.id, true); }} className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 transition-all hover:scale-125" style={{ borderColor: catInfo.color, backgroundColor: isConnecting ? catInfo.color : 'var(--bg-panel)', boxShadow: isConnecting ? `0 0 6px ${catInfo.color}` : 'none' }} title="输出" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Status bar */}
          {connectingFrom && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs font-medium animate-fade-in" style={{ backgroundColor: 'var(--accent-cyan-dim)', border: '1px solid var(--accent-cyan)', color: 'var(--accent-cyan)' }}>
              点击目标节点的输入端口完成连线，按 ESC 取消
            </div>
          )}
        </div>
      </div>

      {/* Right Config Panel */}
      {selectedNodeData && (
        <div className="w-[300px] shrink-0 border-l overflow-y-auto" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <span style={{ color: NODE_CATEGORIES[selectedNodeData.category].color, fontSize: '14px' }}>◆</span>
              <h3 className="text-sm font-bold flex-1" style={{ color: 'var(--text-primary)' }}>{selectedNodeData.label}</h3>
              <div className="flex gap-1">
                <button onClick={() => duplicateNode(selectedNodeData)} className="p-1.5 rounded hover:bg-white/5" title="复制" style={{ color: 'var(--text-muted)' }}><Copy className="w-3.5 h-3.5" /></button>
                <button onClick={() => { deleteNode(selectedNodeData.id); }} className="p-1.5 rounded hover:bg-white/5" title="删除" style={{ color: 'var(--accent-rose)' }}><Trash2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => setSelectedNode(null)} className="p-1.5 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X className="w-4 h-4" /></button>
              </div>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{selectedNodeData.description}</p>
            <div className="space-y-3">
              <div><label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>节点名称</label><input type="text" defaultValue={selectedNodeData.label} className="input-base text-xs" /></div>
              {selectedNodeData.type === 'vectorize' && (
                <><div><label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>向量化模型</label><select className="input-base text-xs"><option>OpenAI text-embedding-3-large</option><option>BGE-large-zh</option><option>M3E-base</option></select></div><div><label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>向量维度</label><input type="number" defaultValue={3072} className="input-base text-xs" /></div></>
              )}
              {selectedNodeData.type === 'notify-agent' && (
                <><div><label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>目标 Agent</label><select className="input-base text-xs"><option>女娲（美智子）</option><option>后土</option><option>上官婉儿</option><option>全部在线 Agent</option></select></div><div><label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>通知内容</label><textarea className="input-base text-xs h-16 resize-none" defaultValue="新的知识已上传并向量化完成，请审核。" /></div></>
              )}
              <div className="flex items-center gap-2 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button className="btn-ghost text-xs py-1.5 flex items-center gap-1"><Power className="w-3.5 h-3.5" />禁用</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
