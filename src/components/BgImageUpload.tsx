import { useRef } from 'react';
import { Image, X } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

export default function BgImageUpload() {
  const { graphBgImage, setGraphBgImage, clearGraphBgImage, addToast } = useAppStore();
  const inputRef = useRef<HTMLInputElement>(null);

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
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setGraphBgImage(dataUrl);
      addToast({ type: 'success', title: '背景图已更新' });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-2">
      <label className="text-[11px] font-medium block" style={{ color: 'var(--text-muted)' }}>
        脑图背景
      </label>
      {graphBgImage ? (
        <div className="relative rounded-md overflow-hidden border" style={{ borderColor: 'var(--border-subtle)' }}>
          <img src={graphBgImage} alt="背景预览" className="w-full h-20 object-cover" />
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity">
            <button onClick={clearGraphBgImage} className="p-1.5 rounded-full bg-black/60 hover:bg-red-500/80 transition-colors">
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
          <div className="absolute bottom-1 left-2 text-[10px]" style={{ color: 'rgba(255,255,255,0.8)' }}>
            已应用自定义背景
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
