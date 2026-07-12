import { HashRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense, useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import AppLayout from '@/components/AppLayout';
import CommandPalette from '@/components/CommandPalette';
import AuthGuard from '@/components/AuthGuard';
import PageLoader from '@/components/PageLoader';

// Page components are lazy-loaded to produce separate Vite chunks
// and reduce the initial bundle. Shell components (AuthGuard, AppLayout,
// CommandPalette, ErrorBoundary) stay eager for instant shell render.
const KnowledgeGraph = lazy(() => import('@/pages/KnowledgeGraph'));
const KnowledgeBase = lazy(() => import('@/pages/KnowledgeBase'));
const WorkflowBuilder = lazy(() => import('@/pages/WorkflowBuilder'));
const BackupPage = lazy(() => import('@/pages/BackupPage'));
const IngestionPage = lazy(() => import('@/pages/IngestionPage'));
const AgentManagement = lazy(() => import('@/pages/AgentManagement'));
const APICenter = lazy(() => import('@/pages/APICenter'));
const DataSources = lazy(() => import('@/pages/DataSources'));
const UploadPage = lazy(() => import('@/pages/UploadPage'));
const SearchResults = lazy(() => import('@/pages/SearchResults'));
const DocumentDetail = lazy(() => import('@/pages/DocumentDetail'));
const Settings = lazy(() => import('@/pages/Settings'));
const Login = lazy(() => import('@/pages/Login'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const AnalysisDashboard = lazy(() => import('@/pages/AnalysisDashboard'));
const AuditLog = lazy(() => import('@/pages/AuditLog'));

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
      <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<AuthGuard />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<KnowledgeGraph />} />
          <Route path="/kb" element={<KnowledgeBase />} />
          <Route path="/kb/:path" element={<KnowledgeBase />} />
          <Route path="/workflows" element={<WorkflowBuilder />} />
          <Route path="/workflows/:id" element={<WorkflowBuilder />} />
          <Route path="/backups" element={<BackupPage />} />
          <Route path="/ingestion" element={<IngestionPage />} />
          <Route path="/agents" element={<AgentManagement />} />
          <Route path="/api" element={<APICenter />} />
          <Route path="/sources" element={<DataSources />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/search" element={<SearchResults />} />
          <Route path="/analytics" element={<AnalysisDashboard />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/doc/:id" element={<DocumentDetail />} />
          <Route path="/settings/:category" element={<Settings />} />
        </Route>
        </Route>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
    </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
