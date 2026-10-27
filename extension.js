import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PANEL = 'claudecode.panel';

let saturn;
let refreshTimer;
// Session summaries keyed by transcript path, reused while the file's mtime and size are unchanged.
const sessionCache = new Map();

export function activate(api) {
  saturn = api;

  saturn.commands.register('claudecode.open', ctx => launch(ctx, 'Claude Code'));
  saturn.commands.register('claudecode.continue', ctx => launch(ctx, 'Claude Code', '--continue'));
  saturn.commands.register('claudecode.resume', ctx => launch(ctx, 'Claude Code', '--resume'));
  saturn.commands.register('claudecode.usage', ctx => launch(ctx, 'Claude Usage', '/usage'));
  saturn.commands.register('claudecode.explainSelection', ctx => explain(ctx, true));
  saturn.commands.register('claudecode.explainFile', ctx => explain(ctx, false));
  saturn.commands.register('claudecode.openMemory', ctx => openOrCreate(ctx, 'CLAUDE.md', '# CLAUDE.md\n'));
  saturn.commands.register('claudecode.openSettings', ctx =>
    openOrCreate(ctx, path.join('.claude', 'settings.json'), '{}\n'),
  );
  saturn.commands.register('claudecode.checkInstall', checkInstall);
  saturn.commands.register('claudecode.refresh', () => saturn.panels.refresh(PANEL));

  saturn.panels.registerTree(PANEL, { getChildren, onAction });
  saturn.run.registerProvider(runEntries);

  saturn.workspace.onDidChangeFiles(scheduleRefresh);
  saturn.settings.onChange(scheduleRefresh);
  saturn.projects.onDidClose(ctx => {
    const dir = sessionsDir(ctx.projectPath);
    for (const key of sessionCache.keys()) if (key.startsWith(dir)) sessionCache.delete(key);
  });
}

export function deactivate() {
  clearTimeout(refreshTimer);
  sessionCache.clear();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => saturn.panels.refresh(PANEL), 300);
}

// ---- Settings and command lines ----

