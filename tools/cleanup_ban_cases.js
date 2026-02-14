const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..');
const MODLOGS_PATH = path.join(DATA_DIR, 'modlogs.json');
const ACTIONS_MD_PATH = path.join(DATA_DIR, 'actions.md');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function normalizeReason(reason) {
  const r = String(reason || '').trim();
  return r || 'No reason provided';
}

function ensurePermPrefix(reason) {
  const r = normalizeReason(reason);
  if (/^perm\b/i.test(r)) return r;
  return `Perm ${r}`;
}

function cleanupModlogs(modlogs) {
  const cases = Array.isArray(modlogs.cases) ? modlogs.cases.slice() : [];

  // Sort stable by time then caseId
  cases.sort((a, b) => {
    const ta = Number(a?.time || 0);
    const tb = Number(b?.time || 0);
    if (ta !== tb) return ta - tb;
    return Number(a?.caseId || 0) - Number(b?.caseId || 0);
  });

  const seen = new Map();
  const dupCaseIds = new Set();
  const WINDOW_MS = 120_000; // 2 minutes

  for (const c of cases) {
    if (!c || String(c.type || '') !== 'Ban') continue;
    const guildId = c.guildId ? String(c.guildId) : '';
    const user = c.user ? String(c.user) : '';
    const moderator = c.moderator ? String(c.moderator) : '';
    const reasonNorm = normalizeReason(c.reason).toLowerCase();
    const key = `${guildId}|${user}|${moderator}|${reasonNorm}`;
    const t = Number(c.time || 0);

    const prev = seen.get(key);
    if (prev && Math.abs(t - prev.time) <= WINDOW_MS) {
      // Duplicate ban record; remove the later one.
      dupCaseIds.add(Number(c.caseId));
      continue;
    }
    seen.set(key, { time: t, caseId: Number(c.caseId) });
  }

  // Apply updates and filter out duplicates
  const updated = [];
  let permUpdatedCount = 0;
  let dupRemovedCount = 0;

  for (const c of cases) {
    if (!c) continue;
    const cid = Number(c.caseId);
    if (dupCaseIds.has(cid)) {
      dupRemovedCount += 1;
      continue;
    }
    if (String(c.type || '') === 'Ban') {
      const newReason = ensurePermPrefix(c.reason);
      if (newReason !== String(c.reason || '')) {
        c.reason = newReason;
        permUpdatedCount += 1;
      }
    }
    updated.push(c);
  }

  // Restore original ordering (caseId ascending) for readability
  updated.sort((a, b) => Number(a?.caseId || 0) - Number(b?.caseId || 0));

  modlogs.cases = updated;

  return { dupCaseIds, permUpdatedCount, dupRemovedCount };
}

function cleanupActionsMd(dupCaseIds) {
  if (!fs.existsSync(ACTIONS_MD_PATH)) return { removedBlocks: 0, permUpdatedLines: 0 };
  const raw = fs.readFileSync(ACTIONS_MD_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);

  let removedBlocks = 0;
  let permUpdatedLines = 0;

  const isDupCaseLine = (line) => {
    const m = line.match(/^- Case:\s*(\d+)\s*$/);
    if (!m) return false;
    const id = Number(m[1]);
    return dupCaseIds.has(id);
  };

  // Remove blocks that contain "- Case: <dupId>". Block is from a line that starts with "## "
  // up to (and including) the following blank line.
  const out = [];
  let currentType = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      currentType = null;
    }

    if (line.startsWith('- Type: ')) {
      currentType = line.slice('- Type: '.length).trim();
    }

    // If we are at a heading, look ahead for a dup case line before the next heading.
    if (line.startsWith('## ')) {
      let j = i;
      let hasDup = false;
      for (j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('## ')) break;
        if (isDupCaseLine(lines[j])) { hasDup = true; break; }
      }
      if (hasDup) {
        removedBlocks += 1;
        // Skip until next blank line after this heading-block.
        let k = i;
        for (k = i; k < lines.length; k++) {
          if (k !== i && lines[k].startsWith('## ')) break;
          // If there's an empty line, we can stop skipping after it.
          if (lines[k].trim() === '' && k > i) { k++; break; }
        }
        i = k - 1;
        continue;
      }
    }

    // Update reason lines only for Ban entries in modlog-style format
    if (line.startsWith('- Reason: ') && String(currentType || '') === 'Ban') {
      const rest = line.slice('- Reason: '.length);
      // Split by the last occurrence of " - " (timestamp delimiter)
      const idx = rest.lastIndexOf(' - ');
      if (idx > -1) {
        const reasonPart = rest.slice(0, idx);
        const tail = rest.slice(idx); // includes leading " - "
        if (!/^Perm\b/i.test(reasonPart.trim())) {
          const newLine = `- Reason: Perm ${reasonPart.trim()}${tail}`;
          out.push(newLine);
          permUpdatedLines += 1;
          continue;
        }
      } else {
        // No timestamp tail; still enforce perm prefix
        if (!/^Perm\b/i.test(rest.trim())) {
          out.push(`- Reason: Perm ${rest.trim()}`);
          permUpdatedLines += 1;
          continue;
        }
      }
    }

    out.push(line);
  }

  if (out.join('\n') !== raw.replace(/\r?\n/g, '\n')) {
    fs.writeFileSync(ACTIONS_MD_PATH, out.join('\n'), 'utf8');
  }

  return { removedBlocks, permUpdatedLines };
}

function main() {
  const modlogs = readJson(MODLOGS_PATH);
  if (!modlogs || typeof modlogs !== 'object') throw new Error('modlogs.json invalid');

  const { dupCaseIds, permUpdatedCount, dupRemovedCount } = cleanupModlogs(modlogs);
  writeJson(MODLOGS_PATH, modlogs);

  const { removedBlocks, permUpdatedLines } = cleanupActionsMd(dupCaseIds);

  const dupIdsList = Array.from(dupCaseIds).sort((a, b) => a - b);

  console.log(JSON.stringify({
    updated: true,
    duplicatesRemoved: dupRemovedCount,
    duplicateCaseIds: dupIdsList,
    banReasonsPermPrefixed: permUpdatedCount,
    actionsMdBlocksRemoved: removedBlocks,
    actionsMdReasonLinesUpdated: permUpdatedLines,
  }, null, 2));
}

main();
