import { useEffect, useRef } from 'react';
import { Image, X } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useSettings, useSettingValue } from '@/hooks/useSettings';

export default function BgImageUpload() {
  const { graphBgImage, graphBgScale, setGraphBgImage, setGraphBgScale, clearGraphBgImage, addToast } = useAppStore();
  const { setSetting, isSetting } = useSettings();
  const { data: savedBg } = useSettingValue('ui_background_image');
  const { data: savedScale } = useSettingValue('ui_background_image_scale');
  const inputRef = useRef<HTMLInputElement>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    if (!restoredRef.current && savedBg?.value && !graphBgImage) {
      setGraphBgImage(savedBg.value);
      restoredRef.current = true;
    }
  }, [savedBg?.value, graphBgImage, setGraphBgImage]);

  useEffect(() => {
    const v = Number(savedScale?.value);
    if (v > 0 && v !== graphBgScale) setGraphBgScale(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedScale?.value]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      addToast({ type: 'error', title: '请选择图片文件' });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      addToast({ type: 'error', title: '图片大小不能超过 5MB' });
      return;
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      setGraphBgImage(dataUrl);
      try {
        await setSetting('ui_background_image', dataUrl, 'ui');
        addToast({ type: 'success', title: '背景图已更新并保存' });
      } catch (err) {
        addToast({
          type: 'error',
          title: '背景图保存失败',
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-2">
      <label className="text-[11px] font-medium block" style={{ color: 'var(--text-muted)' }}>
        脑图背景
      </label>
      {graphBgImage ? (
        <div className="space-y-2">
          <div className="relative rounded-md overflow-hidden border" style={{ borderColor: 'var(--border-subtle)' }}>
            <img src={graphBgImage} alt="背景预览" className="w-full h-20 object-cover" />
            {/* 删除按钮常驻显示（不只悬停可见） */}
            <button
              onClick={async () => {
                clearGraphBgImage();
                try {
                  await setSetting('ui_background_image', '', 'ui');
                  addToast({ type: 'info', title: '背景图已删除' });
                } catch (err) {
                  addToast({
                    type: 'error',
                    title: '背景图删除保存失败',
                    description: err instanceof Error ? err.message : String(err),
                  });
                }
              }}
              disabled={isSetting}
              title="删除背景图"
              className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/70 hover:bg-red-500/90 transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5 text-white" />
            </button>
            <div className="absolute bottom-1 left-2 text-[10px]" style={{ color: 'rgba(255,255,255,0.8)' }}>
              已应用自定义背景
            </div>
          </div>
          {/* 缩放比例 */}
          <div>
            <div className="flex justify-between text-[10px] mb-1 font-mono" style={{ color: 'var(--text-muted)' }}>
              <span>背景缩放</span><span>{graphBgScale}%</span>
            </div>
            <input
              type="range"
              min={20}
              max={200}
              step={5}
              value={graphBgScale}
              onChange={(e) => setGraphBgScale(Number(e.target.value))}
              onMouseUp={() => setSetting('ui_background_image_scale', String(graphBgScale), 'ui').catch(() => {})}
              onTouchEnd={() => setSetting('ui_background_image_scale', String(graphBgScale), 'ui').catch(() => {})}
              className="w-full h-1 rounded-full appearance-none cursor-pointer"
              style={{ backgroundColor: 'var(--bg-tertiary)', accentColor: 'var(--accent-cyan)' }}
            />
          </div>
        </div>
      ) : (
        <button
          onClick={() => inputRef.current?.click()}
          className="w-full h-20 rounded-md border border-dashed flex flex-col items-center justify-center gap-1 transition-all hover:border-[var(--accent-cyan)] hover:bg-[var(--accent-cyan-dim)]"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <Image className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>上传背景图片</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
      <p className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
        支持 JPG / PNG / GIF，最大 5MB
      </p>
    </div>
  );
}