function setting(id, fallback) {
  const value = saturn.settings.get(id);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function quote(arg) {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (saturn.platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function claudeCommand(...args) {
  const parts = [setting('claudePath', 'claude')];
  const model = setting('model', '');
  const mode = setting('permissionMode', '');
  if (model) parts.push('--model', model);
  if (mode) parts.push('--permission-mode', mode);
  parts.push(...args);
  const line = parts.map(quote).join(' ');
  const extra = setting('extraArgs', '').trim();
  return extra ? `${line} ${extra}` : line;
}

function runEntries(ctx) {
  const entries = [
    { name: 'Claude Code', command: claudeCommand() },
    { name: 'Claude Code: Continue Last Session', command: claudeCommand('--continue') },
    { name: 'Claude Code: Resume Session…', command: claudeCommand('--resume') },
    { name: 'Claude Code: Usage', command: claudeCommand('/usage') },
  ];
  if (ctx?.projectPath) {
    for (const s of recentSessions(ctx.projectPath)) {
      entries.push({ name: `Claude Code: Resume "${s.title}"`, command: claudeCommand('--resume', s.id) });
    }
  }
  return entries;
}

function launch(ctx, name, ...args) {
  if (!ctx?.projectPath) {
    saturn.window.showMessage('Open a project first.', { kind: 'warning' });
    return;
  }
  if (!saturn.terminal?.run) {
    saturn.window.showMessage('This version of Saturn cannot open terminals from extensions. Use the Run menu.', {
      kind: 'warning',
      projectPath: ctx.projectPath,
    });
    return;
  }
  saturn.terminal.run(ctx.projectPath, { name, command: claudeCommand(...args) });
}

// ---- Editor context ----

// The active file as an @-mention Claude Code understands, with the selected lines when there are any.
function activeFileMention(ctx, withSelection) {
  if (!ctx?.projectPath) {
    saturn.window.showMessage('Open a project first.', { kind: 'warning' });
    return null;
  }
  const file = saturn.editor?.activeFile(ctx.projectPath);
  if (!file) {
    const why = saturn.editor ? 'Open a file first.' : 'This version of Saturn does not share editor state with extensions.';
    saturn.window.showMessage(why, { kind: 'warning', projectPath: ctx.projectPath });
    return null;
  }
  let mention = `@${path.relative(ctx.projectPath, file.path).split(path.sep).join('/')}`;
  const sel = file.selection;
  if (withSelection && sel && sel.text) {
    const start = sel.start.line + 1;
    // A selection ending at the start of a line doesn't include that line.
    const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    mention += start === end ? `#L${start}` : `#L${start}-${end}`;
  }
  if (file.dirty) {
    saturn.window.showMessage('The file has unsaved changes; Claude Code reads the saved version.', {
      kind: 'warning',
      projectPath: ctx.projectPath,
    });
  }
  return mention;
}

function explain(ctx, withSelection) {
  const mention = activeFileMention(ctx, withSelection);
  if (mention) launch(ctx, 'Claude Code', `Explain ${mention}`);
}

function checkInstall(ctx) {
  const bin = setting('claudePath', 'claude');
  execFile(bin, ['--version'], { timeout: 10000 }, (err, stdout) => {
    if (err) {
      saturn.window.showMessage(`Claude Code CLI not found (${bin}). Install with npm i -g @anthropic-ai/claude-code`, {
        kind: 'error',
        projectPath: ctx?.projectPath,
      });
    } else {
      saturn.window.showMessage(`Claude Code ${stdout.trim()}`, { kind: 'info', projectPath: ctx?.projectPath });
    }
  });
}

// ---- Project files ----

function openOrCreate(ctx, relPath, initial) {
  if (!ctx?.projectPath) {
    saturn.window.showMessage('Open a project first.', { kind: 'warning' });
    return;
  }
  const file = path.join(ctx.projectPath, relPath);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, initial);
    saturn.window.showMessage(`Created ${relPath}`, { projectPath: ctx.projectPath });
    scheduleRefresh();
  }
  saturn.workspace.openFile(ctx.projectPath, file);
}

function listMarkdown(dir, recursive) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && recursive) files.push(...listMarkdown(full, true));
    else if (e.isFile() && e.name.endsWith('.md')) files.push(full);
  }
  return files.sort();
}

