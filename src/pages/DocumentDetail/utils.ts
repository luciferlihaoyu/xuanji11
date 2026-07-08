import type { KbDocument } from '@db/schema';

export function formatFileSize(length: number): string {
  if (length === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(length) / Math.log(1024)), units.length - 1);
  return `${(length / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return '-';
  return new Date(date).toLocaleString();
}

export function fileExtensionForFormat(format: KbDocument['format']): string {
  switch (format) {
    case 'markdown':
      return '.md';
    case 'text':
      return '.txt';
    case 'json':
      return '.json';
    case 'html':
      return '.html';
    case 'code':
      return '.code';
    default:
      return '.md';
  }
}

export function downloadDocument(doc: KbDocument) {
  const content = doc.content ?? '';
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ext = fileExtensionForFormat(doc.format);
  const baseTitle = doc.title.replace(/\.[^/.]+$/, '');
  a.href = url;
  a.download = `${baseTitle}${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
