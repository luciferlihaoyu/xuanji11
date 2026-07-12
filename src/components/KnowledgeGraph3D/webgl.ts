export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    return gl instanceof WebGLRenderingContext || gl instanceof WebGL2RenderingContext;
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
