import { describe, expect, it } from 'vitest';
import {
  calculate3DLayout,
  findNodeByName,
  getConnectedNodeIds,
  getNodeColor,
  getNodeRadius,
} from './graph-layout-3d';

describe('calculate3DLayout', () => {
  it('returns an empty array when given no nodes', () => {
    const result = calculate3DLayout([], []);
    expect(result).toEqual([]);
  });

  it('places a single node at the origin with the correct radius', () => {
    const nodes = [{ id: '1', name: 'A', category: 'concept', x: 0, y: 0, edgeCount: 1 }];
    const result = calculate3DLayout(nodes, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
    expect(result[0].radius).toBe(getNodeRadius(1));
    expect(Math.abs(result[0].x)).toBeLessThan(0.1);
    expect(Math.abs(result[0].y)).toBeLessThan(0.1);
  });

  it('produces deterministic positions for the same input', () => {
    const nodes = [
      { id: '1', name: 'A', category: 'concept', x: 10, y: 5, edgeCount: 1 },
      { id: '2', name: 'B', category: 'document', x: -5, y: -10, edgeCount: 2 },
    ];
    const run1 = calculate3DLayout(nodes, []);
    const run2 = calculate3DLayout(nodes, []);
    expect(run1[0]).toEqual(run2[0]);
    expect(run1[1]).toEqual(run2[1]);
  });

  it('keeps connected nodes closer than disconnected nodes', () => {
    const nodes = [
      { id: '1', name: 'A', category: 'concept', x: 0, y: 0, edgeCount: 2 },
      { id: '2', name: 'B', category: 'document', x: 10, y: 0, edgeCount: 1 },
      { id: '3', name: 'C', category: 'topic', x: -10, y: 0, edgeCount: 1 },
    ];
    const edges = [{ source: '1', target: '2', strength: 5 }];
    const result = calculate3DLayout(nodes, edges, { iterations: 60 });
    const a = result.find((n) => n.id === '1')!;
    const b = result.find((n) => n.id === '2')!;
    const c = result.find((n) => n.id === '3')!;

    const distAB = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const distAC = Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
    expect(distAB).toBeLessThan(distAC);
  });
});

describe('getNodeColor', () => {
  it('returns the mapped color for known categories', () => {
    expect(getNodeColor('concept')).toBe('#00e5ff');
    expect(getNodeColor('document')).toBe('#00d68f');
  });

  it('falls back to the concept color for unknown categories', () => {
    expect(getNodeColor('unknown')).toBe('#00e5ff');
  });
});

describe('getNodeRadius', () => {
  it('scales with edge count and never falls below the minimum', () => {
    expect(getNodeRadius(0)).toBe(0.5);
    expect(getNodeRadius(1)).toBe(Math.max(0.3, Math.log2(2) * 0.5));
    expect(getNodeRadius(7)).toBe(Math.max(0.3, Math.log2(8) * 0.5));
  });
});

describe('findNodeByName', () => {
  const nodes = [
    { id: '1', name: 'Machine Learning', category: 'concept', x: 0, y: 0, z: 0, radius: 1, edgeCount: 1 },
    { id: '2', name: 'Neural Networks', category: 'concept', x: 1, y: 1, z: 1, radius: 1, edgeCount: 1 },
  ];

  it('finds a node by a substring match', () => {
    expect(findNodeByName(nodes, 'neural')?.id).toBe('2');
  });

  it('returns null when no node matches', () => {
    expect(findNodeByName(nodes, 'quantum')).toBeNull();
  });
});

describe('getConnectedNodeIds', () => {
  const edges = [
    { source: '1', target: '2', strength: 1 },
    { source: '3', target: '1', strength: 1 },
  ];

  it('returns all neighbors regardless of edge direction', () => {
    const connected = getConnectedNodeIds('1', edges);
    expect([...connected]).toEqual(['2', '3']);
  });
});
