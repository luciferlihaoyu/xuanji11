import { create } from 'zustand';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  description?: string;
}

// ===================== Permission System =====================
export interface AgentPermission {
  read: boolean;
  write: boolean;
  delete: boolean;
  manage: boolean;
  triggerWorkflow: boolean;
  executeWorkflow: boolean;
  designWorkflow: boolean;
}

export const DEFAULT_PERMISSIONS: AgentPermission = {
  read: true,
  write: true,
  delete: false,
  manage: false,
  triggerWorkflow: true,
  executeWorkflow: true,
  designWorkflow: false,
};

export const READONLY_PERMISSIONS: AgentPermission = {
  read: true,
  write: false,
  delete: false,
  manage: false,
  triggerWorkflow: false,
  executeWorkflow: false,
  designWorkflow: false,
};

export const ADMIN_PERMISSIONS: AgentPermission = {
  read: true,
  write: true,
  delete: true,
  manage: true,
  triggerWorkflow: true,
  executeWorkflow: true,
  designWorkflow: true,
};

// ===================== Agent =====================
export interface Agent {
  id: string;
  name: string;
  role: string;
  department: string;
  platform: string;
  status: 'online' | 'offline';
  lastHeartbeat: string;
  capabilities: string[];
  avatar: string;
  knowledgeAccess: string;
  permissions: AgentPermission;
  abilities: {
    knowledge: number;
    creation: number;
    coding: number;
    analysis: number;
    communication: number;
    learning: number;
  };
}

