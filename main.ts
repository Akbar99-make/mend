// mend: one patch tool for every AI edit format.
//
// mend reads a patch that an AI model wrote and applies it to the tree
// of text files in the working directory. Models write edits in four
// formats, and mend reads all four to the one written specification in
// SPEC.md: unified diffs (whose line numbers the model may have got
// wrong), SEARCH/REPLACE blocks, V4A patches, and text-editor tool
// calls as JSON. Lines an edit names are found even when the model
// drifted their whitespace or indentation, at three tiers of closeness,
// and every file is changed or none is.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format=NAME  one of auto, unified, search-replace, v4a, json
//   --check        report what would change, write nothing
//   --strict       match lines exactly (tier 0 only)
//   PATCH          the patch file; absent or - reads standard input
//
// In a trial the grader runs this file with MAKEFUN_ENV_URL set, and
// the file hands the trial over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; the 1-based patch line it names. */
class ParseProblem extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** One edit that cannot be applied; its code and the path it concerns. */
class EditProblem extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

type EditFn = (tree: Tree) => void;

/** A path is safe when it names a file under the tree, nothing above it. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A patch's lines: split at \n, one trailing \r removed, no empty tail. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A file as lines, its line break, and whether it ends with one. */
interface TextFile {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): TextFile {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** How a line reads at one matching tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const trimmed = s.replace(/[ \t]+$/, '');
  return tier === 1 ? trimmed : trimmed.replace(/^[ \t]+/, '');
}

