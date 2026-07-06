/**
 * PageLoader — sci-fi themed Suspense fallback.
 * Uses existing CSS variables (--accent-cyan, --bg-primary) and
 * the animate-rotate keyframe from index.css.
 */
export default function PageLoader() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: '1.25rem',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      {/* Energy ring spinner */}
      <div
        className="animate-rotate"
        style={{
          width: '3rem',
          height: '3rem',
          borderRadius: '50%',
          border: '3px solid var(--accent-cyan-dim)',
          borderTopColor: 'var(--accent-cyan)',
          boxShadow: '0 0 12px var(--accent-cyan-dim)',
        }}
      />
      <span
        style={{
          color: 'var(--accent-cyan)',
          fontSize: '0.875rem',
          letterSpacing: '0.15em',
          textShadow: '0 0 8px var(--accent-cyan-dim)',
        }}
      >
        加载中...
      </span>
    </div>
  );
}