function listSkills(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map(e => ({ name: e.name, file: path.join(dir, e.name, 'SKILL.md') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---- Sessions ----

// Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric character as '-'>.
function sessionsDir(projectPath) {
  return path.join(os.homedir(), '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(c => c?.type === 'text')?.text ?? '';
  return '';
}

function summarise(file, stat) {
  const cached = sessionCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;

  let title = '';
  let prompt = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
    else if (entry.type === 'ai-title' && entry.aiTitle && !title) title = entry.aiTitle;
    else if (entry.type === 'user' && !prompt && !entry.isSidechain && entry.origin?.kind !== 'hook') {
      const text = promptText(entry.message?.content).trim();
      if (text && !text.startsWith('<')) prompt = text;
    }
  }
  const summary = {
    id: path.basename(file, '.jsonl'),
    title: (title || prompt.split('\n')[0] || 'Untitled session').slice(0, 80),
    prompt,
    modified: stat.mtimeMs,
  };
  sessionCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

function recentSessions(projectPath) {
  const limit = Number(setting('recentSessions', '5')) || 0;
  if (!limit) return [];
  const dir = sessionsDir(projectPath);
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter(n => n.endsWith('.jsonl'))
      .map(n => {
        const file = path.join(dir, n);
        return { file, stat: fs.statSync(file) };
      });
  } catch {
    return [];
  }
  return files
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, limit)
    .map(({ file, stat }) => {
      try {
        return summarise(file, stat);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function relativeTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---- Panel ----

function fileItem(id, label, file, description) {
  return { id, label, hasChildren: false, open: { path: file }, description, tooltip: file };
}

function group(id, label, count) {
  return { id, label, hasChildren: count > 0, description: String(count) };
}

function getChildren(parentId, ctx) {
  const root = ctx?.projectPath;
  if (!root) return [];
  const claudeDir = path.join(root, '.claude');

  switch (parentId ?? null) {
    case null: {
      const mcp = readJson(path.join(root, '.mcp.json'))?.mcpServers ?? {};
      return [
        { id: 'project', label: 'Project', hasChildren: true },
        group('commands', 'Commands', listMarkdown(path.join(claudeDir, 'commands'), true).length),
        group('agents', 'Agents', listMarkdown(path.join(claudeDir, 'agents'), false).length),
        group('skills', 'Skills', listSkills(path.join(claudeDir, 'skills')).length),
        group('mcp', 'MCP Servers', Object.keys(mcp).length),
        group('sessions', 'Recent Sessions', recentSessions(root).length),
      ];
    }

    case 'project': {
      const items = [];
      const memory = path.join(root, 'CLAUDE.md');
      if (fs.existsSync(memory)) items.push(fileItem('file:CLAUDE.md', 'CLAUDE.md', memory, 'project memory'));
      else
        items.push({
          id: 'missing:CLAUDE.md',
          label: 'CLAUDE.md',
          hasChildren: false,
          description: 'not created',
          actions: [{ id: 'createMemory', label: 'Create CLAUDE.md' }],
        });
      const optional = [
        ['CLAUDE.local.md', 'personal memory'],
        [path.join('.claude', 'settings.json'), 'shared settings'],
        [path.join('.claude', 'settings.local.json'), 'local settings'],
        ['.mcp.json', 'MCP config'],
      ];
      for (const [rel, description] of optional) {
        const file = path.join(root, rel);
        if (fs.existsSync(file)) items.push(fileItem(`file:${rel}`, path.basename(rel), file, description));
      }
      return items;
    }

    case 'commands': {
      const dir = path.join(claudeDir, 'commands');
      return listMarkdown(dir, true).map(file => {
        const name = path.relative(dir, file).slice(0, -3).split(path.sep).join(':');
        return fileItem(`command:${name}`, `/${name}`, file);
      });
    }

    case 'agents':
      return listMarkdown(path.join(claudeDir, 'agents'), false).map(file =>
        fileItem(`agent:${file}`, path.basename(file, '.md'), file),
      );

    case 'skills':
      return listSkills(path.join(claudeDir, 'skills')).map(s => fileItem(`skill:${s.name}`, s.name, s.file));

    case 'mcp': {
      const file = path.join(root, '.mcp.json');
      const servers = readJson(file)?.mcpServers ?? {};
      return Object.entries(servers).map(([name, cfg]) => ({
        ...fileItem(`mcp:${name}`, name, file, cfg?.type ?? (cfg?.url ? 'http' : 'stdio')),
        tooltip: cfg?.url ?? [cfg?.command, ...(cfg?.args ?? [])].filter(Boolean).join(' '),
      }));
    }

    case 'sessions':
      return recentSessions(root).map(s => ({
        id: `session:${s.id}`,
        label: s.title,
        hasChildren: false,
        description: relativeTime(s.modified),
        tooltip: s.prompt ? s.prompt.slice(0, 300) : s.title,
        actions: [{ id: 'resume', label: 'Resume' }],
      }));

    default:
      return [];
  }
}

function onAction(actionId, item, ctx) {
  if (actionId === 'createMemory') openOrCreate(ctx, 'CLAUDE.md', '# CLAUDE.md\n');
  else if (actionId === 'resume' && item.id.startsWith('session:')) {
    launch(ctx, `Claude Code: ${item.label}`, '--resume', item.id.slice('session:'.length));
  }
}