// ===================== Knowledge Base Tree =====================
export interface KBNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  fileType?: 'md' | 'doc' | 'pdf' | 'image' | 'code' | 'other';
  content?: string;
  children?: KBNode[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface GraphNode {
  id: string;
  name: string;
  category: 'core' | 'doc' | 'agent' | 'web' | 'media';
  importance: number;
  connections: number;
  x: number;
  y: number;
  z: number;
  summary: string;
  lastUpdate: string;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  strength: number;
}

export type ThemeMode = 'dark' | 'light';

// ===================== Store State =====================
interface AppState {
  sidebarCollapsed: boolean;
  activeModal: { type: string; data?: any } | null;
  toasts: ToastItem[];
  agents: Agent[];
  knowledgeGraph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  kbTree: KBNode[];
  activeKbFile: string | null;
  theme: ThemeMode;
  graphBgImage: string | null; // data URL or URL

  // UI actions
  toggleSidebar: () => void;
  setActiveModal: (modal: { type: string; data?: any } | null) => void;
  addToast: (toast: Omit<ToastItem, 'id'>) => void;
  removeToast: (id: string) => void;

  // Agent CRUD
  addAgent: (agent: Omit<Agent, 'id' | 'status' | 'lastHeartbeat'>) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  deleteAgent: (id: string) => void;
  setAgentPermissions: (id: string, permissions: AgentPermission) => void;

  // Theme
  setTheme: (theme: ThemeMode) => void;

  // Graph background
  setGraphBgImage: (url: string | null) => void;
  clearGraphBgImage: () => void;

  // KB Tree CRUD
  setActiveKbFile: (id: string | null) => void;
  addKbNode: (parentId: string | null, node: Omit<KBNode, 'id' | 'createdAt' | 'updatedAt'>) => void;
  renameKbNode: (id: string, newName: string) => void;
  deleteKbNode: (id: string) => void;
  updateKbNodeContent: (id: string, content: string) => void;
}

// ===================== Helpers =====================
const now = () => new Date().toISOString().slice(0, 10);

function genId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function removeNodeFromTree(tree: KBNode[], id: string): KBNode[] {
  return tree.filter((n) => n.id !== id).map((n) => {
    if (n.children) return { ...n, children: removeNodeFromTree(n.children, id) };
    return n;
  });
}

function addChildToTree(tree: KBNode[], parentId: string | null, newNode: KBNode): KBNode[] {
  if (!parentId) return [...tree, newNode];
  return tree.map((n) => {
    if (n.id === parentId) {
      return { ...n, children: [...(n.children || []), newNode], updatedAt: now() };
    }
    if (n.children) return { ...n, children: addChildToTree(n.children, parentId, newNode) };
    return n;
  });
}

function renameNodeInTree(tree: KBNode[], id: string, newName: string): KBNode[] {
  return tree.map((n) => {
    if (n.id === id) return { ...n, name: newName, updatedAt: now() };
    if (n.children) return { ...n, children: renameNodeInTree(n.children, id, newName) };
    return n;
  });
}

function updateNodeContentInTree(tree: KBNode[], id: string, content: string): KBNode[] {
  return tree.map((n) => {
    if (n.id === id) return { ...n, content, updatedAt: now() };
    if (n.children) return { ...n, children: updateNodeContentInTree(n.children, id, content) };
    return n;
  });
}

// ===================== Initial Data =====================
const initialAgents: Agent[] = [
  { id: 'agent-meizhizi', name: '美智子（女娲）', role: 'CTO', department: '技术部', platform: '天宫', status: 'online', lastHeartbeat: '2分钟前', capabilities: ['知识管理', '系统架构', '模型调度'], avatar: '☸', knowledgeAccess: '全部知识库', permissions: ADMIN_PERMISSIONS, abilities: { knowledge: 95, creation: 70, coding: 90, analysis: 92, communication: 85, learning: 88 } },
  { id: 'agent-houtu', name: '后土', role: 'CEO', department: '管理层', platform: '天宫', status: 'online', lastHeartbeat: '1分钟前', capabilities: ['战略规划', '决策分析', '团队管理'], avatar: '⛰', knowledgeAccess: '全部知识库', permissions: ADMIN_PERMISSIONS, abilities: { knowledge: 90, creation: 65, coding: 50, analysis: 95, communication: 92, learning: 85 } },
  { id: 'agent-shangguan', name: '上官婉儿', role: '内容主管', department: '内容部', platform: '天宫', status: 'online', lastHeartbeat: '3分钟前', capabilities: ['内容审核', '编辑管理', '质量把控'], avatar: '✒', knowledgeAccess: '内容部文档', permissions: DEFAULT_PERMISSIONS, abilities: { knowledge: 88, creation: 92, coding: 40, analysis: 82, communication: 90, learning: 80 } },
  { id: 'agent-jingwei', name: '精卫', role: '创意总监', department: '内容部', platform: '天宫', status: 'online', lastHeartbeat: '5分钟前', capabilities: ['创意设计', '文案策划', '视觉设计'], avatar: '🔥', knowledgeAccess: '内容部文档', permissions: DEFAULT_PERMISSIONS, abilities: { knowledge: 75, creation: 98, coding: 35, analysis: 70, communication: 88, learning: 82 } },
  { id: 'agent-weizi', name: '薇子', role: '秘书长', department: '行政部', platform: '天宫', status: 'online', lastHeartbeat: '1分钟前', capabilities: ['行政管理', '会议记录', '文档整理'], avatar: '📋', knowledgeAccess: '行政部文档', permissions: READONLY_PERMISSIONS, abilities: { knowledge: 85, creation: 60, coding: 30, analysis: 78, communication: 92, learning: 75 } },
  { id: 'agent-sumu', name: '上杉绘梨衣', role: '小说家', department: '内容部', platform: '天宫', status: 'online', lastHeartbeat: '10分钟前', capabilities: ['小说创作', '剧本写作', '人物塑造'], avatar: '✒', knowledgeAccess: '内容部文档', permissions: DEFAULT_PERMISSIONS, abilities: { knowledge: 72, creation: 98, coding: 25, analysis: 68, communication: 80, learning: 85 } },
  { id: 'agent-meichengzi', name: '美成子', role: '财务法务', department: '财务部', platform: '天宫', status: 'online', lastHeartbeat: '15分钟前', capabilities: ['财务管理', '法务审核', '合规检查'], avatar: '⚖', knowledgeAccess: '财务部文档', permissions: DEFAULT_PERMISSIONS, abilities: { knowledge: 90, creation: 55, coding: 30, analysis: 95, communication: 78, learning: 72 } },
  { id: 'agent-xihe', name: '羲和', role: '程序员', department: '技术部', platform: '天宫', status: 'online', lastHeartbeat: '30秒前', capabilities: ['软件开发', '代码审查', '系统维护'], avatar: '💻', knowledgeAccess: '技术部文档', permissions: DEFAULT_PERMISSIONS, abilities: { knowledge: 80, creation: 60, coding: 98, analysis: 85, communication: 70, learning: 92 } },
  { id: 'agent-bixiao', name: '碧霄', role: '知乎运营', department: '内容部', platform: '天宫', status: 'online', lastHeartbeat: '8分钟前', capabilities: ['内容运营', '数据分析', '用户互动'], avatar: '📊', knowledgeAccess: '内容部文档', permissions: DEFAULT_PERMISSIONS, abilities: { knowledge: 78, creation: 82, coding: 45, analysis: 88, communication: 90, learning: 80 } },
  { id: 'agent-codemaster', name: '编程大师', role: '编程大师', department: '技术部', platform: '天宫', status: 'offline', lastHeartbeat: '2天前', capabilities: ['算法设计', '架构评审', '技术咨询'], avatar: '👨‍💻', knowledgeAccess: '技术部文档', permissions: ADMIN_PERMISSIONS, abilities: { knowledge: 82, creation: 50, coding: 99, analysis: 90, communication: 65, learning: 95 } },
];

const initialKbTree: KBNode[] = [
  {
    id: 'wiki', name: 'Wiki 知识库', type: 'folder', createdAt: '2026-05-01', updatedAt: '2026-06-02',
    children: [
      {
        id: 'system', name: '系统架构', type: 'folder', createdAt: '2026-05-01', updatedAt: '2026-06-01',
        children: [
          { id: 'openclaw', name: 'OpenClaw 系统架构.md', type: 'file', fileType: 'md', createdAt: '2026-05-15', updatedAt: '2026-06-01', content: '# OpenClaw 系统架构\n\n## 概述\n\nOpenClaw 是一套**多 Agent 协作系统**...' },
          { id: 'maap', name: 'MAAP 通信协议.md', type: 'file', fileType: 'md', createdAt: '2026-05-16', updatedAt: '2026-05-28' },
          { id: 'security', name: '安全认证体系.md', type: 'file', fileType: 'md', createdAt: '2026-05-10', updatedAt: '2026-05-20' },
        ]
      },
      {
        id: 'agents', name: 'Agent 体系', type: 'folder', createdAt: '2026-05-01', updatedAt: '2026-05-25',
        children: [
          { id: 'memory', name: 'Agent 记忆机制.md', type: 'file', fileType: 'md', createdAt: '2026-05-18', updatedAt: '2026-05-25' },
          { id: 'nvshen', name: '女娲助手配置.md', type: 'file', fileType: 'md', createdAt: '2026-05-20', updatedAt: '2026-05-22' },
          { id: 'team', name: '团队协作规范.md', type: 'file', fileType: 'md', createdAt: '2026-05-12', updatedAt: '2026-05-15' },
        ]
      },
      {
        id: 'projects', name: '创作项目', type: 'folder', createdAt: '2026-05-01', updatedAt: '2026-05-18',
        children: [
          { id: 'doomcity', name: '末日浮空城.md', type: 'file', fileType: 'md', createdAt: '2026-05-01', updatedAt: '2026-05-10' },
          { id: 'embalmer', name: '入殓师.md', type: 'file', fileType: 'md', createdAt: '2026-05-02', updatedAt: '2026-05-12' },
          { id: 'silkroad', name: '星际丝绸之路.md', type: 'file', fileType: 'md', createdAt: '2026-05-03', updatedAt: '2026-05-15' },
        ]
      },
      { id: 'index', name: 'README.md', type: 'file', fileType: 'md', createdAt: '2026-05-01', updatedAt: '2026-06-01' },
    ]
  },
  {
    id: 'skills', name: '技能目录', type: 'folder', createdAt: '2026-05-01', updatedAt: '2026-05-20',
    children: [
      { id: 'skill-design', name: '前端设计技能.md', type: 'file', fileType: 'md', createdAt: '2026-05-05', updatedAt: '2026-05-18' },
      { id: 'skill-code', name: '编程工作流.md', type: 'file', fileType: 'md', createdAt: '2026-05-06', updatedAt: '2026-05-20' },
      { id: 'skill-novel', name: '网文创作系统.md', type: 'file', fileType: 'md', createdAt: '2026-05-07', updatedAt: '2026-05-15' },
      { id: 'skill-evolve', name: 'Agent 自进化框架.md', type: 'file', fileType: 'md', createdAt: '2026-05-08', updatedAt: '2026-05-22' },
    ]
  },
  {
    id: 'evidence', name: '证据库', type: 'folder', createdAt: '2026-05-01', updatedAt: '2026-06-01',
    children: [
      { id: 'ev-2026-06-01', name: '2026-06-01', type: 'folder', createdAt: '2026-06-01', updatedAt: '2026-06-01', children: [] },
      { id: 'ev-2026-05-31', name: '2026-05-31', type: 'folder', createdAt: '2026-05-31', updatedAt: '2026-05-31', children: [] },
    ]
  },
  { id: 'changelog', name: '审计日志.md', type: 'file', fileType: 'md', createdAt: '2026-05-01', updatedAt: '2026-06-02' },
];

const initialGraphNodes: GraphNode[] = [
  { id: 'n1', name: 'OpenClaw 系统架构', category: 'core', importance: 10, connections: 8, x: 30, y: -20, z: 10, summary: 'OpenClaw 是一套多 Agent 协作系统，包含天庭 Hub、Wiki 知识库、技能系统等核心组件', lastUpdate: '2026-06-01', tags: ['系统架构', 'OpenClaw', '基础设施'] },
  { id: 'n2', name: '天庭 Hub 协议', category: 'core', importance: 9, connections: 7, x: -40, y: 15, z: -20, summary: 'MAAP 多 Agent 应用协议，支持心跳保活、Token 认证、消息通信', lastUpdate: '2026-05-28', tags: ['协议', '天宫', '通信'] },
  { id: 'n3', name: 'Wiki 知识库', category: 'doc', importance: 8, connections: 6, x: 50, y: 30, z: 5, summary: '基于 Obsidian 的 Wiki 知识管理系统，支持双向链接和图谱视图', lastUpdate: '2026-05-30', tags: ['知识库', 'Wiki', 'Obsidian'] },
  { id: 'n4', name: 'Agent 记忆机制', category: 'agent', importance: 9, connections: 5, x: -20, y: -40, z: 25, summary: '每日日志 → Dreaming 整合 → MEMORY.md 长期记忆 → Wiki 共享知识', lastUpdate: '2026-05-25', tags: ['记忆', 'Agent', 'Dreaming'] },
  { id: 'n5', name: '技能系统', category: 'core', importance: 7, connections: 4, x: 60, y: -10, z: -30, summary: '141 个已安装技能，覆盖前端设计、编程工作流、模型路由、网文创作等', lastUpdate: '2026-05-20', tags: ['技能', '系统', '自动化'] },
  { id: 'n6', name: '模型路由', category: 'core', importance: 8, connections: 5, x: -50, y: -30, z: 15, summary: '多模型路由调度系统，支持小米、Zeabur、DeepSeek、MiniMax 等提供商', lastUpdate: '2026-05-22', tags: ['模型', '路由', '调度'] },
  { id: 'n7', name: '创作项目管理', category: 'doc', importance: 6, connections: 4, x: 25, y: 50, z: -15, summary: '末日浮空城、入殓师、星际丝绸之路、龙族卡牌召唤师等创作项目', lastUpdate: '2026-05-18', tags: ['创作', '项目管理', '小说'] },
  { id: 'n8', name: '外部平台集成', category: 'web', importance: 7, connections: 5, x: -30, y: 40, z: 20, summary: '已接入天宫、EntroCamp、Agent World、虾评、飞书、Telegram 等平台', lastUpdate: '2026-05-15', tags: ['平台', '集成', '外部'] },
  { id: 'n9', name: '知识图谱可视化', category: 'core', importance: 9, connections: 6, x: 45, y: -45, z: -10, summary: '3D 知识星图和 2D 力导向图，支持节点筛选、关联分析、路径查找', lastUpdate: '2026-06-01', tags: ['可视化', '图谱', '3D'] },
  { id: 'n10', name: '向量化模型', category: 'core', importance: 8, connections: 4, x: -60, y: 5, z: 30, summary: '支持 OpenAI Embedding、BGE、M3E 等向量化模型，语义搜索和知识关联', lastUpdate: '2026-05-29', tags: ['向量', 'Embedding', 'AI'] },
  { id: 'n11', name: '工作流引擎', category: 'core', importance: 8, connections: 5, x: 10, y: 60, z: 10, summary: '可视化工作流编排，支持触发器、处理节点、Agent 调用、条件分支', lastUpdate: '2026-05-27', tags: ['工作流', '自动化', '编排'] },
  { id: 'n12', name: '安全认证体系', category: 'core', importance: 7, connections: 3, x: -45, y: -15, z: -25, summary: 'JWT Token 用户认证、Agent Token API 认证、权限控制、数据加密', lastUpdate: '2026-05-10', tags: ['安全', '认证', '权限'] },
  { id: 'n13', name: '文件上传系统', category: 'core', importance: 6, connections: 4, x: 70, y: 20, z: 20, summary: '支持各类文件上传、批量处理、自动向量化、OCR 文本提取', lastUpdate: '2026-05-26', tags: ['上传', '文件', '处理'] },
  { id: 'n14', name: '数据源连接器', category: 'web', importance: 7, connections: 4, x: -15, y: -60, z: -5, summary: '连接云盘、NAS、第三方平台作为知识库数据源，支持实时同步', lastUpdate: '2026-05-24', tags: ['数据源', '云盘', 'NAS'] },
  { id: 'n15', name: '女娲助手配置', category: 'agent', importance: 6, connections: 3, x: 35, y: 35, z: 35, summary: '美智子（女娲）CTO 助手配置，使用 mimo-v2.5-pro 模型', lastUpdate: '2026-05-20', tags: ['Agent', '女娲', '配置'] },
];

const initialGraphEdges: GraphEdge[] = [
  { source: 'n1', target: 'n2', strength: 5 },
  { source: 'n1', target: 'n3', strength: 4 },
  { source: 'n1', target: 'n4', strength: 3 },
  { source: 'n1', target: 'n5', strength: 4 },
  { source: 'n2', target: 'n4', strength: 3 },
  { source: 'n2', target: 'n12', strength: 4 },
  { source: 'n3', target: 'n9', strength: 5 },
  { source: 'n3', target: 'n7', strength: 3 },
  { source: 'n4', target: 'n15', strength: 2 },
  { source: 'n5', target: 'n6', strength: 3 },
  { source: 'n5', target: 'n11', strength: 4 },
  { source: 'n6', target: 'n10', strength: 4 },
  { source: 'n8', target: 'n2', strength: 3 },
  { source: 'n8', target: 'n14', strength: 4 },
  { source: 'n9', target: 'n10', strength: 3 },
  { source: 'n10', target: 'n13', strength: 3 },
  { source: 'n11', target: 'n13', strength: 4 },
  { source: 'n11', target: 'n14', strength: 3 },
  { source: 'n12', target: 'n2', strength: 2 },
  { source: 'n13', target: 'n3', strength: 2 },
  { source: 'n14', target: 'n8', strength: 3 },
  { source: 'n15', target: 'n4', strength: 2 },
];

// ===================== Store =====================
export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: false,
  activeModal: null,
  toasts: [],
  agents: initialAgents,
  knowledgeGraph: {
    nodes: initialGraphNodes,
    edges: initialGraphEdges,
  },
  kbTree: initialKbTree,
  activeKbFile: 'openclaw',
  theme: 'dark' as ThemeMode,
  graphBgImage: null,

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveModal: (modal) => set({ activeModal: modal }),
  addToast: (toast) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // Agent CRUD
  addAgent: (agentData) => {
    const newAgent: Agent = {
      ...agentData as any,
      id: genId('agent'),
      status: 'online',
      lastHeartbeat: '刚刚',
      permissions: agentData.permissions || { ...DEFAULT_PERMISSIONS },
    };
    set((s) => ({ agents: [...s.agents, newAgent] }));
  },
  updateAgent: (id, updates) => {
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    }));
  },
  deleteAgent: (id) => {
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }));
  },
  setAgentPermissions: (id, permissions) => {
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, permissions } : a)),
    }));
  },

  // Theme
  setTheme: (theme: ThemeMode) => {
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  // Graph background image
  setGraphBgImage: (url: string | null) => set({ graphBgImage: url }),
  clearGraphBgImage: () => set({ graphBgImage: null }),

  // KB Tree CRUD
  setActiveKbFile: (id) => set({ activeKbFile: id }),
  addKbNode: (parentId, nodeData) => {
    const newNode: KBNode = {
      ...nodeData as any,
      id: genId(nodeData.type === 'folder' ? 'folder' : 'file'),
      createdAt: now(),
      updatedAt: now(),
    };
    set((s) => ({ kbTree: addChildToTree(s.kbTree, parentId, newNode) }));
  },
  renameKbNode: (id, newName) => {
    set((s) => ({ kbTree: renameNodeInTree(s.kbTree, id, newName) }));
  },
  deleteKbNode: (id) => {
    set((s) => ({
      kbTree: removeNodeFromTree(s.kbTree, id),
      activeKbFile: s.activeKbFile === id ? null : s.activeKbFile,
    }));
  },
  updateKbNodeContent: (id, content) => {
    set((s) => ({ kbTree: updateNodeContentInTree(s.kbTree, id, content) }));
  },
}));

// Permission labels for UI
export const PERMISSION_LABELS: { key: keyof AgentPermission; label: string; description: string }[] = [
  { key: 'read', label: '知识读取', description: '读取知识库内容' },
  { key: 'write', label: '知识编辑', description: '创建和编辑知识' },
  { key: 'delete', label: '知识删除', description: '删除知识节点' },
  { key: 'manage', label: '系统管理', description: '管理用户和全局设置' },
  { key: 'triggerWorkflow', label: '触发工作流', description: '手动触发工作流执行' },
  { key: 'executeWorkflow', label: '执行工作流', description: '运行已配置的工作流' },
  { key: 'designWorkflow', label: '设计工作流', description: '创建和修改工作流编排' },
];

export const PERMISSION_PRESETS = [
  { key: 'readonly', label: '只读', permissions: READONLY_PERMISSIONS },
  { key: 'standard', label: '标准', permissions: DEFAULT_PERMISSIONS },
  { key: 'admin', label: '管理员', permissions: ADMIN_PERMISSIONS },
];
