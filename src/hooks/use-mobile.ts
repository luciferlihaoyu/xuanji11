import * as React from "react"

export const MOBILE_BREAKPOINT = 768

/**
 * 通用媒体查询 hook。首帧取真实值（matchMedia 可用时），effect 内订阅变化。
 * 例：useMediaQuery('(max-width: 639px)') → 窄手机
 *     useMediaQuery('(pointer: coarse)')   → 触屏设备
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}

/**
 * 是否移动端（< 768px）。仅用于必须走 JS 分支的场景（画布降载、抽屉互斥等）；
 * 纯布局优先用 Tailwind 响应式前缀 —— 见 docs/mobile-adaptation.md。
 */
export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}
