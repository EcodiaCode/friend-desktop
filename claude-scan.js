// claude-scan.js - the Friend desktop's local knowledge scanner.
//
// The whole point of Friend on your computer: it can read what a browser never can. This
// module walks the machine for a person's accumulated AI-coding footprint - Claude Code
// session transcripts, CLAUDE.md instructions, auto-memory, skills, subagents, slash
// commands, and the opencode/codex AGENTS.md + Cursor rules that sit alongside - and turns
// each into a plain-text "session" the Friend central brain ingests, so a whole Claude Code
// history can be ported onto Familiar.
//
// Two exports:
//   scan()             -> a fast manifest: every artifact found, categorised, with metadata
//                         and a short preview. No large reads; safe to run on every open.
//   readSessions(items)-> read + parse the SELECTED manifest items into ParsedSession[] (the
//                         exact shape /api/library/import accepts as { sessions }). Every path
//                         is re-validated against the allowed roots before it is read, so a
//                         compromised renderer can never turn this into an arbitrary file read.
//
// The parsers here mirror lib/history-import.ts (parseClaudeCodeJsonl / parsePlainText) and
// are PURE. Everything the scanner surfaces is UNTRUSTED external content; the server ingest
// screens every chunk for injection before any of it reaches the model.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const MAX_READ_BYTES = 8 * 1024 * 1024; // skip a single artifact larger than this
const WALK_MAX_DEPTH = 4; // how deep to look for project-level .claude / AGENTS.md
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'vendor',
  '.cache', '.venv', 'venv', '__pycache__', 'Library', '.Trash', '.npm', '.cargo',
  'DerivedData', 'Pods', '.gradle', '.pnpm-store',
]);

// Directories we are willing to look inside for project-level artifacts. Bounded, common
// developer roots only - never a blind full-disk walk.
function codeRoots() {
  const candidates = [
    HOME,
    path.join(HOME, 'code'), path.join(HOME, '.code'), path.join(HOME, 'Code'),
    path.join(HOME, 'dev'), path.join(HOME, 'src'), path.join(HOME, 'work'),
    path.join(HOME, 'repos'), path.join(HOME, 'projects'), path.join(HOME, 'Projects'),
    path.join(HOME, 'Documents'), path.join(HOME, 'Developer'), path.join(HOME, 'git'),
    path.join(HOME, 'workspace'),
  ];
  const seen = new Set();
  return candidates.filter((d) => {
    try {
      if (seen.has(d) || !fs.statSync(d).isDirectory()) return false;
      seen.add(d);
      return true;
    } catch {
      return false;
    }
  });
}

// Any path we read must live under one of these prefixes AND look like an AI-config artifact.
function allowedRoots() {
  return [path.join(HOME, '.claude'), path.join(HOME, '.config', 'opencode'), path.join(HOME, '.codex'), ...codeRoots()];
}

function isAllowedPath(p) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return false;
  }
  return allowedRoots().some((root) => {
    const r = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
    return real === r || real.startsWith(r + path.sep);
  });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
