import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TRPCProvider } from '@/providers/trpc'

// 部署换新后，浏览器缓存的旧 index.html 会引用已删除的旧 chunk → 懒加载白屏。
// Vite 动态导入失败时派发 vite:preloadError，捕获后硬刷一次拿新 HTML 自愈。
window.addEventListener('vite:preloadError', () => {
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TRPCProvider>
      <App />
    </TRPCProvider>
  </StrictMode>,
)
