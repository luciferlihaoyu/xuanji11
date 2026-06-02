import { useAppStore } from '@/store/useAppStore';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

const iconMap = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const colorMap = {
  success: 'var(--accent-emerald)',
  error: 'var(--accent-rose)',
  warning: 'var(--accent-amber)',
  info: 'var(--accent-cyan)',
};

export default function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-16 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = iconMap[toast.type];
        const color = colorMap[toast.type];
        return (
          <div
            key={toast.id}
            className="flex items-start gap-3 min-w-[280px] max-w-[400px] p-3 rounded-md border animate-slide-up"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color }} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {toast.title}
              </div>
              {toast.description && (
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {toast.description}
                </div>
              )}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="p-0.5 rounded hover:opacity-70 transition-opacity"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