function readText(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
function preview(p, max = 140) {
  const t = readText(p);
  if (!t) return '';
  return t.replace(/\s+/g, ' ').trim().slice(0, max);
}
function tilde(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// The Claude Code project-slug is the cwd with separators flattened to dashes
// (/Users/ecodia/.code/friend -> -Users-ecodia--code-friend). Recover a short label.
function projectLabelFromSlug(slug) {
  const parts = slug.replace(/^-+/, '').split('-').filter(Boolean);
  return parts.slice(-2).join('/') || slug;
}

let _id = 0;
function mkItem(category, filePath, extra = {}) {
  const st = safeStat(filePath);
  return {
    id: `it_${_id++}`,
    category,
    path: filePath,
    display: tilde(filePath),
    title: extra.title || path.basename(filePath),
    bytes: st ? st.size : 0,
    mtime: st ? st.mtimeMs : 0,
    preview: extra.preview !== undefined ? extra.preview : preview(filePath),
    ...extra,
  };
}

// ── the scan ────────────────────────────────────────────────────────────
function scan() {
  const items = [];
  const dotClaude = path.join(HOME, '.claude');

  // 1. Global CLAUDE.md
  const globalMd = path.join(dotClaude, 'CLAUDE.md');
  if (safeStat(globalMd)) items.push(mkItem('instructions', globalMd, { title: 'CLAUDE.md (global)' }));

  // 2. Session transcripts + per-project auto-memory under ~/.claude/projects/<slug>/
  const projectsDir = path.join(dotClaude, 'projects');
  for (const proj of listDir(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const label = projectLabelFromSlug(proj.name);
    const projDir = path.join(projectsDir, proj.name);
    for (const f of listDir(projDir)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        items.push(mkItem('sessions', path.join(projDir, f.name), { title: `Session - ${label}`, project: label, preview: '' }));
      }
    }
    // per-project auto-memory
    const memDir = path.join(projDir, 'memory');
    for (const m of listDir(memDir)) {
      if (m.isFile() && /\.(md|markdown|txt)$/i.test(m.name)) {
        items.push(mkItem('memory', path.join(memDir, m.name), { title: `Memory - ${label}/${m.name}`, project: label }));
      }
    }
    const memIndex = path.join(memDir, 'MEMORY.md');
    if (safeStat(memIndex) && !items.some((i) => i.path === memIndex)) {
      items.push(mkItem('memory', memIndex, { title: `Memory index - ${label}` }));
    }
  }

  // 3. Global skills / agents / commands under ~/.claude
  collectMdDir(items, path.join(dotClaude, 'agents'), 'agents', 'Agent');
  collectMdDir(items, path.join(dotClaude, 'commands'), 'commands', 'Command');
  collectSkills(items, path.join(dotClaude, 'skills'), 'global');

  // 4. Project-level artifacts across the common code roots
  const seenProjectDirs = new Set();
  for (const root of codeRoots()) {
    walkForProjects(root, 0, items, seenProjectDirs);
  }

  // 5. opencode / codex AGENTS.md that live at the config root
  for (const p of [path.join(HOME, '.config', 'opencode', 'AGENTS.md'), path.join(HOME, '.codex', 'AGENTS.md')]) {
    if (safeStat(p)) items.push(mkItem('instructions', p, { title: `AGENTS.md (${tilde(path.dirname(p))})` }));
  }

  // Categorise + summarise
  const categories = {};
  let totalBytes = 0;
  for (const it of items) {
    categories[it.category] = (categories[it.category] || 0) + 1;
    totalBytes += it.bytes;
  }
  return { items, categories, totalBytes, home: HOME, scannedAt: new Date().toISOString() };
}

function collectMdDir(items, dir, category, titleWord) {
  for (const f of listDir(dir)) {
    if (f.isFile() && /\.(md|markdown)$/i.test(f.name)) {
      items.push(mkItem(category, path.join(dir, f.name), { title: `${titleWord}: ${f.name.replace(/\.(md|markdown)$/i, '')}` }));
    }
  }
}

// A skill can be a bare skills/<name>.md or a skills/<name>/SKILL.md dir.
function collectSkills(items, skillsDir, scope) {
  for (const entry of listDir(skillsDir)) {
    if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      items.push(mkItem('skills', path.join(skillsDir, entry.name), { title: `Skill: ${entry.name.replace(/\.(md|markdown)$/i, '')}` }));
    } else if (entry.isDirectory()) {
      for (const cand of ['SKILL.md', 'skill.md', 'README.md', `${entry.name}.md`]) {
        const p = path.join(skillsDir, entry.name, cand);
        if (safeStat(p)) {
          items.push(mkItem('skills', p, { title: `Skill: ${entry.name}` }));
          break;
        }
      }
    }
  }
}

// Recursively look for a project's AI artifacts, bounded in depth and skipping heavy dirs.
function walkForProjects(dir, depth, items, seen) {
  if (depth > WALK_MAX_DEPTH) return;
  const entries = listDir(dir);
  const names = new Set(entries.filter((e) => e.isFile() || e.isDirectory()).map((e) => e.name));

  // Project-root markers
  if (names.has('CLAUDE.md')) {
    const p = path.join(dir, 'CLAUDE.md');
    if (isFreshProjectDir(dir, seen) && depth > 0) items.push(mkItem('instructions', p, { title: `CLAUDE.md (${tilde(dir)})` }));
  }
  if (names.has('AGENTS.md')) {
    const p = path.join(dir, 'AGENTS.md');
    if (depth > 0) items.push(mkItem('instructions', p, { title: `AGENTS.md (${tilde(dir)})` }));
  }
  if (names.has('.cursorrules')) {
    const p = path.join(dir, '.cursorrules');
    if (depth > 0) items.push(mkItem('instructions', p, { title: `.cursorrules (${tilde(dir)})` }));
  }
  // Project .claude/ dir
  if (names.has('.claude')) {
    const cdir = path.join(dir, '.claude');
    const cmd = path.join(cdir, 'CLAUDE.md');
    if (safeStat(cmd)) items.push(mkItem('instructions', cmd, { title: `CLAUDE.md (${tilde(dir)}/.claude)` }));
    collectMdDir(items, path.join(cdir, 'agents'), 'agents', 'Agent');
    collectMdDir(items, path.join(cdir, 'commands'), 'commands', 'Command');
    collectSkills(items, path.join(cdir, 'skills'), 'project');
  }
  // Cursor rules dir
  const cursorRules = path.join(dir, '.cursor', 'rules');
  if (safeStat(cursorRules)) collectMdDir(items, cursorRules, 'instructions', 'Cursor rule');

  // Recurse into subdirectories (bounded)
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.cursor') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    walkForProjects(path.join(dir, e.name), depth + 1, items, seen);
  }
}

