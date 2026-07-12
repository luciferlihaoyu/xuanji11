/* @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import KnowledgeGraph3D from './KnowledgeGraph3D';
import {
  isWebGLAvailable,
  shouldUse2DByDefault,
  parseGraphHash,
  updateGraphHash,
} from './KnowledgeGraph3D/webgl';

beforeAll(() => {
  if (typeof globalThis.WebGLRenderingContext === 'undefined') {
    class WebGLRenderingContext {}
    Object.assign(globalThis, { WebGLRenderingContext });
  }
});

describe('WebGL utilities', () => {
  it('reports WebGL unavailable when the canvas context is null', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(isWebGLAvailable()).toBe(false);
  });

  it('reports WebGL available when the canvas returns a WebGL context', () => {
    const mockContext = Object.create(WebGLRenderingContext.prototype) as WebGLRenderingContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type) =>
      type === 'webgl' ? mockContext : null
    );
    expect(isWebGLAvailable()).toBe(true);
  });

  it('defaults to 2D on low-end or mobile clients', () => {
    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
    expect(shouldUse2DByDefault()).toBe(true);
  });

  it('restores camera and selected node from URL hash', () => {
    window.location.hash = '#/graph?graph={"camera":[1,2,3],"selectedNodeId":"5"}';
    expect(parseGraphHash()).toEqual({ camera: [1, 2, 3], selectedNodeId: '5' });
    window.location.hash = '';
  });

  it('updates the URL hash with camera and selected node', () => {
    window.location.hash = '#/graph';
    updateGraphHash([10, 20, 30], '42');
    const parsed = parseGraphHash();
    expect(parsed.camera).toEqual([10, 20, 30]);
    expect(parsed.selectedNodeId).toBe('42');
    window.location.hash = '';
  });
});

describe('KnowledgeGraph3D', () => {
  it('renders the Suspense loading fallback in a server environment', () => {
    const nodes = [
      { id: '1', name: 'A', category: 'concept', x: 0, y: 0, z: 0, radius: 0.5, edgeCount: 0 },
    ];
    const edges = [{ source: '1', target: '1', strength: 1 }];
    const markup = renderToStaticMarkup(
      <KnowledgeGraph3D
        nodes={nodes}
        edges={edges}
        onNodeSelect={() => {}}
        selectedNodeId={null}
        flyToTarget={null}
        onRegisterExport={() => {}}
        onRegisterReset={() => {}}
      />
    );
    expect(markup).toContain('3D 知识星图');
  });
});
