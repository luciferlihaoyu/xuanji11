/* @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VectorCollection } from '@db/schema';
import { ZVecManagementPanel } from './ZVecManagementPanel';

const baseStats = {
  ok: true,
  engine: 'zvec',
  size: 0,
  mode: 'empty' as const,
  provider: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  model: 'doubao-embedding-vision',
  dimension: 2048,
  zvecEnabled: true,
  zvecDataDir: '/data/app/zvec',
  zvecDimension: 2048,
  collectionName: 'document_chunks',
};

const baseCollections = [
  {
    id: 1,
    name: 'document_chunks',
    description: null,
    model: 'doubao-embedding-vision',
    dimension: 2048,
    status: 'ready' as const,
    documentCount: 5,
    createdBy: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  },
] satisfies VectorCollection[];

describe('ZVecManagementPanel', () => {
  it('renders ZVec health, config and collections with Chinese copy', () => {
    const markup = renderToStaticMarkup(
      <ZVecManagementPanel stats={baseStats} collections={baseCollections} isLoading={false} />
    );

    expect(markup).toContain('ZVec 向量索引');
    expect(markup).toContain('运行正常');
    expect(markup).toContain('zvec');
    expect(markup).toContain('2048');
    expect(markup).toContain('/data/app/zvec');
    expect(markup).toContain('document_chunks');
    expect(markup).toContain('向量集合');
    expect(markup).toContain('zvec:read');
    expect(markup).toContain('zvec:write');
  });

  it('shows a dimension mismatch warning when embedding and index dimensions differ', () => {
    const markup = renderToStaticMarkup(
      <ZVecManagementPanel
        stats={{ ...baseStats, dimension: 1536, zvecDimension: 2048 }}
        collections={baseCollections}
        isLoading={false}
      />
    );

    expect(markup).toContain('维度不一致');
    expect(markup).toContain('1536');
    expect(markup).toContain('2048');
  });

  it('shows an empty state when no collections are provided', () => {
    const markup = renderToStaticMarkup(
      <ZVecManagementPanel stats={baseStats} collections={[]} isLoading={false} />
    );

    expect(markup).toContain('暂无向量集合');
  });

  it('shows an error warning when stats.error is present', () => {
    const markup = renderToStaticMarkup(
      <ZVecManagementPanel
        stats={{ ...baseStats, ok: false, error: 'path validate failed' }}
        collections={[]}
        isLoading={false}
      />
    );

    expect(markup).toContain('向量引擎警告');
    expect(markup).toContain('path validate failed');
  });
});
