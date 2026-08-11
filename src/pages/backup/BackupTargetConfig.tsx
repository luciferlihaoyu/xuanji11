import { Loader2, RefreshCw, Save, Wifi, WifiOff } from 'lucide-react';

/** 云盘备份目标 key（115 / 阿里云盘） */
export type CloudDriveTargetKey = '115' | 'aliyundrive';

/** 需要连接配置的备份目标 key（云盘 + AList WebDAV） */
export type BackupConfigTargetKey = CloudDriveTargetKey | 'alist';

/** 备份目标连接配置表单字段 */
export interface TargetFields {
  accessToken: string;
  refreshToken: string;
  url: string;
  username: string;
  password: string;
}

export interface TargetConnectionStatus {
  testing: boolean;
  result?: { success: boolean; message: string };
}

interface BackupTargetConfigProps {
  target: BackupConfigTargetKey;
  fields: TargetFields;
  onFieldChange: (key: keyof TargetFields, value: string) => void;
  testing: boolean;
  saving: boolean;
  refreshing: boolean;
  testDisabled: boolean;
  saveDisabled: boolean;
  connectionStatus: TargetConnectionStatus;
  onTest: () => void;
  onSave: () => void;
  onRefresh: () => void;
}

/**
 * 备份目标的连接配置区（创建表单内联区块）。
 * - 云盘目标（115/aliyundrive）：Access Token / Refresh Token + 刷新、保存、测试
 * - AList (WebDAV)：url / username / password + 保存、测试
 */
export default function BackupTargetConfig({
  target,
  fields,
  onFieldChange,
  testing,
  saving,
  refreshing,
  testDisabled,
  saveDisabled,
  connectionStatus,
  onTest,
  onSave,
  onRefresh,
}: BackupTargetConfigProps) {
  const isAlist = target === 'alist';

  return (
    <div className="space-y-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      {isAlist ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
              URL <span style={{ color: 'var(--text-muted)' }}>(WebDAV 地址)</span>
            </label>
            <input
              type="text"
              value={fields.url}
              onChange={(e) => onFieldChange('url', e.target.value)}
              placeholder="https://alist.example.com/dav"
              className="input-base text-xs w-full"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>用户名</label>
            <input
              type="text"
              value={fields.username}
              onChange={(e) => onFieldChange('username', e.target.value)}
              placeholder="AList 账号"
              className="input-base text-xs w-full"
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>密码</label>
            <input
              type="password"
              value={fields.password}
              onChange={(e) => onFieldChange('password', e.target.value)}
              placeholder="AList 密码"
              className="input-base text-xs w-full"
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
              Access Token {target === '115' ? '(或 Refresh Token)' : ''}
            </label>
            <input
              type="password"
              value={fields.accessToken}
              onChange={(e) => onFieldChange('accessToken', e.target.value)}
              placeholder={target === '115' ? '115 OAuth accessToken' : '阿里云盘 accessToken'}
              className="input-base text-xs w-full"
              required={!fields.refreshToken}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-primary)' }}>
              Refresh Token <span style={{ color: 'var(--text-muted)' }}>(推荐，用于自动刷新)</span>
            </label>
            <input
              type="password"
              value={fields.refreshToken}
              onChange={(e) => onFieldChange('refreshToken', e.target.value)}
              placeholder="用于自动刷新 accessToken"
              className="input-base text-xs w-full"
            />
          </div>
        </div>
      )}

      {isAlist && (
        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          AList (WebDAV) 备份需先在服务端配置环境密钥 <code>BACKUP_ENCRYPTION_KEY</code>（备份内容加密存储），未配置时创建备份会被拒绝。
        </p>
      )}

      <div className="flex justify-end gap-2">
        {!isAlist && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || !fields.refreshToken}
            className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新 Token
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || saveDisabled}
          className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          保存配置
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={testing || testDisabled}
          className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
          测试连接
        </button>
      </div>

      {connectionStatus.result && (
        <div className={`flex items-center gap-1.5 text-[10px] ${connectionStatus.result.success ? 'text-emerald-400' : 'text-rose-400'}`}>
          {connectionStatus.result.success ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {connectionStatus.result.message}
        </div>
      )}
    </div>
  );
}
