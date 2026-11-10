import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MobileDrawerProps {
  /** 是否展开（仅移动端 <768px 生效，桌面端直接不渲染） */
  open: boolean;
  onClose: () => void;
  /** 从左 / 右滑入，默认 left */
  side?: 'left' | 'right';
  /** 抽屉标题，省略则不显示标题栏（无标题时仍保留右上关闭按钮） */
  title?: ReactNode;
  /** 宽度类，默认 w-[86vw] max-w-[340px] */
  widthClass?: string;
  /** 底部固定区（如保存按钮） */
  footer?: ReactNode;
  children: ReactNode;
  /** 无障碍名称，无 title 时建议传 */
  ariaLabel?: string;
}

/**
 * 移动端标准抽屉（口径见 docs/mobile-adaptation.md 第 4 条）。
 * - 遮罩点击关闭、Esc 关闭、打开时锁 body 滚动
 * - 只在移动端出现：md 及以上不渲染，桌面侧栏另用常驻布局
 * - 顶部让开 48px 固定顶栏
 */
export default function MobileDrawer({
  open,
  onClose,
  side = 'left',
  title,
  widthClass = 'w-[86vw] max-w-[340px]',
  footer,
  children,
  ariaLabel,
}: MobileDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] md:hidden" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      {/* 遮罩 */}
      <div
        className="absolute inset-0 top-12 bg-black/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 面板 */}
      <aside
        className={cn(
          'absolute top-12 bottom-0 flex flex-col shadow-2xl',
          side === 'left' ? 'left-0 animate-slide-in-left' : 'right-0 animate-slide-in-right',
          widthClass,
        )}
        style={{
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          borderRight: side === 'left' ? '1px solid var(--border-subtle)' : undefined,
          borderLeft: side === 'right' ? '1px solid var(--border-subtle)' : undefined,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="tap-target rounded hover:bg-white/5 shrink-0"
            style={{ color: 'var(--text-muted)' }}
            aria-label="关闭面板"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>

        {footer && (
          <div
            className="shrink-0 px-3 py-2 border-t"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-secondary)' }}
          >
            {footer}
          </div>
        )}
      </aside>
    </div>
  );
}
