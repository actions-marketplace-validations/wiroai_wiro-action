import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as glob from '@actions/glob';
import { InputError } from './errors.js';
import { USER_AGENT } from './version.js';

const GLOB_CHARS = /[*?[\]{}]/;

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.epub': 'application/epub+zip',
  '.glb': 'model/gltf-binary',
  '.obj': 'model/obj',
};

/** @param {string} file */
export function mimeType(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * A path for logs and prompts: relative to the workspace with forward slashes,
 * or absolute when the file is outside it.
 * @param {string} file
 * @param {string} workspace
 */
export function displayPath(file, workspace) {
  const relative = path.relative(workspace, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join('/');
}

/**
 * Expands paths and glob patterns, relative to the workspace, to a sorted list of files.
 * A plain path must exist; a folder stands for every file in it. Patterns that start
 * with `!` leave files out.
 * @param {string[]} patterns
 * @param {string} workspace
 * @param {string} label used in error messages
 * @returns {Promise<string[]>}
 */
export async function resolveFiles(patterns, workspace, label) {
  const include = [];
  const exclude = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) exclude.push(`!${path.resolve(workspace, pattern.slice(1))}`);
    else include.push(pattern);
  }

  const found = new Set();
  for (const pattern of include) {
    const absolute = path.resolve(workspace, pattern);
    // A file that exists is taken as it is, even when its name has [ ] or other glob characters.
    const info = await stat(absolute).catch(() => null);
    if (info?.isFile() && !exclude.length) {
      found.add(absolute);
      continue;
    }
    if (!info && !GLOB_CHARS.test(pattern)) throw new InputError(`${label}: \`${pattern}\` does not exist.`);
    const globber = await glob.create([absolute, ...exclude].join('\n'), {
      matchDirectories: false,
      implicitDescendants: true,
      followSymbolicLinks: true,
    });
    const matches = await globber.glob();
    if (!matches.length && !exclude.length) {
      throw new InputError(`${label}: no files match \`${pattern}\`.`);
    }
    for (const match of matches) found.add(match);
  }
  if (include.length && !found.size) {
    throw new InputError(`${label}: no files match \`${patterns.join('`, `')}\`.`);
  }
  return [...found].sort();
}

/**
 * A safe local file name for a downloaded output.
 * @param {unknown} name
 */
export function safeFileName(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  const cleaned = [...base]
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? '_' : char))
    .join('')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

/** @param {string} url */
function nameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

/**
 * @param {string} name
 * @param {Set<string>} used
 */
async function freeName(dir, name, used) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-${n}${ext}`;
    const key = candidate.toLowerCase();
    if (used.has(key)) continue;
    // Never replace a file that is already there, for example from an earlier step.
    const taken = await lstat(path.join(dir, candidate)).then(
      () => true,
      () => false,
    );
    if (taken) continue;
    used.add(key);
    return candidate;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads one URL to a file, retrying network errors and failed answers twice.
 * @param {string} url
 * @param {string} target
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, retryDelayMs?: number }} [options]
 */
export async function downloadFile(url, target, { fetchImpl = fetch, timeoutMs = 600_000, retryDelayMs = 2_000 } = {}) {
  const partial = `${target}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      // `wx` creates a new file and fails rather than write through a link left at that path.
      await rm(partial, { force: true });
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
      await rename(partial, target);
      return;
    } catch (err) {
      lastError = err;
      await rm(partial, { force: true });
      if (attempt < 3) await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`Could not download ${url}: ${lastError?.message ?? lastError}`);
}

/** Text outputs larger than this are not read into the `text` output. */
export const MAX_TEXT_OUTPUT_BYTES = 1_000_000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.srt', '.vtt', '.json', '.csv']);

/**
 * Whether an output file holds text, such as a transcript or a caption file.
 * @param {{ name?: string, contenttype?: string }} output
 */
export function isTextOutput(output) {
  const type = String(output.contenttype ?? '').toLowerCase();
  if (type.startsWith('text/') || type === 'application/json') return true;
  return TEXT_EXTENSIONS.has(path.extname(String(output.name ?? '')).toLowerCase());
}

/**
 * Reads a text file from a URL, retrying network errors and failed answers twice.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, retryDelayMs?: number }} [options]
 */
export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 60_000, retryDelayMs = 2_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`Could not read ${url}: ${lastError?.message ?? lastError}`);
}

/**
 * Downloads every output that has a URL into `dir`.
 * @param {Array<{ name?: string, url?: string }>} outputs
 * @param {string} dir
 * @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number }} [options]
 * @returns {Promise<string[]>} absolute paths, in output order
 */
export async function downloadOutputs(outputs, dir, options = {}) {
  await mkdir(dir, { recursive: true });
  const used = new Set();
  const saved = [];
  for (const [index, output] of outputs.entries()) {
    if (!output?.url) continue;
    const name = await freeName(
      dir,
      safeFileName(output.name) || safeFileName(nameFromUrl(output.url)) || `output-${index + 1}`,
      used,
    );
    const target = path.join(dir, name);
    await downloadFile(output.url, target, options);
    saved.push(target);
  }
  return saved;
}
