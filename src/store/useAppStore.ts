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
export type AgentStatus = 'active' | 'inactive' | 'error' | 'training';
export type AgentType = 'assistant' | 'analyst' | 'curator' | 'connector' | 'custom';

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  role: string;
  department: string;
  platform: string;
  status: AgentStatus;
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
// Removed hardcoded demo data. Backend tRPC hooks (useAgents, useKb, useKnowledge)
// now serve as the primary data source. Arrays start empty, populated at runtime.

const initialAgents: Agent[] = [];
const initialKbTree: KBNode[] = [];
const initialGraphNodes: GraphNode[] = [];
const initialGraphEdges: GraphEdge[] = [];

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
  activeKbFile: null,
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
      type: agentData.type || 'custom',
      status: 'active',
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
