// Private capability receipts. IDs never appear in the public queue projection.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';

export type ReceiptPhase = 'accepted' | 'searching' | 'queued' | 'aired' | 'declined' | 'failed' | 'removed' | 'answered';
export interface Receipt {
  id: string;
  createdAt: number;
  phase: ReceiptPhase;
  track?: { title?: string | null; artist?: string | null; album?: string | null };
  ack?: string | null;
  message?: string | null;
  airedAt?: string;
}
const RETENTION_MS = 7 * 24 * 3600_000;
let loadedPath = '';
let rows: Record<string, Receipt> = {};
const terminal = new Set<ReceiptPhase>(['aired', 'declined', 'failed', 'removed', 'answered']);

function load(): string {
  const file = path.join(config.stateDir, 'request-receipts.json');
  if (loadedPath !== file) {
    const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid request receipts');
    rows = stored;
    loadedPath = file;
  }
  return file;
}

export function readReceipt(id: string, now = Date.now()): Receipt | null {
  load();
  const row = rows[id];
  return row && row.createdAt >= now - RETENTION_MS ? { ...row } : null;
}

export function saveReceipt(id: string, patch: Partial<Omit<Receipt, 'id'>>, now = Date.now()): void {
  const file = load();
  const prev = rows[id];
  // Slow intro/ack completion must never turn an aired receipt back into queued.
  const phase = patch.phase === 'aired' ? 'aired'
    : prev && terminal.has(prev.phase) ? prev.phase : (patch.phase ?? prev?.phase ?? 'accepted');
  const next = Object.fromEntries(Object.entries(rows).filter(([, r]) => r.createdAt >= now - RETENTION_MS));
  if (!prev && Object.keys(next).length >= 2000) throw new Error('Request receipt limit reached');
  const track = patch.track ? { title: patch.track.title, artist: patch.track.artist, album: patch.track.album } : prev?.track;
  next[id] = { ...prev, ...patch, id, createdAt: prev?.createdAt ?? patch.createdAt ?? now, phase, track };
  if (JSON.stringify(next[id]) === JSON.stringify(prev)) return;
  mkdirSync(config.stateDir, { recursive: true });
  writeFileAtomicSync(file, JSON.stringify(next), { mode: 0o600 });
  rows = next;
}