function isFreshProjectDir(dir, seen) {
  if (seen.has(dir)) return false;
  seen.add(dir);
  return true;
}

// ── parsers (mirror lib/history-import.ts, pure) ─────────────────────────
const TITLE_MAX = 90;
function firstLine(s, max = TITLE_MAX) {
  const line = String(s || '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}...` : line;
}
function textOfContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
function transcriptFromTurns(turns) {
  return turns.filter((t) => t.text.trim().length > 0).map((t) => `${t.role}: ${t.text.trim()}`).join('\n\n');
}
function parseClaudeCodeJsonl(text) {
  const order = [];
  const bySession = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const type = o.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = o.message;
    if (!message) continue;
    const body = textOfContent(message.content);
    if (!body) continue;
    const sessionId = (typeof o.sessionId === 'string' && o.sessionId) || 'session';
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, { turns: [], earliest: null, firstUser: null });
      order.push(sessionId);
    }
    const rec = bySession.get(sessionId);
    const role = type === 'user' ? 'User' : 'Assistant';
    rec.turns.push({ role, text: body });
    if (role === 'User' && !rec.firstUser) rec.firstUser = body;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
    if (ts && (!rec.earliest || ts < rec.earliest)) rec.earliest = ts;
  }
  const out = [];
  for (const sessionId of order) {
    const rec = bySession.get(sessionId);
    const transcript = transcriptFromTurns(rec.turns);
    if (!transcript) continue;
    out.push({ sessionId, title: firstLine(rec.firstUser ?? transcript), isoDate: rec.earliest ?? '', transcript });
  }
  return out;
}
function parsePlainText(id, text) {
  const body = (text || '').trim();
  if (!body) return [];
  return [{ sessionId: id, title: firstLine(body), isoDate: '', transcript: body }];
}

// ── read the selected items into ParsedSession[] ─────────────────────────
function readSessions(selected) {
  const out = [];
  for (const raw of selected || []) {
    const p = raw && typeof raw.path === 'string' ? raw.path : null;
    if (!p || !isAllowedPath(p)) continue;
    const text = readText(p);
    if (!text) continue;

    if (p.endsWith('.jsonl')) {
      const label = raw.project || projectLabelFromSlug(path.basename(path.dirname(p)));
      for (const s of parseClaudeCodeJsonl(text)) {
        const header = `Claude Code session - project ${label}${s.isoDate ? ` - ${s.isoDate.slice(0, 10)}` : ''}\n\n`;
        out.push({
          sessionId: `cc:${label}:${s.sessionId}`,
          title: `[${label}] ${s.title}`,
          isoDate: s.isoDate,
          transcript: header + s.transcript,
        });
      }
    } else {
      // A markdown/text artifact (CLAUDE.md, memory, skill, agent, command, cursor rule).
      const stableId = `file:${tilde(p)}`;
      const parsed = parsePlainText(stableId, text);
      for (const s of parsed) {
        out.push({
          sessionId: s.sessionId,
          title: raw.title || s.title,
          isoDate: '',
          transcript: `${raw.title || path.basename(p)} (${tilde(p)})\n\n${s.transcript}`,
        });
      }
    }
  }
  return out;
}

module.exports = { scan, readSessions };
