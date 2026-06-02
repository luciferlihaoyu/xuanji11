export interface FileTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  fileType?: 'md' | 'doc' | 'pdf' | 'image' | 'code' | 'other';
  children?: FileTreeNode[];
  isOpen?: boolean;
}

export interface WorkflowNode {
  id: string;
  type: string;
  category: 'trigger' | 'processing' | 'connection' | 'agent' | 'output' | 'logic';
  position: { x: number; y: number };
  config: Record<string, any>;
  label: string;
  description?: string;
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
}

export interface DataSource {
  id: string;
  name: string;
  type: 'cloud' | 'nas' | 'platform' | 'local';
  platform: string;
  status: 'connected' | 'syncing' | 'disconnected';
  lastSync: string;
  syncMode: string;
  totalFiles: number;
  syncedFiles: number;
  path: string;
}

export interface UploadTask {
  id: string;
  fileName: string;
  fileSize: string;
  fileType: string;
  progress: number;
  status: 'queued' | 'uploading' | 'processing' | 'completed' | 'failed';
}

export interface APIEndpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  description: string;
  category: string;
  auth: boolean;
}

export interface ActivityLog {
  id: string;
  agentId: string;
  agentName: string;
  agentAvatar: string;
  action: string;
  target: string;
  timestamp: string;
  type: 'create' | 'edit' | 'link' | 'delete' | 'system';
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  type: 'knowledge' | 'file' | 'agent';
  metadata: Record<string, string>;
  relevance: number;
}
