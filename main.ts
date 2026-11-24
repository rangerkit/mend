// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move pairs, in the order their edits ran; the printer turns qualifying pairs into `R` lines. */
let movePairs: { old: string; nw: string }[] = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Three-tier matching (SPEC section 5)
// ---------------------------------------------------------------------------

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** Every start position at which O occurs in `lines` under `tier`. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at least once (optionally only at or after `from`), or null. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, o, tier).filter((p) => p >= from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type EntryKind = 'ctx' | 'del' | 'add' | 'slash';
interface Entry {
  t: EntryKind;
  text: string;
  /** True when this entry came from a patch line that was completely empty. */
  emptyLine?: boolean;
}

/** The old lines O of a body: its context and `-` lines, in order. */
function oldOf(entries: Entry[]): string[] {
  return entries.filter((e) => e.t === 'ctx' || e.t === 'del').map((e) => e.text);
}

/** The new lines N of a body: its context and `+` lines, in order. */
function newCount(entries: Entry[]): number {
  return entries.filter((e) => e.t === 'ctx' || e.t === 'add').length;
}

/**
 * Build the lines that replace the matched ones. Context lines are written as the file's own matched line;
 * at tier 2 the other lines are re-indented from O's first line's lead to the file's first matched line's lead.
 */
function buildNew(fileLines: string[], pos: number, o: string[], entries: Entry[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const fLead = tier === 2 && o.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const pLead = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  for (const e of entries) {
    if (e.t === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (e.t === 'del') {
      oi += 1;
    } else if (e.t === 'add') {
      let s = e.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(pLead)) s = fLead + s.slice(pLead.length);
      out.push(s);
    }
  }
  return out;
}

/** True when a `\` line immediately follows the body's last context or `+` line. */
function slashAfterLastWritten(entries: Entry[]): boolean {
  let last = -1;
  entries.forEach((e, i) => {
    if (e.t === 'ctx' || e.t === 'add') last = i;
  });
  return last >= 0 && entries[last + 1]?.t === 'slash';
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  entries: Entry[];
}

interface USection {
  fromGit: boolean;
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  hdrOld: string | null;
  hdrNew: string | null;
  sawHdrOld: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names: after the four characters, up to a tab, spaces removed, prefix removed. */
function hdrPath(raw: string): string | null {
  let s = raw.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +| +$/g, '');
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@( .*)?$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (fromGit: boolean): USection => ({
    fromGit,
    gitOld: null,
    gitNew: null,
    hasPair: false,
    hdrOld: null,
    hdrNew: null,
    sawHdrOld: false,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null || !line.startsWith('diff --git ')) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(true);
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.fromGit && !cur.hasPair && cur.hunks.length === 0) {
        cur.hdrOld = hdrPath(line);
        cur.hdrNew = hdrPath(lines[i + 1]!);
        cur.hasPair = true;
        cur.sawHdrOld = true;
      } else {
        cur = fresh(false);
        cur.hdrOld = hdrPath(line);
        cur.hdrNew = hdrPath(lines[i + 1]!);
        cur.hasPair = true;
        cur.sawHdrOld = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const entries: Entry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          entries.push({ t: 'ctx', text: '', emptyLine: true });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') entries.push({ t: 'ctx', text: l.slice(1) });
        else if (c === '-') entries.push({ t: 'del', text: l.slice(1) });
        else if (c === '+') entries.push({ t: 'add', text: l.slice(1) });
        else if (c === '\\') entries.push({ t: 'slash', text: l.slice(1) });
        else break;
        j += 1;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.emptyLine === true) entries.pop();
      cur.hunks.push({ a: Number(m[1]), entries });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Still in the section's header: only the lines SPEC names mean anything here.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks to `start` lines; shared by the change and move forms of a section. */
function applyHunks(start: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  const work: FileLines = { br: start.br, lines: [...start.lines], final: start.final };
  let d = 0;
  for (const h of hunks) {
    const o = oldOf(h.entries);
    const nLen = newCount(h.entries);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, work.lines.length));
      const atEnd = at === work.lines.length;
      const adds = h.entries.filter((e) => e.t === 'add').map((e) => e.text);
      work.lines.splice(at, 0, ...adds);
      // An insertion at the end of the file ends with a break unless a `\` line follows its last `+` line.
      if (atEnd) work.final = !slashAfterLastWritten(h.entries);
      d += nLen - o.length;
      continue;
    }
    const found = findTier(work.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const replacement = buildNew(work.lines, pos, o, h.entries, found.tier);
    const runsToEnd = pos + o.length === work.lines.length;
    work.lines.splice(pos, o.length, ...replacement);
    if (runsToEnd) work.final = !slashAfterLastWritten(h.entries);
    d += nLen - o.length;
  }
  return work;
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath: string | null = s.hasPair ? s.hdrOld : s.renameFrom ?? s.gitOld;
  const newPath: string | null = s.hasPair ? s.hdrNew : s.renameTo ?? s.gitNew;
  const creation = s.isCreate || (s.hasPair && s.sawHdrOld && s.hdrOld === null);
  const deletion = s.isDelete || (s.hasPair && s.hdrNew === null);
  return (tree) => {
    // Safety first, for every path the section names (section 10).
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const p = newPath ?? oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const fileLines: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        h.entries.forEach((e, idx) => {
          if (e.t === 'add') {
            fileLines.push(e.text);
            noEol = h.entries[idx + 1]?.t === 'slash';
          }
        });
      }
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldPath ?? newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const before = splitFile(tree.get(oldPath)!);
      const after = applyHunks(before, s.hunks, strict, oldPath);
      tree.now.set(newPath, joinFile(after));
      tree.now.set(oldPath, null);
      movePairs.push({ old: oldPath, nw: newPath });
      return;
    }
    const p = oldPath ?? newPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    const before = splitFile(tree.get(p)!);
    const after = applyHunks(before, s.hunks, strict, p);
    tree.now.set(p, joinFile(after));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // Lines at or before the previous block's REPLACE line are not searched for a path.
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const f = splitFile(text);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    // No context lines here: every new line is an ordinary line of N for the tier-2 re-indent rule.
    const entries: Entry[] = b.newLines.map((t) => ({ t: 'add' as EntryKind, text: t }));
    const replacement = buildNew(f.lines, pos, b.oldLines, entries, found.tier);
    f.lines.splice(pos, b.oldLines.length, ...replacement);
    tree.now.set(b.path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

type VSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    let j = i + 1;
    const content: { text: string; no: number }[] = [];
    while (j < last && !isStart(lines[j]!)) {
      content.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (line.startsWith(V_ADD)) {
      const path = line.slice(V_ADD.length).trim();
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
      sections.push({ kind: 'add', path, fileLines });
    } else if (line.startsWith(V_DEL)) {
      const path = line.slice(V_DEL.length).trim();
      for (const c of content) {
        if (!blank(c.text)) throw new Exit2(`error: parse ${c.no}`);
      }
      sections.push({ kind: 'delete', path });
    } else {
      const path = line.slice(V_UPD.length).trim();
      let moveTo: string | null = null;
      let body = content;
      if (body.length > 0 && body[0]!.text.startsWith(V_MOVE)) {
        moveTo = body[0]!.text.slice(V_MOVE.length).trim();
        body = body.slice(1);
      }
      const chunks: VChunk[] = [];
      let open: VChunk | null = null;
      for (const c of body) {
        const l = c.text;
        if (l.startsWith('@@')) {
          open = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, entries: [] };
          chunks.push(open);
        } else if (l === '*** End of File') {
          if (open === null) {
            open = { anchor: null, eof: false, entries: [] };
            chunks.push(open);
          }
          open.eof = true;
          open = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (open === null) {
            open = { anchor: null, eof: false, entries: [] };
            chunks.push(open);
          }
          if (l === '') open.entries.push({ t: 'ctx', text: '' });
          else if (l[0] === ' ') open.entries.push({ t: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') open.entries.push({ t: 'del', text: l.slice(1) });
          else open.entries.push({ t: 'add', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${c.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
    }
    i = j;
  }
  return sections;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'update' && s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const text = tree.get(s.path);
    if (text === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineEq(f.lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const o = oldOf(chunk.entries);
      if (o.length === 0) {
        const adds = chunk.entries.filter((e) => e.t === 'add').map((e) => e.text);
        const at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiers) {
        const positions = occurrencesAt(f.lines, o, tier).filter(
          (p) => p >= cursor && (!chunk.eof || p + o.length === f.lines.length),
        );
        if (positions.length > 0) {
          placed = { tier, pos: positions[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', s.path);
      const replacement = buildNew(f.lines, placed.pos, o, chunk.entries, placed.tier);
      f.lines.splice(placed.pos, o.length, ...replacement);
      cursor = placed.pos + replacement.length;
    }
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, joinFile(f));
      tree.now.set(s.path, null);
      movePairs.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.now.set(s.path, joinFile(f));
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  movePairs = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aSections(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const pairsBefore = movePairs.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      movePairs.length = pairsBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const pair of movePairs) {
    if (movedOld.has(pair.old) || movedNew.has(pair.nw)) continue;
    const qualifies =
      tree.original(pair.old) !== null && finalOf(pair.old) === null && tree.original(pair.nw) === null && finalOf(pair.nw) !== null;
    if (!qualifies) continue;
    movedOld.add(pair.old);
    movedNew.add(pair.nw);
    rows.push({ key: pair.nw, line: `R ${pair.old} -> ${pair.nw}` });
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
