'use strict';
// Ported from agentic v0.5.8 (a4ba285), plugin/lib/tokenize.js. The logic is unchanged.
// Small shell tokenizer: quotes, escapes, operators, redirects, heredocs, $() and backticks.
// It does not execute or expand anything. Unknown $VARs are reported so callers can ask.

const OPS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n'];

function tokenize(input, depth) {
  depth = depth || 0;
  const src = String(input || '');
  const segments = [];
  let seg = newSeg();
  let word = null; // { text, hasVar, quoted }
  let i = 0;
  let pendingRedirect = null; // '>' | '<'
  const heredocs = []; // delimiters waiting for the next newline

  function newSeg() { return { argv: [], vars: [], redirects: [], inputs: [], heredoc: '', text: '' }; }
  function startWord() { if (!word) word = { text: '', hasVar: false, quoted: false, parens: 0 }; }
  function endWord() {
    if (!word) return;
    if (pendingRedirect === '>') seg.redirects.push(word.text);
    else if (pendingRedirect === '<') seg.inputs.push(word.text);
    else if (pendingRedirect === 'heredoc') heredocs.push({ delim: word.text, strip: false, seg });
    else if (pendingRedirect === 'heredoc-') heredocs.push({ delim: word.text, strip: true, seg });
    // Reserved words (`then rm x`, `{ cd x; }`) count only as a whole unquoted word in command position; `{}` and `x}`
    // are arguments. A function body (`f() {`, `function f {`) starts a new segment.
    else if (!word.quoted && RESERVED.has(word.text) && !seg.argv.length) { /* not a command */ }
    else if (!word.quoted && word.text === '{' && funcHead(seg.argv)) { word = null; endSeg(); return; }
    else { seg.argv.push(word.text); seg.vars.push(word.hasVar); }
    pendingRedirect = null;
    word = null;
  }
  function endSeg(rawEnd) {
    endWord();
    pendingRedirect = null;
    seg.text = seg.text.trim();
    if (seg.argv.length || seg.redirects.length) segments.push(seg);
    seg = newSeg();
  }
  function captureBalanced(open, close, start) {
    // returns [content, nextIndex]; respects quotes
    let level = 1, j = start, q = null;
    while (j < src.length) {
      const c = src[j];
      if (q) { if (c === '\\' && q === '"') { j += 2; continue; } if (c === q) q = null; j++; continue; }
      if (c === "'" || c === '"') { q = c; j++; continue; }
      if (c === '\\') { j += 2; continue; }
      if (src.startsWith(open, j)) { level++; j += open.length; continue; }
      if (c === close) { level--; if (level === 0) return [src.slice(start, j), j + 1]; }
      j++;
    }
    return [src.slice(start), src.length];
  }
  function nested(content) {
    if (depth > 6) return;
    for (const s of tokenize(content, depth + 1)) segments.push(s);
  }

  while (i < src.length) {
    const c = src[i];
    // heredoc bodies start after the newline that ends the command line
    if (c === '\n' && (heredocs.length || (word && pendingRedirect && pendingRedirect.startsWith('heredoc')))) {
      endWord();
      const owner = seg; endSeg();
      i++;
      while (heredocs.length) {
        const h = heredocs.shift();
        let body = '';
        while (i < src.length) {
          let nl = src.indexOf('\n', i); if (nl < 0) nl = src.length;
          const line = src.slice(i, nl);
          i = nl + 1;
          const cmp = h.strip ? line.replace(/^\t+/, '') : line;
          if (cmp === h.delim) break;
          body += line + '\n';
        }
        h.seg.heredoc += body;
      }
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      startWord(); word.text += src[i + 1] || ''; seg.text += src.slice(i, i + 2); i += 2; continue;
    }
    if (c === "'") {
      startWord(); word.quoted = true;
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word.text += src.slice(i + 1, end); seg.text += src.slice(i, end + 1); i = end + 1; continue;
    }
    if (c === '"') {
      startWord(); word.quoted = true;
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        // inside double quotes a backslash escapes only `$`, backtick, `"`, `\` and newline; before anything else it stays
        if (src[j] === '\\' && src[j + 1] === '\n') { j += 2; continue; }
        if (src[j] === '\\' && j + 1 < src.length) { if (!/[$`"\\\n]/.test(src[j + 1])) word.text += '\\'; word.text += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { const [inner, nx] = captureBalanced('$(', ')', j + 2); nested(inner); word.text += '$(...)'; word.hasVar = true; j = nx; continue; }
        if (src[j] === '`') { const k = src.indexOf('`', j + 1); const e = k < 0 ? src.length : k; nested(src.slice(j + 1, e)); word.text += '`...`'; word.hasVar = true; j = e + 1; continue; }
        if (src[j] === '$' && /[A-Za-z_{]/.test(src[j + 1] || '')) word.hasVar = true;
        word.text += src[j];
        j++;
      }
      seg.text += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const [inner, nx] = captureBalanced('$(', ')', i + 2); nested(inner);
      startWord(); word.text += '$(...)'; word.hasVar = true; seg.text += src.slice(i, nx); i = nx; continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') { // process substitution runs its own commands
      const [inner, nx] = captureBalanced('(', ')', i + 2); nested(inner);
      startWord(); word.text += c + '(...)'; word.hasVar = true; seg.text += src.slice(i, nx); i = nx; continue;
    }
    if (c === '`') {
      const k = src.indexOf('`', i + 1); const e = k < 0 ? src.length : k;
      nested(src.slice(i + 1, e)); startWord(); word.text += '`...`'; word.hasVar = true; seg.text += src.slice(i, e + 1); i = e + 1; continue;
    }
    if (c === '#' && !word) { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === ' ' || c === '\t') { endWord(); seg.text += c; i++; continue; }
    // redirects and heredocs
    const rd = /^(\d*|&)(>>|>\||>&|>|<<-|<<<|<<|<&|<)/.exec(src.slice(i));
    if (rd && (!word || /^\d+$/.test(word.text))) {
      if (word && /^\d+$/.test(word.text)) word = null; // fd number
      else endWord();
      const op = rd[2];
      i += rd[0].length; seg.text += rd[0];
      if (op === '>&' || op === '<&') { // 2>&1 style: skip the fd word; a file name is read as a normal word
        const m = /^[ \t]*(\d+|-)(?=$|[\s;&|()<>])/.exec(src.slice(i));
        if (m) { i += m[0].length; seg.text += m[0]; continue; }
        pendingRedirect = op === '>&' ? '>' : '<';
        continue;
      }
      if (op === '<<') pendingRedirect = 'heredoc';
      else if (op === '<<-') pendingRedirect = 'heredoc-';
      else if (op === '<<<') pendingRedirect = '<';
      else if (op[0] === '<') pendingRedirect = '<';
      else pendingRedirect = '>';
      continue;
    }
    // an unquoted `(` inside an argument opens a zsh glob group (`(a|b)`, `*(.)`, `f()`): its `|` and `)` stay in the word
    const inGroup = word && word.parens > 0;
    if (c === '|' && inGroup) { word.text += c; seg.text += c; i++; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { endSeg(); i += op.length; continue; }
    if (c === '(' && !word && (!seg.argv.length || funcHead(seg.argv))) { endSeg(); i++; continue; } // a subshell
    if (c === '(') { startWord(); word.parens++; word.text += c; seg.text += c; i++; continue; }
    if (c === ')' && inGroup) { word.parens--; word.text += c; seg.text += c; i++; continue; }
    if (c === ')') { endSeg(); i++; continue; } // closes a subshell or a case pattern
    if (c === '$' && /[A-Za-z_{]/.test(src[i + 1] || '')) { startWord(); word.hasVar = true; }
    startWord(); word.text += c; seg.text += c; i++;
  }
  endSeg();
  return segments;
}

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
// `f()` or `function f` before a body
function funcHead(argv) { return (argv.length === 1 && /^[^()]+\(\)$/.test(argv[0])) || (argv.length === 2 && argv[0] === 'function'); }

const SKIP_WITH_ARG = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'],
  env: ['-u', '-C', '-S'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'],
  nice: ['-n'],
  timeout: ['-s', '-k'],
  npx: ['-p', '--package'],
  conda: ['-n', '-p', '--name', '--prefix'],
};
const SIMPLE_WRAPPERS = new Set(['sudo', 'env', 'exec', 'command', 'nohup', 'time', 'nice', 'timeout', 'stdbuf', 'caffeinate', 'xargs', 'npx', 'bunx', 'pnpx', 'doas']);
const TWO_WORD = { bundle: 'exec', poetry: 'run', uv: 'run', pipenv: 'run', pdm: 'run', rye: 'run', hatch: 'run', conda: 'run', pnpm: 'dlx', yarn: 'dlx', npm: 'exec' };
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

function base(cmd) { return String(cmd || '').split('/').pop(); }

// Removes wrappers and expands `bash -c '...'` / `eval '...'` into real segments.
function unwrap(seg, depth) {
  depth = depth || 0;
  let argv = seg.argv.slice();
  let vars = seg.vars.slice();
  const env = Object.assign({}, seg.env || {});
  for (let guard = 0; guard < 12 && argv.length; guard++) {
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
      const k = argv[0].split('=')[0]; env[k] = argv[0].slice(k.length + 1); argv.shift(); vars.shift();
    }
    if (!argv.length) break;
    const b = base(argv[0]);
    if (SHELLS.has(b)) {
      const ci = argv.findIndex((a, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (ci > 0 && argv[ci + 1] !== undefined && depth < 6) {
        return [].concat(...tokenize(argv[ci + 1]).map((s) => unwrap(Object.assign(s, { env }), depth + 1)));
      }
      break;
    }
    if (b === 'eval' && depth < 6) {
      return [].concat(...tokenize(argv.slice(1).join(' ')).map((s) => unwrap(Object.assign(s, { env }), depth + 1)));
    }
    if (TWO_WORD[b] && argv[1] === TWO_WORD[b]) {
      argv = argv.slice(2); vars = vars.slice(2);
      while (argv.length && argv[0].startsWith('-')) { const f = argv.shift(); vars.shift(); if ((SKIP_WITH_ARG[b] || []).includes(f)) { argv.shift(); vars.shift(); } }
      if (argv[0] === '--') { argv.shift(); vars.shift(); }
      continue;
    }
    if (SIMPLE_WRAPPERS.has(b)) {
      argv.shift(); vars.shift();
      const withArg = SKIP_WITH_ARG[b] || [];
      while (argv.length && (argv[0].startsWith('-') || (b === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])))) {
        const f = argv.shift(); vars.shift();
        if (b === 'env' && /=/.test(f) && !f.startsWith('-')) { const k = f.split('=')[0]; env[k] = f.slice(k.length + 1); continue; }
        if (withArg.includes(f)) { argv.shift(); vars.shift(); }
        if (f === '--') break;
      }
      if (b === 'timeout' && argv.length && /^\d/.test(argv[0])) { argv.shift(); vars.shift(); }
      if (b === 'nice' && argv.length && /^-?\d+$/.test(argv[0])) { argv.shift(); vars.shift(); }
      continue;
    }
    break;
  }
  return [{ argv, vars, env, redirects: seg.redirects, inputs: seg.inputs, heredoc: seg.heredoc, text: seg.text }];
}

function parse(command) {
  const out = [];
  for (const s of tokenize(command)) for (const u of unwrap(s)) if (u.argv.length || u.redirects.length) out.push(u);
  return out;
}

module.exports = { tokenize, unwrap, parse, base };
