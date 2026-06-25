import { HashRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import AppLayout from '@/components/AppLayout';
import CommandPalette from '@/components/CommandPalette';
import KnowledgeGraph from '@/pages/KnowledgeGraph';
import KnowledgeBase from '@/pages/KnowledgeBase';
import WorkflowBuilder from '@/pages/WorkflowBuilder';
import AgentManagement from '@/pages/AgentManagement';
import APICenter from '@/pages/APICenter';
import DataSources from '@/pages/DataSources';
import UploadPage from '@/pages/UploadPage';
import SearchResults from '@/pages/SearchResults';
import DocumentDetail from '@/pages/DocumentDetail';
import Settings from '@/pages/Settings';
import Login from "./pages/Login"
import NotFound from "./pages/NotFound"

function ThemeInit() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return null;
}

function App() {
  return (
    <ErrorBoundary>
    <HashRouter>
      <ThemeInit />
      <CommandPalette />
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<KnowledgeGraph />} />
          <Route path="/kb" element={<KnowledgeBase />} />
          <Route path="/kb/:path" element={<KnowledgeBase />} />
          <Route path="/workflows" element={<WorkflowBuilder />} />
          <Route path="/workflows/:id" element={<WorkflowBuilder />} />
          <Route path="/agents" element={<AgentManagement />} />
          <Route path="/api" element={<APICenter />} />
          <Route path="/sources" element={<DataSources />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/search" element={<SearchResults />} />
          <Route path="/doc/:id" element={<DocumentDetail />} />
          <Route path="/settings/:category" element={<Settings />} />
        </Route>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
