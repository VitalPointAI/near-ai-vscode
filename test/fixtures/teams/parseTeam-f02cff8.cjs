// The team-file parser of the released build f02cff8 (0.4.18 plus the download fix), copied
// verbatim from src/agent/teams.ts and src/gsd/library.ts at that commit and transpiled by hand to
// plain JavaScript. Tests use it to check that files this version writes still read safely in a
// build that predates the `privacy:` line. Do not "fix" it: it must stay exactly the old rule.
'use strict';
const path = require('node:path');

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Remember', 'Recall', 'VectorizeImage', 'RenderSvg', 'CreatePresentation'];
const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  return trimmed;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  let listKey;
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const list = Array.isArray(data[listKey]) ? data[listKey] : [];
      list.push(unquote(item[1]));
      data[listKey] = list;
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!pair) { listKey = undefined; continue; }
    listKey = pair[2] ? undefined : pair[1];
    data[pair[1]] = pair[2] ? unquote(pair[2]) : undefined;
  }
  return { data, body: text.slice(match[0].length) };
}

function parseTeam(text, file) {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '';
  if (!name) throw new Error('The team needs a name in its frontmatter (name: My team).');
  const members = [];
  const sections = body.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split(/\r?\n/);
    const memberName = slugify(heading.trim());
    if (!MEMBER_NAME.test(memberName)) throw new Error(`"${heading.trim()}" is not a usable member name.`);
    if (members.some((member) => member.name === memberName)) throw new Error(`Two members are named ${memberName}.`);
    const fields = {};
    let index = 0;
    while (index < rest.length) {
      const field = /^(role|model|tools|reports-to):\s*(.*)$/i.exec(rest[index].trim());
      if (!field) { if (rest[index].trim()) break; index += 1; continue; }
      fields[field[1].toLowerCase()] = field[2].trim();
      index += 1;
    }
    const instructions = rest.slice(index).join('\n').trim();
    if (!instructions) throw new Error(`Member ${memberName} needs instructions under its heading.`);
    const reportsTo = fields['reports-to'] ? slugify(fields['reports-to']) : undefined;
    members.push({ name: memberName, ...(fields.role ? { role: fields.role } : {}), ...(fields.model ? { model: fields.model } : {}), ...(reportsTo ? { reportsTo } : {}), tools: fields.tools ? fields.tools.split(',').map((tool) => tool.trim()).filter(Boolean) : DEFAULT_TOOLS, instructions });
  }
  if (!members.length) throw new Error('Add at least one member as a "## member-name" section.');
  if (members.length > 12) throw new Error('A team can have at most 12 members.');
  return { slug: slugify(path.basename(file, '.md')), name, description: typeof data.description === 'string' ? data.description : '', members, file };
}

module.exports = { parseTeam, DEFAULT_TOOLS };