/** Every 0-based position where `need` occurs in `have` at `tier`. */
function findOccurrences(need: string[], have: string[], tier: number): number[] {
  const out: number[] = [];
  if (need.length === 0 || need.length > have.length) return out;
  for (let i = 0; i + need.length <= have.length; i++) {
    let ok = true;
    for (let j = 0; j < need.length; j++) {
      if (normLine(have[i + j]!, tier) !== normLine(need[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `need` occurs, with every occurrence there. */
function locateTier(need: string[], have: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const at = findOccurrences(need, have, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** The first occurrence of `need` at or after `from`, at the first tier with one. */
function locateFrom(
  need: string[],
  have: string[],
  from: number,
  strict: boolean,
  endOnly: boolean,
): { pos: number; tier: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (const p of findOccurrences(need, have, t)) {
      if (p < from) continue;
      if (endOnly && p + need.length !== have.length) continue;
      return { pos: p, tier: t };
    }
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` as one line, or -1. */
function findSingle(anchor: string, have: string[], from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < have.length; i++) {
      if (normLine(have[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** At tier 2 a new line that starts with the old indent takes the file's. */
function reindent(line: string, fromWs: string, toWs: string): string {
  if (line.trim() === '') return line;
  if (line.startsWith(fromWs)) return toWs + line.slice(fromWs.length);
  return line;
}

/**
 * The tree as the edits leave it: the files as they were on disk, and
 * the changes the edits made on top of them (null: deleted).
 */
class Tree {
  base = new Map<string, string | null>();
  overlay = new Map<string, string | null>();
  moves: Array<{ from: string; to: string }> = [];

  readBase(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p) as string | null;
  }

  peek(p: string): string | null {
    return this.overlay.has(p) ? (this.overlay.get(p) as string | null) : this.readBase(p);
  }

  put(p: string, v: string | null): void {
    this.overlay.set(p, v);
  }

  checkpoint(): { over: Map<string, string | null>; mv: number } {
    return { over: new Map(this.overlay), mv: this.moves.length };
  }

  restore(s: { over: Map<string, string | null>; mv: number }): void {
    this.overlay = s.over;
    this.moves.length = s.mv;
  }

  overlayKeys(): string[] {
    return [...this.overlay.keys()];
  }

  overlayGet(p: string): string | null {
    return this.overlay.get(p) as string | null;
  }
}

/** One line of a hunk or chunk body, with a `\` line folded onto it. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
}

/** Raw body lines into items; a `\` line marks the line before it. */
function bodyItems(rawLines: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const raw of rawLines) {
    if (raw.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.noNl = true;
      continue;
    }
    if (raw === '') items.push({ kind: 'ctx', text: '', noNl: false });
    else if (raw[0] === ' ') items.push({ kind: 'ctx', text: raw.slice(1), noNl: false });
    else if (raw[0] === '-') items.push({ kind: 'del', text: raw.slice(1), noNl: false });
    else if (raw[0] === '+') items.push({ kind: 'add', text: raw.slice(1), noNl: false });
  }
  return items;
}

/** Whether a `\` line follows the body's last context or added line. */
function lastNoNl(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.noNl;
  }
  return false;
}

/**
 * The lines that replace a match: context lines are the file's own
 * matched lines, added lines are re-indented at tier 2.
 */
function buildReplacement(
  items: BodyItem[],
  oldLines: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  const leadFile = leadingWs(fileLines[pos] ?? '');
  const leadOld = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  let fi = pos;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[fi] ?? '');
      fi += 1;
    } else if (it.kind === 'del') {
      fi += 1;
    } else {
      out.push(tier === 2 ? reindent(it.text, leadOld, leadFile) : it.text);
    }
  }
  return out;
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

/** Apply one unified hunk to a file's lines, honouring its `\` lines. */
function applyHunk(state: TextFile, hunk: Hunk, drift: number, strict: boolean, path: string): void {
  const oldLines = hunk.body.filter((it) => it.kind !== 'add').map((it) => it.text);
  const noNl = lastNoNl(hunk.body);
  if (oldLines.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + drift, state.lines.length));
    const added = hunk.body.filter((it) => it.kind === 'add').map((it) => it.text);
    const atEnd = at >= state.lines.length;
    state.lines.splice(at, 0, ...added);
    if (atEnd) state.fin = !noNl;
    return;
  }
  const found = locateTier(oldLines, state.lines, strict);
  if (found === null) throw new EditProblem('no-match', path);
  const target = hunk.a - 1 + drift;
  let pos = found.at[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.at) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const repl = buildReplacement(hunk.body, oldLines, state.lines, pos, found.tier);
  const touchesEnd = pos + oldLines.length === state.lines.length;
  state.lines.splice(pos, oldLines.length, ...repl);
  if (touchesEnd) state.fin = !noNl;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renFrom: string | null;
  renTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) throw new ParseProblem(lineNo);
  return { x: m[1]!, y: m[2]! };
}

/** A `--- ` / `+++ ` path: past the marker, up to a tab, prefixes off. */
function extractHeaderPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseHunkHeader(line: string, lineNo: number): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new ParseProblem(lineNo);
  return { a: Number.parseInt(m[1]!, 10), body: [] };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let mode: 'out' | 'header' | 'body' | 'hunks' = 'out';
  let hunk: Hunk | null = null;
  let rawBody: string[] = [];

  const freshSection = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renFrom: null,
    renTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  const openSection = (s: UniSection): void => {
    sections.push(s);
    cur = s;
    mode = 'header';
  };
  const closeBody = (): void => {
    while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
    if (hunk !== null) {
      hunk.body = bodyItems(rawBody);
      cur!.hunks.push(hunk);
      hunk = null;
    }
    rawBody = [];
    mode = 'hunks';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const no = i + 1;
    if (mode === 'body') {
      const boundary =
        (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) || line.startsWith('diff --git ');
      if (!boundary && (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\')) {
        rawBody.push(line);
        continue;
      }
      closeBody();
    }
    if (line.startsWith('diff --git ')) {
      const d = parseDiffGit(line, no);
      const s = freshSection();
      s.diffOld = d.x;
      s.diffNew = d.y;
      openSection(s);
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = extractHeaderPath(line);
        const newP = extractHeaderPath(next);
        if (mode === 'header' && cur !== null && !cur.hasPair) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
          cur.hasPair = true;
        } else {
          const s = freshSection();
          s.pairOld = oldP;
          s.pairNew = newP;
          s.hasPair = true;
          openSection(s);
        }
        i += 1;
        continue;
      }
      if (mode === 'header') throw new ParseProblem(no + 1);
      continue;
    }
    if (line.startsWith('@@')) {
      if (mode === 'out') throw new ParseProblem(no);
      hunk = parseHunkHeader(line, no);
      rawBody = [];
      mode = 'body';
      continue;
    }
    if (mode === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
  }
  if (mode === 'body') closeBody();
  if (sections.length === 0) throw new ParseProblem(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): EditFn {
  const oldP = sec.hasPair ? sec.pairOld : (sec.renFrom ?? sec.diffOld);
  const newP = sec.hasPair ? sec.pairNew : (sec.renTo ?? sec.diffNew);
  return (tree: Tree) => {
    if (oldP !== null && !isSafePath(oldP)) throw new EditProblem('unsafe', oldP);
    if (newP !== null && !isSafePath(newP)) throw new EditProblem('unsafe', newP);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (tree.peek(newP) !== null) throw new EditProblem('exists', newP);
      const plus = sec.hunks.flatMap((h) => h.body.filter((it) => it.kind === 'add'));
      const content =
        plus.length === 0 ? '' : plus.map((it) => it.text).join('\n') + (plus[plus.length - 1]!.noNl ? '' : '\n');
      tree.put(newP, content);
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.peek(oldP) === null) throw new EditProblem('missing', oldP);
      tree.put(oldP, null);
      return;
    }
    const target = oldP as string;
    const cur = tree.peek(target);
    if (cur === null) throw new EditProblem('missing', target);
    const isMove = newP !== null && newP !== target;
    if (isMove && tree.peek(newP as string) !== null) throw new EditProblem('exists', newP as string);
    const state = splitFile(cur);
    let drift = 0;
    for (const h of sec.hunks) {
      const oLen = h.body.filter((it) => it.kind !== 'add').length;
      const nLen = h.body.filter((it) => it.kind !== 'del').length;
      applyHunk(state, h, drift, strict, target);
      drift += nLen - oLen;
    }
    const out = joinFile(state);
    if (isMove) {
      tree.put(target, null);
      tree.put(newP as string, out);
      tree.moves.push({ from: target, to: newP as string });
    } else {
      tree.put(target, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new ParseProblem(i + 1);
      }
      let sep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          sep = j;
          break;
        }
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      }
      if (sep < 0) throw new ParseProblem(i + 1);
      let end = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (end < 0) throw new ParseProblem(i + 1);
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevEnd = end;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  if (blocks.length === 0) throw new ParseProblem(1);
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SrBlock, strict: boolean): EditFn {
  return (tree: Tree) => {
    if (!isSafePath(b.path)) throw new EditProblem('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.peek(b.path) !== null) throw new EditProblem('exists', b.path);
      tree.put(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.peek(b.path);
    if (cur === null) throw new EditProblem('missing', b.path);
    const state = splitFile(cur);
    const found = locateTier(b.oldLines, state.lines, strict);
    if (found === null) throw new EditProblem('no-match', b.path);
    if (found.at.length > 1) throw new EditProblem('ambiguous', b.path);
    const pos = found.at[0]!;
    const leadFile = leadingWs(state.lines[pos] ?? '');
    const leadOld = leadingWs(b.oldLines[0]!);
    const repl = b.newLines.map((t) => (found.tier === 2 ? reindent(t, leadOld, leadFile) : t));
    state.lines.splice(pos, b.oldLines.length, ...repl);
    tree.put(b.path, joinFile(state));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string;
  eof: boolean;
  body: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new ParseProblem(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseProblem(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseProblem(lines.length + 1);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  const sectionKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const kind = sectionKind(line);
    if (kind !== null) {
      const prefix = kind === 'add' ? 14 : 17;
      cur = { kind, path: line.slice(prefix).trim(), lineNo: i + 1, raw: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (line.trim() === '') continue;
      throw new ParseProblem(i + 1);
    }
    cur.raw.push({ text: line, no: i + 1 });
  }
  for (const s of sections) {
    while (s.raw.length > 0 && s.raw[s.raw.length - 1]!.text.trim() === '') s.raw.pop();
  }
  if (sections.length === 0) throw new ParseProblem(1);
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): EditFn {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of sec.raw) {
      if (r.text === '') fileLines.push('');
      else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else throw new ParseProblem(r.no);
    }
    return (tree: Tree) => {
      if (!isSafePath(sec.path)) throw new EditProblem('unsafe', sec.path);
      if (tree.peek(sec.path) !== null) throw new EditProblem('exists', sec.path);
      tree.put(sec.path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
    };
  }
  if (sec.kind === 'delete') {
    for (const r of sec.raw) {
      if (r.text.trim() !== '') throw new ParseProblem(r.no);
    }
    return (tree: Tree) => {
      if (!isSafePath(sec.path)) throw new EditProblem('unsafe', sec.path);
      if (tree.peek(sec.path) === null) throw new EditProblem('missing', sec.path);
      tree.put(sec.path, null);
    };
  }
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  let contentSeen = false;
  for (const r of sec.raw) {
    const text = r.text;
    if (text.trim() === '') {
      // An empty line is a body line: an empty context line. It opens the
      // first chunk when none is open, and it counts as the section's
      // first line, so a Move to after it is no longer first.
      contentSeen = true;
      if (curChunk === null) {
        if (chunks.length > 0) throw new ParseProblem(r.no);
        curChunk = { anchor: '', eof: false, body: [] };
      }
      curChunk.body.push({ kind: 'ctx', text: '', noNl: false });
      continue;
    }
    if (text.startsWith('*** Move to: ')) {
      if (!contentSeen && moveTo === null) {
        moveTo = text.slice(13).trim();
        contentSeen = true;
        continue;
      }
      throw new ParseProblem(r.no);
    }
    contentSeen = true;
    if (text.startsWith('@@')) {
      if (curChunk !== null) chunks.push(curChunk);
      curChunk = { anchor: text.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (curChunk === null) throw new ParseProblem(r.no);
      curChunk.eof = true;
      chunks.push(curChunk);
      curChunk = null;
      continue;
    }
    if (text.startsWith('***')) throw new ParseProblem(r.no);
    if (text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (curChunk === null) {
        if (chunks.length > 0) throw new ParseProblem(r.no);
        curChunk = { anchor: '', eof: false, body: [] };
      }
      curChunk.body.push(...bodyItems([text]));
      continue;
    }
    throw new ParseProblem(r.no);
  }
  if (curChunk !== null) chunks.push(curChunk);
  if (chunks.length === 0 && moveTo === null) throw new ParseProblem(sec.lineNo);
  return (tree: Tree) => {
    if (!isSafePath(sec.path)) throw new EditProblem('unsafe', sec.path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditProblem('unsafe', moveTo);
    const cur = tree.peek(sec.path);
    if (cur === null) throw new EditProblem('missing', sec.path);
    if (moveTo !== null && tree.peek(moveTo) !== null) throw new EditProblem('exists', moveTo);
    const state = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      cursor = applyV4aChunk(state, ch, cursor, strict, sec.path);
    }
    const out = joinFile(state);
    if (moveTo !== null) {
      tree.put(sec.path, null);
      tree.put(moveTo, out);
      tree.moves.push({ from: sec.path, to: moveTo });
    } else {
      tree.put(sec.path, out);
    }
  };
}

/** Apply one V4A chunk, moving the cursor past the lines it wrote. */
function applyV4aChunk(state: TextFile, ch: VChunk, cursor: number, strict: boolean, path: string): number {
  if (ch.anchor !== '') {
    const at = findSingle(ch.anchor, state.lines, cursor, strict);
    if (at < 0) throw new EditProblem('no-match', path);
    cursor = at + 1;
  }
  const oldLines = ch.body.filter((it) => it.kind !== 'add').map((it) => it.text);
  if (oldLines.length === 0) {
    const at = ch.eof ? state.lines.length : cursor;
    const added = ch.body.filter((it) => it.kind === 'add').map((it) => it.text);
    state.lines.splice(at, 0, ...added);
    return at + added.length;
  }
  const found = locateFrom(oldLines, state.lines, cursor, strict, ch.eof);
  if (found === null) throw new EditProblem('no-match', path);
  const repl = buildReplacement(ch.body, oldLines, state.lines, found.pos, found.tier);
  state.lines.splice(found.pos, oldLines.length, ...repl);
  return found.pos + repl.length;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new ParseProblem(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseProblem(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseProblem(first + 1);
    for (const x of v) edits.push(jsonEdit(x, first + 1));
    if (edits.length === 0) throw new ParseProblem(1);
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseProblem(i + 1);
    }
    edits.push(jsonEdit(v, i + 1));
  }
  if (edits.length === 0) throw new ParseProblem(1);
  return edits;
}

function jsonEdit(v: unknown, lineNo: number): EditFn {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ParseProblem(lineNo);
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseProblem(lineNo);
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseProblem(lineNo);
    const text = o.file_text;
    return (tree: Tree) => {
      if (!isSafePath(p)) throw new EditProblem('unsafe', p);
      if (tree.peek(p) !== null) throw new EditProblem('exists', p);
      tree.put(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseProblem(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseProblem(lineNo);
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree) => {
      if (!isSafePath(p)) throw new EditProblem('unsafe', p);
      const before = tree.peek(p);
      if (before === null) throw new EditProblem('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditProblem('no-match', p);
      if (count > 1) throw new EditProblem('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.put(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseProblem(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseProblem(lineNo);
    const atLine = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree: Tree) => {
      if (!isSafePath(p)) throw new EditProblem('unsafe', p);
      const before = tree.peek(p);
      if (before === null) throw new EditProblem('missing', p);
      const f = splitFile(before);
      if (atLine < 0 || atLine > f.lines.length) throw new EditProblem('no-match', p);
      f.lines.splice(atLine, 0, ...added);
      tree.put(p, joinFile(f));
    };
  }
  throw new ParseProblem(lineNo);
}

// ---------------------------------------------------------------------------
// Format detection (section 4), the run, and the output (sections 1, 2, 10)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** The lines the run reports, in byte order of their paths. */
function computeRows(tree: Tree): string[] {
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.overlayKeys()) {
    const was = tree.readBase(p);
    const now = tree.overlayGet(p);
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; text: string }> = [];
  const folded = new Set<string>();
  for (const m of tree.moves) {
    const from = changed.get(m.from);
    const to = changed.get(m.to);
    if (
      from !== undefined &&
      from.was !== null &&
      from.now === null &&
      to !== undefined &&
      to.was === null &&
      to.now !== null
    ) {
      rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
      folded.add(m.from);
      folded.add(m.to);
    }
  }
  for (const [p, c] of changed) {
    if (folded.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.text);
}

function writeChanges(tree: Tree): void {
  for (const p of tree.overlayKeys()) {
    const was = tree.readBase(p);
    const now = tree.overlayGet(p);
    if (was === now) continue;
    if (now === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
}

function runCli(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseProblem(1);
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditProblem[] = [];
  for (const edit of edits) {
    const snap = tree.checkpoint();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditProblem)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = computeRows(tree);
  if (!check) writeChanges(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
