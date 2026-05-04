/**
 * `aula transcript view <file>` — pretty-print a JSONL wire transcript.
 * `aula transcript prune` — delete old transcripts, keeping the N newest.
 * `aula transcript list` — show what's on disk.
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { formatTraceText, type WireEntry } from '@aula-mcp/aula-auth';
import { fail, fmt, info, ok, printJson, warn } from '../io.ts';
import { TRANSCRIPT_DIR } from '../store.ts';

export interface TranscriptViewArgs {
  file: string;
  json?: boolean;
}

export async function runTranscriptView(args: TranscriptViewArgs): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(args.file, 'utf8');
  } catch (e) {
    fail(`Could not read transcript ${args.file}: ${(e as Error).message}`);
    process.exit(1);
  }
  const entries: WireEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WireEntry);
    } catch {
      warn(`Skipping malformed JSONL line (${line.length} chars)`);
    }
  }
  if (args.json) {
    printJson(entries);
    return;
  }
  process.stdout.write(formatTraceText(entries));
  process.stdout.write(`\n\n  ${entries.length} entries\n`);
}

export interface TranscriptListArgs {
  json?: boolean;
}

export async function runTranscriptList(args: TranscriptListArgs = {}): Promise<void> {
  const files = await listTranscriptFiles();
  if (args.json) {
    printJson(files);
    return;
  }
  if (files.length === 0) {
    info(`No transcripts in ${fmt.dim(TRANSCRIPT_DIR)}.`);
    return;
  }
  info(`${files.length} transcript(s) in ${fmt.dim(TRANSCRIPT_DIR)}:`);
  for (const f of files) {
    process.stdout.write(
      `  ${fmt.dim(f.modified.toISOString())}  ${formatBytes(f.size)}  ${f.path}\n`,
    );
  }
}

export interface TranscriptPruneArgs {
  keep?: number;
  dryRun?: boolean;
}

export async function runTranscriptPrune(args: TranscriptPruneArgs = {}): Promise<void> {
  const keep = args.keep ?? 10;
  const dryRun = args.dryRun ?? false;
  const files = await listTranscriptFiles();
  if (files.length <= keep) {
    info(`Nothing to prune — ${files.length} transcript(s), keep ${keep}.`);
    return;
  }
  const stale = files.slice(keep); // already sorted newest-first
  for (const f of stale) {
    if (dryRun) {
      info(`would delete ${f.path}`);
    } else {
      await unlink(f.path).catch((e) =>
        warn(`could not delete ${f.path}: ${(e as Error).message}`),
      );
    }
  }
  ok(`${dryRun ? 'Would prune' : 'Pruned'} ${stale.length} transcript(s).`);
}

async function listTranscriptFiles(): Promise<
  Array<{ path: string; size: number; modified: Date }>
> {
  let names: string[];
  try {
    names = await readdir(TRANSCRIPT_DIR);
  } catch {
    return [];
  }
  const files: Array<{ path: string; size: number; modified: Date }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(TRANSCRIPT_DIR, name);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    files.push({ path, size: s.size, modified: s.mtime });
  }
  files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return files;
}

function formatBytes(n: number): string {
  if (n < 1_024) return `${n}B`;
  if (n < 1_024 * 1_024) return `${(n / 1_024).toFixed(1)}KB`;
  return `${(n / (1_024 * 1_024)).toFixed(1)}MB`;
}
