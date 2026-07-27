export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    // Prefer WebGL2; fall back to WebGL1
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    if (!gl) return false;

    // Probe framebuffer completeness to catch headless / GPU-blocklisted contexts
    // that return a valid context object but silently fail on any GPU operation.
    // If the probe throws or fails for any reason, fall back to the basic
    // instanceof check — a false negative is worse than a false positive here
    // because the 3D scene has its own timeout + ErrorBoundary safety net.
    try {
      const fb = gl.createFramebuffer();
      if (!fb) throw new Error('No framebuffer');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const tex = gl.createTexture();
      if (!tex) throw new Error('No texture');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fb);

      if (status === gl.FRAMEBUFFER_COMPLETE) return true;
    } catch {
      // Framebuffer probe failed — not necessarily a real problem.
      // Fall through to the basic instanceof check below.
    }

    // Basic fallback: if the context is an actual WebGL instance, trust it.
    // The 3D scene's Suspense timeout + ErrorBoundary will catch true
    // rendering failures at runtime.
    return typeof WebGLRenderingContext !== 'undefined' && gl instanceof WebGLRenderingContext;
  } catch {
    return false;
  }
}

export function shouldUse2DByDefault(): boolean {
  if (typeof window === 'undefined') return false;
  const isMobile = window.innerWidth < 768;
  const lowConcurrency = navigator.hardwareConcurrency < 4;
  return isMobile || lowConcurrency;
}

function isCameraTuple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number')
  );
}

export function parseGraphHash(): { camera?: [number, number, number]; selectedNodeId?: string } {
  if (typeof window === 'undefined') return {};
  const hash = window.location.hash;
  const match = hash.match(/graph=([^\u0026]+)/);
  if (!match) return {};

  try {
    const payload: Record<string, unknown> = JSON.parse(decodeURIComponent(match[1]));
    const camera = isCameraTuple(payload.camera) ? payload.camera : undefined;
    const selectedNodeId = typeof payload.selectedNodeId === 'string' ? payload.selectedNodeId : undefined;
    return { camera, selectedNodeId };
  } catch {
    return {};
  }
}

export function updateGraphHash(camera: [number, number, number], selectedNodeId: string | null): void {
  if (typeof window === 'undefined') return;
  const payload: { camera: [number, number, number]; selectedNodeId?: string } = {
    camera,
  };
  if (selectedNodeId) payload.selectedNodeId = selectedNodeId;

  const encoded = encodeURIComponent(JSON.stringify(payload));
  const hash = window.location.hash;
  const base = hash.replace(/graph=[^\u0026]+/, '');
  const separator = base.includes('?') ? '&' : '?';
  const newHash = base ? `${base}${separator}graph=${encoded}` : `#/graph?graph=${encoded}`;
  window.history.replaceState(null, '', newHash);
}
