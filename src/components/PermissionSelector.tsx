import { Eye, Pencil, Trash2, Settings, Zap, Play, Workflow, type LucideIcon } from 'lucide-react';
import type { AgentPermission } from '@/store/useAppStore';
import { PERMISSION_LABELS, PERMISSION_PRESETS } from '@/store/useAppStore';

const PERMISSION_ICONS: Record<string, LucideIcon> = {
  read: Eye,
  write: Pencil,
  delete: Trash2,
  manage: Settings,
  triggerWorkflow: Zap,
  executeWorkflow: Play,
  designWorkflow: Workflow,
};

interface PermissionSelectorProps {
  permissions: AgentPermission;
  onChange: (permissions: AgentPermission) => void;
  showPresets?: boolean;
}

export default function PermissionSelector({ permissions, onChange, showPresets = true }: PermissionSelectorProps) {
  const toggle = (key: keyof AgentPermission) => {
    onChange({ ...permissions, [key]: !permissions[key] });
  };

  const applyPreset = (presetKey: string) => {
    const preset = PERMISSION_PRESETS.find((p) => p.key === presetKey);
    if (preset) onChange({ ...preset.permissions });
  };

  return (
    <div className="space-y-4">
      {/* Presets */}
      {showPresets && (
        <div>
          <label className="text-[11px] font-medium block mb-2" style={{ color: 'var(--text-muted)' }}>
            权限预设
          </label>
          <div className="flex gap-2 mb-4">
            {PERMISSION_PRESETS.map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.key)}
                className="chip text-xs py-1 px-3 transition-all"
                style={{
                  opacity: Object.entries(preset.permissions).every(
                    ([k, v]) => permissions[k as keyof AgentPermission] === v
                  ) ? 1 : 0.5,
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Permission list */}
      <div className="space-y-2">
        {PERMISSION_LABELS.map((perm) => {
          const Icon = PERMISSION_ICONS[perm.key];
          const isOn = permissions[perm.key];
          return (
            <div
              key={perm.key}
              className="flex items-center justify-between py-2 px-3 rounded-md transition-colors"
              style={{ backgroundColor: isOn ? 'rgba(34,211,238,0.05)' : 'transparent' }}
            >
              <div className="flex items-center gap-3">
                <Icon
                  className="w-4 h-4"
                  style={{ color: isOn ? 'var(--accent-cyan)' : 'var(--text-muted)' }}
                />
                <div>
                  <div className="text-sm" style={{ color: isOn ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {perm.label}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {perm.description}
                  </div>
                </div>
              </div>
              <button
                onClick={() => toggle(perm.key)}
                className="relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0"
                style={{ backgroundColor: isOn ? 'var(--accent-cyan)' : 'var(--bg-tertiary)' }}
              >
                <div
                  className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"
                  style={{ transform: isOn ? 'translateX(18px)' : 'translateX(2px)' }}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
