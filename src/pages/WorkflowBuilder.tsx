import { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAppStore } from '@/store/useAppStore';
import { useWorkflows, useWorkflow, useWorkflowRuns, useWorkflowRun, useRunWorkflow } from '@/hooks/useWorkflows';
import { trpc } from '@/providers/trpc';
import { Play, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, Save, ChevronDown, Copy, Trash2, Power, Plus, X, Check, GripVertical, Loader2, History, ArrowLeft, Clock, AlertCircle, Timer } from 'lucide-react';

interface WFNode {
  id: string;
  clientId: string;
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

interface CanvasEdge {
  sourceClientId: string;
  targetClientId: string;
}

const NODE_CATEGORIES: Record<string, { label: string; color: string; bg: string }> = {
  trigger: { label: '触发器', color: '#00e5ff', bg: 'rgba(0,229,255,0.1)' },
  processing: { label: '知识处理', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
  connection: { label: '知识连接', color: '#00d68f', bg: 'rgba(0,214,143,0.1)' },
  agent: { label: 'Agent', color: '#ffb347', bg: 'rgba(255,179,71,0.1)' },
  output: { label: '输出', color: '#ff6b81', bg: 'rgba(255,107,129,0.1)' },
  logic: { label: '逻辑', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
};

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

function generateClientId() {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getNodeMeta(type: string) {
  for (const group of COMPONENT_LIBRARY) {
    const item = group.items.find((i) => i.type === type);
    if (item) return { ...item, category: group.category };
  }
  return { type, label: '未知节点', desc: '', category: 'processing' };
}

function toFrontendNode(dbNode: any): WFNode {
  const config = (dbNode.config as Record<string, any> | null) ?? {};
  const clientId = (config.clientId as string) || `legacy-${dbNode.id}`;
  const meta = getNodeMeta(dbNode.type);
  const { clientId: _, ...restConfig } = config;
  return {
    id: String(dbNode.id),
    clientId,
    type: dbNode.type,
    category: meta.category,
    label: dbNode.label || meta.label,
    x: dbNode.positionX,
    y: dbNode.positionY,
    description: meta.desc,
    config: restConfig,
    status: 'idle',
  };
}

function toBackendNode(node: WFNode) {
  const { clientId: _, ...restConfig } = node.config;
  return {
    id: /^tmp-/.test(node.id) ? undefined : Number(node.id),
    clientId: node.clientId,
    type: node.type,
    label: node.label,
    positionX: node.x,
    positionY: node.y,
    config: { ...restConfig, clientId: node.clientId },
  };
}

function formatDuration(startedAt: string | Date | null, completedAt: string | Date | null) {
  const start = startedAt ? new Date(startedAt).getTime() : 0;
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!start || !end || end <= start) return '-';
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function WorkflowBuilder() {
  const { id: idParam } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { addToast } = useAppStore();

  const workflowId = idParam && !isNaN(Number(idParam)) ? Number(idParam) : null;

  const { workflows, isLoading: listLoading, create, saveFull } = useWorkflows();
  const { data: workflowData, isLoading: wfLoading } = useWorkflow(workflowId ?? 0);
  const { data: runsData, refetch: refetchRuns } = useWorkflowRuns(workflowId ?? 0);
  const { data: webhookUrlData } = trpc.workflow.webhookUrl.useQuery(
    { id: workflowId ?? 0 },
    { enabled: workflowId !== null }
  );
  const runMutation = useRunWorkflow();

  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const { data: activeRun } = useWorkflowRun(activeRunId);

  const [nodes, setNodes] = useState<WFNode[]>([]);
  const [edges, setEdges] = useState<WFEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['trigger', 'processing', 'connection']));
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [showRuns, setShowRuns] = useState(false);
  const [showTriggers, setShowTriggers] = useState(false);
  const [workflowName, setWorkflowName] = useState('新工作流');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState<'draft' | 'active' | 'paused' | 'error' | 'archived'>('draft');
  const [cronSchedule, setCronSchedule] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const isLoading = listLoading || (workflowId !== null && wfLoading);

  useEffect(() => {
    if (!workflowData) return;
    setWorkflowName(workflowData.name || '未命名工作流');
    setWorkflowDescription(workflowData.description || '');
    setWorkflowStatus(workflowData.status || 'draft');

    const triggers = (workflowData.triggers as Array<{ type: string; schedule?: string; enabled?: boolean }> | undefined) ?? [];
    const cronTrigger = triggers.find((t) => t.type === 'cron');
    const webhookTrigger = triggers.find((t) => t.type === 'webhook');
    setCronSchedule(cronTrigger?.schedule || '');
    setWebhookEnabled(webhookTrigger?.enabled ?? false);

    const loadedNodes = workflowData.nodes.map(toFrontendNode);
    setNodes(loadedNodes);

    const canvas = (workflowData.canvas as Record<string, any> | null) ?? {};
    const canvasEdges = (canvas.edges as CanvasEdge[] | undefined) ?? [];
    const clientIdToId = new Map(loadedNodes.map((n) => [n.clientId, n.id]));
    setEdges(canvasEdges
      .filter((e) => clientIdToId.has(e.sourceClientId) && clientIdToId.has(e.targetClientId))
      .map((e, i) => ({
        id: `e-${clientIdToId.get(e.sourceClientId)}-${clientIdToId.get(e.targetClientId)}-${i}`,
        source: clientIdToId.get(e.sourceClientId)!,
        target: clientIdToId.get(e.targetClientId)!,
      })));

    const viewport = (canvas.viewport as { x?: number; y?: number; zoom?: number } | undefined) ?? {};
    if (viewport.x !== undefined) setPan((p) => ({ ...p, x: viewport.x! }));
    if (viewport.y !== undefined) setPan((p) => ({ ...p, y: viewport.y! }));
    if (viewport.zoom !== undefined) setZoom(viewport.zoom);

    setSelectedNode(null);
  }, [workflowData]);

  useEffect(() => {
    if (webhookUrlData?.url) setWebhookUrl(webhookUrlData.url);
  }, [webhookUrlData]);

  useEffect(() => {
    if (!activeRun) {
      setNodes((prev) => prev.map((n) => ({ ...n, status: 'idle' })));
      setIsRunning(false);
      return;
    }
    const runFinished = activeRun.status === 'completed' || activeRun.status === 'failed' || activeRun.status === 'cancelled';
    setIsRunning(!runFinished);
    const nodeStatusMap = new Map<string, WFNode['status']>();
    if (activeRun.nodes) {
      for (const runNode of activeRun.nodes) {
        const dbNodeId = String(runNode.nodeId);
        const frontendNode = nodes.find((n) => n.id === dbNodeId);
        if (frontendNode) {
          nodeStatusMap.set(frontendNode.id, runNode.status === 'completed' ? 'success' : runNode.status === 'failed' ? 'error' : runNode.status === 'running' ? 'running' : 'idle');
        }
      }
    }
    setNodes((prev) => prev.map((n) => ({ ...n, status: nodeStatusMap.get(n.id) || 'idle' })));
  }, [activeRun, nodes]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

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

  const handlePortClick = (nodeId: string, isOutput: boolean) => {
    if (isOutput) {
      if (connectingFrom === nodeId) { setConnectingFrom(null); return; }
      setConnectingFrom(nodeId);
    } else {
      if (connectingFrom && connectingFrom !== nodeId) {
        const sourceNode = nodes.find((n) => n.id === connectingFrom);
        const targetNode = nodes.find((n) => n.id === nodeId);
        if (!sourceNode || !targetNode) { setConnectingFrom(null); return; }
        const edgeId = `e-${sourceNode.clientId}-${targetNode.clientId}`;
        if (!edges.find((e) => e.source === connectingFrom && e.target === nodeId)) {
          setEdges((prev) => [...prev, { id: edgeId, source: connectingFrom, target: nodeId }]);
          addToast({ type: 'success', title: '连线已创建' });
        }
        setConnectingFrom(null);
      }
    }
  };

  const addNode = (type: string, category: string, label: string) => {
    const clientId = generateClientId();
    const meta = getNodeMeta(type);
    const newNode: WFNode = {
      id: `tmp-${clientId}`,
      clientId,
      type,
      category,
      label,
      x: 200 + Math.random() * 200,
      y: 200 + Math.random() * 100,
      description: meta.desc,
      config: {},
      status: 'idle',
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNode(newNode.id);
    addToast({ type: 'success', title: `已添加「${label}」节点` });
  };

  const deleteNode = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
    setSelectedNode(null);
  };

  const duplicateNode = (node: WFNode) => {
    const clientId = generateClientId();
    const newNode: WFNode = { ...node, id: `tmp-${clientId}`, clientId, x: node.x + 30, y: node.y + 30, status: 'idle' };
    setNodes((prev) => [...prev, newNode]);
  };

  const updateNodeConfig = (id: string, patch: Partial<WFNode> | ((prev: WFNode) => Partial<WFNode>)) => {
    setNodes((prev) => prev.map((n) => {
      if (n.id !== id) return n;
      const updates = typeof patch === 'function' ? patch(n) : patch;
      return { ...n, ...updates };
    }));
  };

  const buildCanvasEdges = (): CanvasEdge[] => {
    const clientIdById = new Map(nodes.map((n) => [n.id, n.clientId]));
    return edges
      .map((e) => ({ sourceClientId: clientIdById.get(e.source), targetClientId: clientIdById.get(e.target) }))
      .filter((e): e is CanvasEdge => !!e.sourceClientId && !!e.targetClientId);
  };

  const buildTriggers = () => {
    const triggers: Array<{ type: string; schedule?: string; enabled?: boolean }> = [];
    if (cronSchedule.trim()) {
      triggers.push({ type: 'cron', schedule: cronSchedule.trim(), enabled: true });
    }
    if (webhookEnabled) {
      triggers.push({ type: 'webhook', enabled: true });
    }
    return triggers;
  };

  const saveWorkflow = async () => {
    const triggers = buildTriggers();
    if (!workflowId) {
      try {
        const { id } = await create({ name: workflowName, description: workflowDescription, status: workflowStatus });
        await saveFull({
          workflow: {
            id,
            name: workflowName,
            description: workflowDescription,
            status: workflowStatus,
            canvas: {
              edges: buildCanvasEdges(),
              viewport: { x: pan.x, y: pan.y, zoom },
            },
            triggers,
          },
          nodes: nodes.map(toBackendNode),
        });
        addToast({ type: 'success', title: '工作流已创建并保存' });
        navigate(`/workflows/${id}`, { replace: true });
      } catch (err) {
        addToast({ type: 'error', title: '保存失败', description: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    setIsSaving(true);
    try {
      const result = await saveFull({
        workflow: {
          id: workflowId,
          name: workflowName,
          description: workflowDescription,
          status: workflowStatus,
          canvas: {
            edges: buildCanvasEdges(),
            viewport: { x: pan.x, y: pan.y, zoom },
          },
          triggers,
        },
        nodes: nodes.map(toBackendNode),
      });
      addToast({ type: 'success', title: '工作流已保存' });
      if (result.nodes) {
        const idMap = new Map<string, string>();
        for (const n of result.nodes) {
          const config = (n.config as Record<string, any> | null) ?? {};
          const clientId = config.clientId as string | undefined;
          if (clientId) idMap.set(clientId, String(n.id));
        }
        setNodes((prev) => prev.map((n) => idMap.has(n.clientId) ? { ...n, id: idMap.get(n.clientId)! } : n));
        setEdges((prev) => prev.map((e, i) => {
          const sourceNode = nodes.find((n) => n.id === e.source);
          const targetNode = nodes.find((n) => n.id === e.target);
          if (!sourceNode || !targetNode) return e;
          const newSource = idMap.get(sourceNode.clientId) || e.source;
          const newTarget = idMap.get(targetNode.clientId) || e.target;
          return { ...e, id: `e-${newSource}-${newTarget}-${i}`, source: newSource, target: newTarget };
        }));
      }
    } catch (err) {
      addToast({ type: 'error', title: '保存失败', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSaving(false);
    }
  };

  const runWorkflow = async () => {
    if (!workflowId) {
      addToast({ type: 'error', title: '请先保存工作流' });
      return;
    }
    if (nodes.length === 0) {
      addToast({ type: 'error', title: '工作流为空，无法运行' });
      return;
    }
    setIsRunning(true);
    try {
      const { runId } = await runMutation.mutateAsync({ id: workflowId, input: {} });
      setActiveRunId(runId);
      setShowRuns(true);
      addToast({ type: 'success', title: '工作流运行已启动' });
      refetchRuns();
    } catch (err) {
      setIsRunning(false);
      addToast({ type: 'error', title: '运行失败', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const selectedNodeData = nodes.find((n) => n.id === selectedNode);
  const connectingFromNode = connectingFrom ? nodes.find((n) => n.id === connectingFrom) : null;

  const getEdgePath = (edge: WFEdge) => {
    const s = nodes.find((n) => n.id === edge.source);
    const t = nodes.find((n) => n.id === edge.target);
    if (!s || !t) return '';
    const dx = t.x - s.x, dy = t.y - s.y;
    const dr = Math.sqrt(dx * dx + dy * dy) * 1.2;
    return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
  };

  const runs = runsData ?? [];

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
          <div className="flex items-center gap-2 min-w-0">
            <Link to="/workflows" className="p-1.5 rounded hover:bg-white/5 shrink-0" style={{ color: 'var(--text-muted)' }} title="返回列表"><ArrowLeft className="w-4 h-4" /></Link>
            <input
              type="text"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              placeholder="工作流名称"
              className="bg-transparent text-sm font-semibold outline-none sci-corner px-2 py-0.5 min-w-[120px] max-w-[240px]"
              style={{ color: 'var(--text-primary)' }}
            />
            <span className="chip chip-amber text-[10px] py-0.5 px-2 shrink-0">{workflowId ? '草稿' : '未保存'}</span>
            <div className="relative shrink-0">
              <select
                value={workflowId ?? 'new'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'new') navigate('/workflows');
                  else navigate(`/workflows/${val}`);
                }}
                className="bg-transparent text-xs outline-none sci-corner px-2 py-1 cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
                disabled={listLoading}
              >
                <option value="new">+ 新建工作流</option>
                {workflows.map((w) => (
                  <option key={w.id} value={String(w.id)}>{w.name}</option>
                ))}
              </select>
            </div>
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
            <button
              onClick={() => setShowTriggers((s) => !s)}
              className={`btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 ${showTriggers ? 'bg-white/10' : ''}`}
            >
              <Timer className="w-3.5 h-3.5" />触发器
            </button>
            <button
              onClick={() => setShowRuns((s) => !s)}
              className={`btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 ${showRuns ? 'bg-white/10' : ''}`}
            >
              <History className="w-3.5 h-3.5" />运行记录
            </button>
            <button onClick={runWorkflow} disabled={isRunning} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
              {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{isRunning ? '运行中' : '调试运行'}
            </button>
            <button onClick={saveWorkflow} disabled={isSaving} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{isSaving ? '保存中' : '保存'}
            </button>
          </div>
        </div>

        {/* Canvas Area */}
        <div ref={canvasRef} className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
          style={{ backgroundColor: 'var(--bg-primary)' }}
          onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseDown={handleCanvasMouseDown}>
          {/* Grid */}
          <div className="absolute inset-0 opacity-30 bg-grid" style={{ backgroundSize: `${20 * zoom}px ${20 * zoom}px`, transform: `translate(${pan.x % (20 * zoom)}px, ${pan.y % (20 * zoom)}px)` }} />

          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--bg-panel)' }}>
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent-cyan)' }} />
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>加载中...</span>
              </div>
            </div>
          )}

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
                        {node.status === 'error' && <AlertCircle className="w-3 h-3 ml-auto" style={{ color: 'var(--accent-rose)' }} />}
                      </div>
                      <p className="text-[9px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{node.description}</p>
                    </div>
                    <div className="relative h-4">
                      <button onClick={(e) => { e.stopPropagation(); handlePortClick(node.id, false); }} className="absolute left-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 transition-all hover:scale-125" style={{ borderColor: catInfo.color, backgroundColor: connectingFrom && connectingFrom !== node.id ? `${catInfo.color}40` : 'var(--bg-panel)' }} title="输入" />
                      <button onClick={(e) => { e.stopPropagation(); handlePortClick(node.id, true); }} className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 transition-all hover:scale-125" style={{ borderColor: catInfo.color, backgroundColor: isConnecting ? catInfo.color : 'var(--bg-panel)', boxShadow: isConnecting ? `0 0 6px ${catInfo.color}` : 'none' }} title="输出" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {connectingFrom && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs font-medium animate-fade-in" style={{ backgroundColor: 'var(--accent-cyan-dim)', border: '1px solid var(--accent-cyan)', color: 'var(--accent-cyan)' }}>
              点击目标节点的输入端口完成连线，按 ESC 取消
            </div>
          )}
        </div>
      </div>

      {/* Right Config Panel */}
      {selectedNodeData && !showRuns && (
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
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>节点名称</label>
                <input
                  type="text"
                  value={selectedNodeData.label}
                  onChange={(e) => updateNodeConfig(selectedNodeData.id, { label: e.target.value })}
                  className="input-base text-xs"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>节点说明</label>
                <input
                  type="text"
                  value={selectedNodeData.description}
                  onChange={(e) => updateNodeConfig(selectedNodeData.id, { description: e.target.value })}
                  className="input-base text-xs"
                />
              </div>
              {selectedNodeData.type === 'vectorize' && (
                <>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>向量化模型</label>
                    <select
                      className="input-base text-xs"
                      value={(selectedNodeData.config.model as string) || 'text-embedding-3-small'}
                      onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, model: e.target.value } }))}
                    >
                      <option value="text-embedding-3-large">OpenAI text-embedding-3-large</option>
                      <option value="text-embedding-3-small">OpenAI text-embedding-3-small</option>
                      <option value="bge-large-zh">BGE-large-zh</option>
                      <option value="m3e-base">M3E-base</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>向量维度</label>
                    <input
                      type="number"
                      value={(selectedNodeData.config.dimension as number) || 1536}
                      onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, dimension: Number(e.target.value) } }))}
                      className="input-base text-xs"
                    />
                  </div>
                </>
              )}
              {selectedNodeData.type === 'notify-agent' && (
                <>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>目标 Agent</label>
                    <select
                      className="input-base text-xs"
                      value={(selectedNodeData.config.agentName as string) || ''}
                      onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, agentName: e.target.value } }))}
                    >
                      <option value="">选择 Agent</option>
                      <option value="女娲">女娲（美智子）</option>
                      <option value="后土">后土</option>
                      <option value="上官婉儿">上官婉儿</option>
                      <option value="全部">全部在线 Agent</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>通知内容</label>
                    <textarea
                      className="input-base text-xs h-16 resize-none"
                      value={(selectedNodeData.config.message as string) || ''}
                      onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, message: e.target.value } }))}
                    />
                  </div>
                </>
              )}
              {(selectedNodeData.type === 'text-extract' || selectedNodeData.type === 'keywords' || selectedNodeData.type === 'summarize') && (
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>输入文本</label>
                  <textarea
                    className="input-base text-xs h-20 resize-none"
                    value={(selectedNodeData.config.text as string) || ''}
                    onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, text: e.target.value } }))}
                    placeholder="运行时可覆盖"
                  />
                </div>
              )}
              {selectedNodeData.type === 'find-similar' && (
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>查询内容</label>
                  <input
                    type="text"
                    className="input-base text-xs"
                    value={(selectedNodeData.config.query as string) || ''}
                    onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, query: e.target.value } }))}
                    placeholder="运行时可覆盖"
                  />
                </div>
              )}
              {selectedNodeData.type === 'delay' && (
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>延迟毫秒</label>
                  <input
                    type="number"
                    className="input-base text-xs"
                    value={(selectedNodeData.config.ms as number) || 1000}
                    onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, ms: Number(e.target.value) } }))}
                  />
                </div>
              )}
              {selectedNodeData.type === 'condition' && (
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>条件表达式</label>
                  <input
                    type="text"
                    className="input-base text-xs"
                    value={(selectedNodeData.config.expression as string) || 'true'}
                    onChange={(e) => updateNodeConfig(selectedNodeData.id, (prev) => ({ config: { ...prev.config, expression: e.target.value } }))}
                  />
                </div>
              )}
              <div className="flex items-center gap-2 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button className="btn-ghost text-xs py-1.5 flex items-center gap-1"><Power className="w-3.5 h-3.5" />禁用</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Runs Panel */}
      {showRuns && (
        <div className="w-[320px] shrink-0 border-l overflow-y-auto" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>运行记录</h3>
              <button onClick={() => setShowRuns(false)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X className="w-4 h-4" /></button>
            </div>
            {runs.length === 0 ? (
              <div className="text-center py-8 rounded-lg border border-dashed" style={{ borderColor: 'var(--border-subtle)' }}>
                <History className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>暂无运行记录</p>
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((run) => (
                  <div
                    key={run.id}
                    onClick={() => setActiveRunId(run.id)}
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${activeRunId === run.id ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-dim)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-active)]'}`}
                    style={{ backgroundColor: activeRunId === run.id ? 'var(--accent-cyan-dim)' : 'var(--bg-panel)' }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Run #{run.id}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${run.status === 'completed' ? 'bg-emerald-500/15 text-emerald-400' : run.status === 'failed' ? 'bg-rose-500/15 text-rose-400' : run.status === 'running' ? 'bg-cyan-500/15 text-cyan-400' : 'bg-amber-500/15 text-amber-400'}`}>
                        {run.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(run.startedAt, run.completedAt)}</span>
                      <span>{new Date(run.createdAt).toLocaleString()}</span>
                    </div>
                    {run.error && <p className="text-[10px] mt-1 truncate" style={{ color: 'var(--accent-rose)' }}>{run.error}</p>}
                  </div>
                ))}
              </div>
            )}

            {activeRun && (
              <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <h4 className="text-xs font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Run #{activeRun.id} 节点详情</h4>
                {activeRun.nodes && activeRun.nodes.length > 0 ? (
                  <div className="space-y-2">
                    {activeRun.nodes.map((runNode) => {
                      const frontendNode = nodes.find((n) => n.id === String(runNode.nodeId));
                      return (
                        <div key={runNode.id} className="p-2 rounded border text-xs" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
                          <div className="flex items-center justify-between">
                            <span style={{ color: 'var(--text-primary)' }}>{frontendNode?.label || `节点 #${runNode.nodeId}`}</span>
                            <span className={`text-[10px] ${runNode.status === 'completed' ? 'text-emerald-400' : runNode.status === 'failed' ? 'text-rose-400' : runNode.status === 'running' ? 'text-cyan-400' : 'text-amber-400'}`}>{runNode.status}</span>
                          </div>
                          {runNode.error && <p className="text-[10px] mt-1" style={{ color: 'var(--accent-rose)' }}>{runNode.error}</p>}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无节点详情</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Triggers Panel */}
      {showTriggers && (
        <div className="w-[320px] shrink-0 border-l overflow-y-auto" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>触发器配置</h3>
              <button onClick={() => setShowTriggers(false)} className="p-1 rounded hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X className="w-4 h-4" /></button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>工作流状态</label>
                <select
                  value={workflowStatus}
                  onChange={(e) => setWorkflowStatus(e.target.value as typeof workflowStatus)}
                  className="input-base text-xs w-full"
                >
                  <option value="draft">草稿</option>
                  <option value="active">已激活</option>
                  <option value="paused">已暂停</option>
                  <option value="archived">已归档</option>
                </select>
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>只有「已激活」状态才会响应 cron 和 webhook 触发</p>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>Cron 定时触发</label>
                <input
                  type="text"
                  value={cronSchedule}
                  onChange={(e) => setCronSchedule(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="input-base text-xs w-full"
                />
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>分钟 小时 日期 月份 星期，留空表示不启用</p>
              </div>

              <div className="pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Webhook 触发</label>
                  <button
                    onClick={() => setWebhookEnabled((v) => !v)}
                    className={`w-9 h-5 rounded-full relative transition-colors ${webhookEnabled ? 'bg-[var(--accent-cyan)]' : 'bg-[var(--bg-tertiary)]'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${webhookEnabled ? 'translate-x-4' : ''}`} />
                  </button>
                </div>
                {webhookEnabled && workflowId && (
                  <div className="p-2 rounded text-[10px] break-all" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                    {webhookUrl || '保存后生成 URL'}
                  </div>
                )}
                {webhookEnabled && !workflowId && (
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>保存工作流后生成 webhook URL</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
