// solve.js — site-generator v11 (hybrid).
// Keeps v10's minimal frame (tiny file, no regex, no eval/new Function,
// templates as flat op arrays, += output) and replaces the three
// dispatch-heavy hot paths with flat range-based loops (v4's proven
// technique): (a) a single-pass inline renderer with an explicit stack —
// no slice() per construct, no recursion into emphasis/link content;
// (b) template paths pre-resolved at parse time to a binding
// (top-level ctx / loop var / loop object) with reusable loop frames —
// no scope-chain walk, no scope object allocated per iteration;
// (c) closer search bounded by the innermost open frame, so nested
// emphasis never re-scans text outside its own span.
// Written fresh from the makefun-site README spec + the v10 study
// (per-phase A/B: markdown is the largest cost no architecture has
// removed; v10's warm run rose +79 ms on dispatch per operation).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------- text ----------
function esc(s) {
  let o = '', j = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { o += s.slice(j, i) + '&amp;'; j = i + 1; }
    else if (c === 60) { o += s.slice(j, i) + '&lt;'; j = i + 1; }
    else if (c === 62) { o += s.slice(j, i) + '&gt;'; j = i + 1; }
    else if (c === 34) { o += s.slice(j, i) + '&quot;'; j = i + 1; }
    else if (c === 39) { o += s.slice(j, i) + '&#39;'; j = i + 1; }
  }
  return j === 0 ? s : o + s.slice(j);
}

function escRange(s, a, b) {
  let o = '', j = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { o += s.slice(j, i) + '&amp;'; j = i + 1; }
    else if (c === 60) { o += s.slice(j, i) + '&lt;'; j = i + 1; }
    else if (c === 62) { o += s.slice(j, i) + '&gt;'; j = i + 1; }
    else if (c === 34) { o += s.slice(j, i) + '&quot;'; j = i + 1; }
    else if (c === 39) { o += s.slice(j, i) + '&#39;'; j = i + 1; }
  }
  return j === a ? s.slice(a, b) : o + s.slice(j, b);
}

function isMark(cp) {
  return (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05BD) || (cp >= 0x0610 && cp <= 0x061A) ||
    (cp >= 0x064B && cp <= 0x065F) || cp === 0x0670 || (cp >= 0x06D6 && cp <= 0x06DC) ||
    (cp >= 0x1AB0 && cp <= 0x1AFF) || (cp >= 0x1DC0 && cp <= 0x1DFF) ||
    (cp >= 0x20D0 && cp <= 0x20FF) || (cp >= 0xFE20 && cp <= 0xFE2F);
}

function slugOf(s) {
  const n = s.normalize('NFKD');
  let o = '', dash = false;
  for (let i = 0; i < n.length;) {
    const cp = n.codePointAt(i);
    i += cp > 0xFFFF ? 2 : 1;
    if ((cp >= 48 && cp <= 57) || (cp >= 97 && cp <= 122)) { o += String.fromCodePoint(cp); dash = false; }
    else if (cp >= 65 && cp <= 90) { o += String.fromCharCode(cp + 32); dash = false; }
    else if (isMark(cp)) { /* drop combining mark */ }
    else if (o.length && !dash) { o += '-'; dash = true; }
  }
  if (o.endsWith('-')) o = o.slice(0, -1);
  if (o.length > 64) { o = o.slice(0, 64); if (o.endsWith('-')) o = o.slice(0, -1); }
  return o || 'untitled';
}

function dateLong(d) {
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

function isBlank(ln) {
  for (let i = 0; i < ln.length; i++) {
    const c = ln.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trim(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function dropTrail(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(0, b);
}

// ---------- front matter ----------
function isKey(k) {
  if (!k.length) return false;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

function checkVal(key, v) {
  if (key === 'title' || key === 'summary') {
    if (v.charCodeAt(0) === 34) { // quoted
      let o = '', j = 1;
      while (j < v.length) {
        const c = v.charCodeAt(j);
        if (c === 92) {
          const d = v.charCodeAt(j + 1);
          if (d === 34 || d === 92) { o += v[j + 1]; j += 2; }
          else return { err: 'a quoted string is not closed' };
        } else if (c === 34) {
          if (j === v.length - 1) return { val: o };
          return { err: 'a quoted string is not closed' };
        } else { o += v[j]; j++; }
      }
      return { err: 'a quoted string is not closed' };
    }
    if (v.charCodeAt(0) === 91) return { err: 'a bare string opens on [' };
    return { val: v };
  }
  if (key === 'date') {
    if (v.length === 10 && v.charCodeAt(4) === 45 && v.charCodeAt(7) === 45) {
      let ok = true;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = v.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      if (ok) {
        const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
        if (y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)) return { val: v };
      }
    }
    return { err: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (v.length < 2 || v.charCodeAt(0) !== 91 || v.charCodeAt(v.length - 1) !== 93) return { err: 'not a list [a, b]' };
    const inner = v.slice(1, -1);
    if (trim(inner) === '') return { val: [] };
    const parts = inner.split(',');
    const out = [];
    for (let p of parts) {
      p = trim(p);
      if (p === '') return { err: 'an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (c === 34 || c === 91 || c === 93) return { err: 'an empty tag, or one holding " [ or ]' };
      }
      out.push(p);
    }
    return { val: out };
  }
  if (key === 'draft') {
    if (v === 'true') return { val: true };
    if (v === 'false') return { val: false };
    return { err: 'true or false' };
  }
  if (key === 'layout') {
    if (!v.length) return { err: 'not a template name' };
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { err: 'not a template name' };
    }
    return { val: v };
  }
  if (key === 'slug') {
    if (!v.length || v.length > 64) return { err: 'not a slug' };
    let prevDash = false;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 45) {
        if (i === 0 || i === v.length - 1 || prevDash) return { err: 'not a slug' };
        prevDash = true;
      } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
      else return { err: 'not a slug' };
    }
    return { val: v };
  }
  return { err: 'unknown key "' + key + '"' };
}

const FM_KEYS = { title: 1, summary: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1 };

function parseFM(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { err: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { err: 'the front matter is not closed' };
  const fm = {};
  for (let i = 1; i < close; i++) {
    const ln = lines[i];
    if (isBlank(ln)) continue;
    if (ln.charCodeAt(0) === 35) continue; // '#'
    const c = ln.indexOf(':');
    if (c < 1) return { err: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = ln.slice(0, c);
    if (!isKey(key)) return { err: 'line ' + (i + 1) + ' is not "key: value"' };
    const rest = ln.slice(c + 1);
    if (rest === '') return { err: 'key "' + key + '" has no value' };
    if (rest.charCodeAt(0) !== 32) return { err: 'line ' + (i + 1) + ' is not "key: value"' };
    const v = dropTrail(rest.slice(1));
    if (!FM_KEYS[key]) return { err: 'unknown key "' + key + '"' };
    if (Object.hasOwn(fm, key)) return { err: 'key "' + key + '" is given twice' };
    if (v === '') return { err: 'key "' + key + '" has no value' };
    const r = checkVal(key, v);
    if (r.err) return { err: 'key "' + key + '": ' + r.err };
    fm[key] = r.val;
  }
  if (!Object.hasOwn(fm, 'title')) return { err: 'no title' };
  return { fm, bodyStart: close + 1 };
}

// ---------- markdown ----------
function isEscaped(s, pos) {
  let k = 0;
  for (let p = pos - 1; p >= 0 && s.charCodeAt(p) === 92; p--) k++;
  return (k & 1) === 1;
}

// Closer search, bounded by `limit` (the innermost open frame's close
// position, or the line length): a nested opener can never claim a closer
// past its enclosing construct — the same bound the old recursive
// renderer got from slicing the content. Matching rules are unchanged:
// strong closer = next unescaped '**' whose content is non-empty and
// holds no unescaped '**' pair (a single '*' inside is fine); a closer
// candidate rejected for empty content is skipped as a unit (search
// resumes at k+2), one rejected because its first star is escaped is
// skipped by one (its partner may still close).
function findStrong(s, from, limit) {
  let k = s.indexOf('**', from);
  while (k !== -1 && k < limit) {
    if (k === from) { k = s.indexOf('**', k + 2); continue; } // empty content: skip the pair as a unit
    if (isEscaped(s, k)) { k = s.indexOf('**', k + 1); continue; } // escaped first star: its partner may still close
    for (let p = from; p < k - 1; p++) {
      if (s.charCodeAt(p) === 42 && s.charCodeAt(p + 1) === 42 && !isEscaped(s, p)) return -1;
    }
    return k;
  }
  return -1;
}

function findEm(s, from, limit) {
  let k = s.indexOf('*', from);
  while (k !== -1 && k < limit) {
    if (isEscaped(s, k)) { k = s.indexOf('*', k + 1); continue; }
    if (s.charCodeAt(k + 1) === 42) { k = s.indexOf('*', k + 2); continue; }
    return k;
  }
  return -1;
}

function resolveHref(t, cx) {
  const c0 = t.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return t; // '/' or '#'
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let p = 1;
    while (p < t.length) {
      const c = t.charCodeAt(p);
      if (c === 58) return t; // scheme ':'
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { p++; continue; }
      break;
    }
  }
  let frag = '', path = t;
  const h = t.indexOf('#');
  if (h !== -1) { frag = t.slice(h); path = t.slice(0, h); }
  const parts = path.split('/');
  const stack = cx.dir ? cx.dir.split('/') : [];
  for (let q = 0; q < parts.length; q++) {
    const seg = parts[q];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  const resolved = stack.join('/');
  const url = cx.pageMap.get(resolved);
  if (url !== undefined) return url + frag;
  if (cx.staticSet.has(resolved)) return cx.base + '/' + resolved + frag;
  cx.report.add('broken-link ' + cx.src + ' -> ' + t);
  return t;
}

// Flat single-pass inline renderer. One charCodeAt loop over the line;
// an explicit stack of open frames replaces the old recursion into
// sliced emphasis/link content. Frame = [closePos, kind, resume]:
// kind 0 = <strong> (closes with 2 chars), 1 = <em> (1 char),
// 2 = <a> (closes at ']' and resumes past ')').
// The stack is reused across calls via cx.istack (calls are sequential).
function inl(s, cx) {
  let o = '', i = 0, j = 0;
  const n = s.length;
  const stack = cx.istack;
  stack.length = 0;
  // Scalar close position: reading stack[stack.length - 1] on EVERY char
  // costs ~4x under --no-opt (the array-element load dominates the loop).
  // The stack itself is touched only on push / pop / close.
  let closePos = -1;
  while (i < n) {
    if (closePos === i) {
      const top = stack[stack.length - 1];
      o += s.slice(j, i);
      if (top[1] === 2) { o += '</a>'; i = top[2]; }
      else if (top[1] === 0) { o += '</strong>'; i += 2; }
      else { o += '</em>'; i += 1; }
      stack.pop();
      closePos = stack.length ? stack[stack.length - 1][0] : -1;
      j = i;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const d = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (d === 96 || d === 42 || d === 95 || d === 91 || d === 93 || d === 40 || d === 41 || d === 35 || d === 43 || d === 45 || d === 46 || d === 33 || d === 62 || d === 92) {
        o += s.slice(j, i);
        if (d === 62) o += '&gt;';
        else if (d === 34) o += '&quot;';
        else if (d === 39) o += '&#39;';
        else o += s[i + 1];
        i += 2; j = i;
      } else i++;
    } else if (c === 96) { // backtick
      const lim = closePos === -1 ? n : closePos;
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < lim && k > i + 1) { o += s.slice(j, i) + '<code>' + escRange(s, i + 1, k) + '</code>'; i = k + 1; j = i; }
      else i++;
    } else if (c === 42) { // *
      const lim = closePos === -1 ? n : closePos;
      if (s.charCodeAt(i + 1) === 42) {
        const k = findStrong(s, i + 2, lim);
        if (k !== -1) { o += s.slice(j, i) + '<strong>'; stack.push([k, 0, 0]); closePos = k; i += 2; j = i; }
        else i += 2;
      } else {
        const k = findEm(s, i + 1, lim);
        if (k !== -1) { o += s.slice(j, i) + '<em>'; stack.push([k, 1, 0]); closePos = k; i += 1; j = i; }
        else i++;
      }
    } else if (c === 91) { // [
      const lim = closePos === -1 ? n : closePos;
      let j2 = s.indexOf(']', i + 1);
      while (j2 !== -1 && j2 < lim && isEscaped(s, j2)) j2 = s.indexOf(']', j2 + 1);
      let done = false;
      if (j2 !== -1 && j2 < lim && s.charCodeAt(j2 + 1) === 40) { // '('
        const k2 = s.indexOf(')', j2 + 2);
        if (k2 !== -1 && k2 < lim) {
          const target = s.slice(j2 + 2, k2);
          let ok = target.length > 0;
          for (let q = 0; ok && q < target.length; q++) {
            const cc = target.charCodeAt(q);
            if (cc === 32 || cc === 9 || cc === 10 || cc === 13) ok = false;
          }
          if (ok) {
            const href = resolveHref(target, cx);
            o += s.slice(j, i) + '<a href="' + esc(href) + '">';
            stack.push([j2, 2, k2 + 1]); closePos = j2;
            i = i + 1; j = i;
            done = true;
          }
        }
      }
      if (!done) i++;
    } else if (c === 38) { o += s.slice(j, i) + '&amp;'; i++; j = i; }
    else if (c === 60) { o += s.slice(j, i) + '&lt;'; i++; j = i; }
    else if (c === 62) { o += s.slice(j, i) + '&gt;'; i++; j = i; }
    else if (c === 34) { o += s.slice(j, i) + '&quot;'; i++; j = i; }
    else if (c === 39) { o += s.slice(j, i) + '&#39;'; i++; j = i; }
    else i++;
  }
  return o + s.slice(j);
}

function fenceLang(ln) {
  // ln starts with '```'; returns lang string, '' for bare fence, null if not a fence
  let lang = '';
  for (let i = 3; i < ln.length; i++) {
    const c = ln.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) { lang += ln[i]; continue; }
    if (c === 32 || c === 9) {
      for (let q = i; q < ln.length; q++) {
        const d = ln.charCodeAt(q);
        if (d !== 32 && d !== 9) return null;
      }
      return lang;
    }
    return null;
  }
  return lang;
}

function isFenceClose(ln) {
  if (!ln.startsWith('```')) return false;
  for (let i = 3; i < ln.length; i++) {
    const c = ln.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingMatch(ln) {
  let k = 0;
  while (k < ln.length && ln.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  const c = ln.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let a = k;
  while (a < ln.length && (ln.charCodeAt(a) === 32 || ln.charCodeAt(a) === 9)) a++;
  const text = dropTrail(ln.slice(a));
  if (text === '') return null;
  return { level: k, text };
}

function isHr(ln) {
  if (ln.startsWith('---') || ln.startsWith('***')) {
    for (let i = 3; i < ln.length; i++) {
      const c = ln.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return false;
}

function listMarker(ln) {
  if (ln.startsWith('- ') || ln.startsWith('* ')) return { ordered: false, rest: ln.slice(2) };
  let j = 0;
  while (j < ln.length) {
    const c = ln.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j > 0 && ln.charCodeAt(j) === 46 && ln.charCodeAt(j + 1) === 32) return { ordered: true, num: +ln.slice(0, j), rest: ln.slice(j + 2) };
  return null;
}

function isContinuation(l2) {
  return l2.length > 2 && l2.charCodeAt(0) === 32 && l2.charCodeAt(1) === 32 && l2.charCodeAt(2) !== 32 && l2.charCodeAt(2) !== 9;
}

function countWords(lines, start) {
  let w = 0, inWord = false;
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i];
    for (let p = 0; p < ln.length; p++) {
      const c = ln.charCodeAt(p);
      const ws = c <= 32 || c === 160;
      if (ws) inWord = false;
      else if (!inWord) { w++; inWord = true; }
    }
    inWord = false;
  }
  return w;
}

function renderMd(lines, start, cx) {
  let html = '', excerpt = '';
  const toc = [];
  const heads = new Map();
  let i = start;
  const n = lines.length;
  while (i < n) {
    const ln = lines[i];
    if (isBlank(ln)) { i++; continue; }
    if (ln.startsWith('```')) {
      const lang = fenceLang(ln);
      if (lang !== null) {
        let body = '';
        i++;
        while (i < n && !isFenceClose(lines[i])) { body += esc(lines[i]) + '\n'; i++; }
        if (i < n) i++;
        html += lang ? '<pre><code class="language-' + lang + '">' + body + '</code></pre>\n' : '<pre><code>' + body + '</code></pre>\n';
        continue;
      }
    }
    const h = headingMatch(ln);
    if (h) {
      let id = slugOf(h.text);
      const cnt = heads.get(id) || 0;
      heads.set(id, cnt + 1);
      if (cnt > 0) id = id + '-' + (cnt + 1);
      const inner = inl(h.text, cx);
      html += '<h' + h.level + ' id="' + id + '">' + inner + '</h' + h.level + '>\n';
      if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html: inner });
      i++;
      continue;
    }
    if (isHr(ln)) { html += '<hr>\n'; i++; continue; }
    if (ln.charCodeAt(0) === 62) { // blockquote '>'
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trim(t);
        if (t !== '') parts.push(t);
        i++;
      }
      html += parts.length ? '<blockquote>\n<p>' + inl(parts.join('\n'), cx) + '</p>\n</blockquote>\n' : '<blockquote>\n</blockquote>\n';
      continue;
    }
    const lm = listMarker(ln);
    if (lm) {
      const ordered = lm.ordered;
      let out = ordered ? (lm.num !== 1 ? '<ol start="' + lm.num + '">\n' : '<ol>\n') : '<ul>\n';
      let item = lm.rest;
      i++;
      while (i < n) {
        const l2 = lines[i];
        const m2 = listMarker(l2);
        if (m2 && m2.ordered === ordered) { out += '<li>' + inl(item, cx) + '</li>\n'; item = m2.rest; i++; continue; }
        if (isContinuation(l2)) { item += '\n' + trim(l2); i++; continue; }
        break;
      }
      out += '<li>' + inl(item, cx) + '</li>\n';
      out += ordered ? '</ol>\n' : '</ul>\n';
      html += out;
      continue;
    }
    const parts = [];
    while (i < n) {
      const l2 = lines[i];
      if (isBlank(l2)) break;
      if (l2.startsWith('```') && fenceLang(l2) !== null) break;
      if (headingMatch(l2)) break;
      if (isHr(l2)) break;
      parts.push(trim(l2));
      i++;
    }
    const ptext = parts.join('\n');
    const pInner = inl(ptext, cx);
    if (excerpt === '') excerpt = pInner;
    html += '<p>' + pInner + '</p>\n';
  }
  return { html, excerpt, toc };
}

// ---------- templates ----------
// ops: [0, text] TEXT | [1, bind] ESC | [2, bind] RAW
//      [3, depth, varName, bind, endIdx] FOR | [4] ENDFOR
//      [5, bind, neg, elseIdx, endIdx] IF | [6, endIdx] ELSE
//      [7] ENDIF | [8, name] INCLUDE
// A bind pre-resolves a path at parse time against the lexical for-stack:
//   [0, root, rest] — top-level ctx key (dynamic shadow check at render
//     still lets an enclosing loop var / loop object win, exactly like
//     the old scope-chain walk, so {% include %} inside a loop keeps
//     working);
//   [1, depth, rest] — the `loop` object of the for at lexical depth;
//   [2, depth, rest] — the loop variable of the for at lexical depth.
// Rest segments are still walked with Object.hasOwn, so prototype names
// ('toString', 'constructor') never resolve.
function parsePath(str) {
  const s = str.trim();
  if (s === '') return null;
  const parts = s.split('.');
  for (const p of parts) {
    if (!p.length) return null;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (i === 0) {
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return null;
      } else if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return null;
    }
  }
  return parts;
}

function parseTpl(src) {
  // A {% %} tag ALONE on a line consumes the whole line: the tag still
  // executes, but the line's surrounding whitespace and its \n emit nothing.
  const lines = src.split('\n');
  let s = '';
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const isLast = li === lines.length - 1;
    let tagOnly = null;
    const a = ln.indexOf('{%');
    if (a !== -1 && ln.indexOf('{%', a + 2) === -1) {
      const b = ln.indexOf('%}', a + 2);
      if (b !== -1 && ln.indexOf('%}', b + 2) === -1) {
        let ok = true;
        for (let k = 0; k < a; k++) {
          const c = ln.charCodeAt(k);
          if (c !== 32 && c !== 9) { ok = false; break; }
        }
        if (ok) for (let k = b + 2; k < ln.length; k++) {
          const c = ln.charCodeAt(k);
          if (c !== 32 && c !== 9) { ok = false; break; }
        }
        if (ok) tagOnly = ln.slice(a, b + 2);
      }
    }
    if (tagOnly !== null) s += tagOnly;
    else { s += ln; if (!isLast) s += '\n'; }
  }
  const ops = [];
  const stack = [];
  const forStack = []; // loop var names, innermost last
  function bindPath(ptxt) {
    const p = parsePath(ptxt);
    if (!p) return null;
    const r0 = p[0];
    if (r0 === 'loop' && forStack.length) return [1, forStack.length - 1, p.slice(1)];
    for (let d = forStack.length - 1; d >= 0; d--) {
      if (forStack[d] === r0) return [2, d, p.slice(1)];
    }
    return [0, r0, p.slice(1)];
  }
  let i = 0, j = 0;
  const n = s.length;
  while (i < n) {
    let k = -1;
    const k1 = s.indexOf('{{{', i), k2 = s.indexOf('{{', i), k3 = s.indexOf('{%', i);
    if (k1 !== -1) k = k1;
    if (k2 !== -1 && (k === -1 || k2 < k)) k = k2;
    if (k3 !== -1 && (k === -1 || k3 < k)) k = k3;
    if (k === -1) break;
    if (k > j) {
      const t = s.slice(j, k);
      const last = ops[ops.length - 1];
      if (last && last[0] === 0) last[1] += t;
      else ops.push([0, t]);
    }
    if (s.charCodeAt(k + 2) === 123) { // '{{{' raw
      const e = s.indexOf('}}}', k + 3);
      if (e === -1) return { err: 'a {{{ is not closed' };
      const ptxt = s.slice(k + 3, e).trim();
      const b = bindPath(ptxt);
      if (!b) return { err: '"' + ptxt + '" is not a path' };
      ops.push([2, b]);
      i = e + 3; j = i;
    } else if (s.charCodeAt(k + 1) === 123) { // '{{' esc
      const e = s.indexOf('}}', k + 2);
      if (e === -1) return { err: 'a {{ is not closed' };
      const ptxt = s.slice(k + 2, e).trim();
      const b = bindPath(ptxt);
      if (!b) return { err: '"' + ptxt + '" is not a path' };
      ops.push([1, b]);
      i = e + 2; j = i;
    } else { // '{%' tag
      const e = s.indexOf('%}', k + 2);
      if (e === -1) {
        const inner = s.slice(k + 2).trim();
        let w = inner, sp = -1;
        for (let q = 0; q < inner.length; q++) {
          const c = inner.charCodeAt(q);
          if (c === 32 || c === 9 || c === 10) { sp = q; break; }
        }
        if (sp !== -1) w = inner.slice(0, sp);
        if (w === 'if' || w === 'for') return { err: 'a ' + w + ' is not closed' };
        return { err: 'a {% is not closed' };
      }
      const tag = s.slice(k + 2, e).trim();
      const tagErr = '{% ' + tag + ' %} is not a tag';
      if (tag.startsWith('for ')) {
        const rest = tag.slice(4);
        const sp = rest.indexOf(' in ');
        if (sp < 1) return { err: tagErr };
        const vn = rest.slice(0, sp);
        if (!isName(vn)) return { err: tagErr };
        const ptxt = rest.slice(sp + 4).trim();
        if (ptxt === '' || ptxt.indexOf(' ') !== -1 || ptxt.indexOf('\t') !== -1) return { err: tagErr };
        const b = bindPath(ptxt);
        if (!b) return { err: '"' + ptxt + '" is not a path' };
        const depth = forStack.length;
        stack.push({ kind: 3, idx: ops.length });
        forStack.push(vn);
        ops.push([3, depth, vn, b, -1]);
      } else if (tag === 'endfor') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 3) return { err: 'an endfor with no open for' };
        stack.pop();
        forStack.pop();
        ops[top.idx][4] = ops.length;
        ops.push([4]);
      } else if (tag.startsWith('if ')) {
        let rest = tag.slice(3), neg = 0;
        if (rest.startsWith('not ')) { neg = 1; rest = rest.slice(4); }
        const ptxt = rest.trim();
        if (ptxt === '' || ptxt.indexOf(' ') !== -1 || ptxt.indexOf('\t') !== -1) return { err: tagErr };
        const b = bindPath(ptxt);
        if (!b) return { err: '"' + ptxt + '" is not a path' };
        stack.push({ kind: 5, idx: ops.length, elseIdx: -1 });
        ops.push([5, b, neg, -1, -1]);
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 5 || top.elseIdx !== -1) return { err: 'an else outside an if' };
        top.elseIdx = ops.length;
        ops[top.idx][3] = ops.length;
        ops.push([6, -1]);
      } else if (tag === 'endif') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 5) return { err: 'an endif with no open if' };
        stack.pop();
        ops[top.idx][4] = ops.length;
        if (top.elseIdx !== -1) ops[top.elseIdx][1] = ops.length;
        ops.push([7]);
      } else if (tag.startsWith('include ')) {
        const rest = tag.slice(8).trim();
        if (rest.length < 2 || rest.charCodeAt(0) !== 34 || rest.charCodeAt(rest.length - 1) !== 34) return { err: tagErr };
        const name = rest.slice(1, -1);
        if (name === '' || name.indexOf('"') !== -1) return { err: tagErr };
        ops.push([8, name]);
      } else {
        return { err: tagErr };
      }
      i = e + 2; j = i;
    }
  }
  if (n > j) {
    const t = s.slice(j, n);
    const last = ops[ops.length - 1];
    if (last && last[0] === 0) last[1] += t;
    else ops.push([0, t]);
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { err: top.kind === 3 ? 'a for is not closed' : 'a if is not closed' };
  }
  return { ops };
}

function isName(vn) {
  if (!vn.length) return false;
  for (let i = 0; i < vn.length; i++) {
    const c = vn.charCodeAt(i);
    if (i === 0) {
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
    } else if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
}

// Resolve a pre-resolved bind. `frames` holds one reusable frame object
// per active for level ({name, item, loop}); `base` is the frame offset
// of this template invocation (0 at top level, cx.top at {% include %});
// cx.top counts the currently active frames, so a ctx bind can still
// see a dynamically enclosing loop var (include inside a loop).
function resolveBind(b, frames, base, cx) {
  let v;
  const rest = b[2];
  if (b[0] === 1) { // loop object of the for at lexical depth b[1]
    v = frames[base + b[1]].loop;
  } else if (b[0] === 2) { // loop variable at lexical depth b[1]
    v = frames[base + b[1]].item;
  } else { // top-level ctx key, with dynamic shadow check
    const root = b[1];
    if (root === 'loop') {
      if (cx.top > 0) v = frames[cx.top - 1].loop;
      else if (Object.hasOwn(cx.ctx, root)) v = cx.ctx[root];
      else return undefined;
    } else {
      let found = false;
      for (let f = cx.top - 1; f >= 0; f--) {
        if (frames[f].name === root) { v = frames[f].item; found = true; break; }
      }
      if (!found) {
        if (!Object.hasOwn(cx.ctx, root)) return undefined;
        v = cx.ctx[root];
      }
    }
  }
  for (let i = 0; i < rest.length; i++) {
    const nm = rest[i];
    if (v !== null && (typeof v === 'object' || typeof v === 'function') && Object.hasOwn(v, nm)) v = v[nm];
    else return undefined;
  }
  return v;
}

function truthy(v) {
  return !(v === undefined || v === null || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0));
}

function writeVal(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i) s += ', '; s += writeVal(v[i]); }
    return s;
  }
  return '';
}

function renderOps(ops, lo, hi, frames, base, cx, depth) {
  let o = '';
  for (let p = lo; p < hi; p++) {
    const op = ops[p];
    const k = op[0];
    if (k === 0) { o += op[1]; continue; }
    if (k === 1) { o += esc(writeVal(resolveBind(op[1], frames, base, cx))); continue; }
    if (k === 2) { o += writeVal(resolveBind(op[1], frames, base, cx)); continue; }
    if (k === 3) {
      const arr = resolveBind(op[3], frames, base, cx);
      if (Array.isArray(arr)) {
        const fi = base + op[1];
        let fr = frames[fi];
        if (!fr) {
          fr = { name: '', item: undefined, loop: { index: 0, first: false, last: false, length: 0 } };
          frames[fi] = fr;
        }
        fr.name = op[2];
        const lp = fr.loop;
        const nn = arr.length;
        const savedTop = cx.top;
        cx.top = fi + 1;
        for (let q = 0; q < nn; q++) {
          fr.item = arr[q];
          lp.index = q + 1; lp.first = q === 0; lp.last = q === nn - 1; lp.length = nn;
          o += renderOps(ops, p + 1, op[4], frames, base, cx, depth);
        }
        cx.top = savedTop;
      }
      p = op[4];
      continue;
    }
    if (k === 5) {
      let t = truthy(resolveBind(op[1], frames, base, cx));
      if (op[2]) t = !t;
      if (t) o += renderOps(ops, p + 1, op[3] >= 0 ? op[3] : op[4], frames, base, cx, depth);
      else if (op[3] >= 0) o += renderOps(ops, op[3] + 1, op[4], frames, base, cx, depth);
      p = op[4];
      continue;
    }
    if (k === 8) {
      if (depth < 8) {
        const t = cx.templates[op[1]];
        if (t) o += renderOps(t, 0, t.length, frames, cx.top, cx, depth + 1);
      }
      continue;
    }
    // ENDFOR/ELSE/ENDIF: never executed (ranges and jumps skip them)
  }
  return o;
}

// ---------- build ----------
function normContent(c) {
  // \r\n and lone \r -> \n
  if (c.indexOf('\r') === -1) return c;
  let o = '', j = 0;
  for (let i = 0; i < c.length; i++) {
    if (c.charCodeAt(i) === 13) {
      o += c.slice(j, i) + '\n';
      if (c.charCodeAt(i + 1) === 10) i++;
      j = i + 1;
    }
  }
  return o + c.slice(j);
}

export function run(input) {
  const site = input.site;
  let base = site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const report = new Set();
  const out = {};

  // templates (sorted names; parse order irrelevant to output)
  const tpls = {};
  const tnames = Object.keys(input.templates).sort();
  for (const name of tnames) {
    const r = parseTpl(input.templates[name]);
    if (r.err) report.add('template "' + name + '": ' + r.err);
    else tpls[name] = r.ops;
  }

  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pages = []; // page records, source order
  const pageMap = new Map(); // source path -> url
  const staticSet = new Set();
  const statics = [];
  const takenByDir = new Map();

  for (const f of files) {
    const path = f.path;
    if (!path.endsWith('.md')) { statics.push(f); staticSet.add(path); continue; }
    const lines = normContent(f.content).split('\n');
    const r = parseFM(lines);
    if (r.err) { report.add('refused ' + path + ': ' + r.err); continue; }
    const fm = r.fm;
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const isPost = dir === 'posts' || dir.startsWith('posts/');
    const top = dir.split('/')[0];
    if (top === 'tags' || top === 'page') { report.add('refused ' + path + ': ' + top + '/ is the generator\'s own'); continue; }
    if (isPost && !fm.date) { report.add('refused ' + path + ': a post needs a date'); continue; }
    const layoutName = fm.layout || (isPost ? 'post' : 'page');
    if (!tpls[layoutName]) { report.add('refused ' + path + ': layout "' + layoutName + '" is no template that parses'); continue; }
    if (fm.draft === true) { report.add('draft ' + path); continue; }
    const pdir = isPost ? 'posts' : dir;
    let slug = fm.slug || slugOf(fm.title);
    let taken = takenByDir.get(pdir);
    if (!taken) {
      taken = new Set();
      if (pdir === '') { taken.add('posts'); taken.add('tags'); taken.add('page'); }
      takenByDir.set(pdir, taken);
    }
    let s = slug, k = 2;
    while (taken.has(s)) s = slug + '-' + k++;
    taken.add(s);
    const outPath = (pdir ? pdir + '/' : '') + s + '/index.html';
    const url = base + '/' + (pdir ? pdir + '/' : '') + s + '/';
    pageMap.set(path, url);
    pages.push({ path, dir, isPost, slug: s, outPath, url, title: fm.title, date: fm.date || '', summary: fm.summary || '', tags: fm.tags || [], layout: layoutName, bodyStart: r.bodyStart, lines });
  }

  // collections: posts newest first, equal dates by slug
  const posts = pages.filter(p => p.isPost).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i > 0 ? posts[i - 1] : null;
    posts[i].older = i < posts.length - 1 ? posts[i + 1] : null;
  }

  // tags registry (collection order, first spelling kept)
  const reg = new Map();
  for (const p of posts) {
    const seen = new Set();
    for (const t of p.tags) {
      const sl = slugOf(t);
      if (seen.has(sl)) continue;
      seen.add(sl);
      let e = reg.get(sl);
      if (!e) { e = { name: t, slug: sl, posts: [] }; reg.set(sl, e); }
      e.posts.push(p);
    }
  }
  const tagList = [...reg.values()].sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (const t of tagList) t.url = base + '/tags/' + t.slug + '/';
  for (const t of tagList) t.count = t.posts.length;

  // render markdown for every page (needs pageMap/staticSet; cx per source)
  // Loop frames are preallocated once and mutated in place; the inline
  // stack is reused across inl() calls. `tags` and `recent` are the same
  // for every page, so they are built once here instead of once per page.
  const frames = [];
  for (let f = 0; f < 8; f++) frames.push({ name: '', item: undefined, loop: { index: 0, first: false, last: false, length: 0 } });
  const cx = { ctx: {}, templates: tpls, pageMap, staticSet, base, report, src: '', dir: '', istack: [], frames, top: 0 };
  for (const p of pages) {
    cx.src = p.path;
    cx.dir = p.dir;
    const words = countWords(p.lines, p.bodyStart);
    const md = renderMd(p.lines, p.bodyStart, cx);
    p.content = md.html;
    p.excerpt = md.excerpt;
    p.toc = md.toc;
    p.reading = Math.max(1, Math.ceil(words / 200));
  }

  function card(p) {
    const tags = [];
    const seen = new Set();
    for (const t of p.tags) {
      const sl = slugOf(t);
      if (seen.has(sl)) continue;
      seen.add(sl);
      const e = reg.get(sl);
      tags.push(e ? { name: e.name, slug: sl, url: e.url } : { name: t, slug: sl, url: '' });
    }
    return { title: p.title, url: p.url, date: p.date, date_long: p.date ? dateLong(p.date) : '', summary: p.summary, excerpt: p.excerpt, reading_minutes: p.reading, tags };
  }

  const cardByPage = new Map();
  for (const p of pages) cardByPage.set(p, card(p));

  function pageObj(p) {
    const c = cardByPage.get(p);
    return {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long, summary: c.summary,
      excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: p.slug, content: p.content, toc: p.toc,
      newer: p.newer ? { title: p.newer.title, url: p.newer.url, date: p.newer.date, date_long: p.newer.date ? dateLong(p.newer.date) : '' } : null,
      older: p.older ? { title: p.older.title, url: p.older.url, date: p.older.date, date_long: p.older.date ? dateLong(p.older.date) : '' } : null,
      is_post: p.isPost
    };
  }

  // Shared across every rendered page (read-only during rendering).
  const tagObjs = tagList.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const recentCards = posts.slice(0, site.recent).map(q => cardByPage.get(q));

  // render pages (source order)
  for (const p of pages) {
    cx.ctx = {
      site: { title: site.title, base_url: base },
      page: pageObj(p), tags: tagObjs,
      recent: recentCards,
      posts: undefined, pager: undefined, tag: undefined
    };
    out[p.outPath] = renderOps(tpls[p.layout], 0, tpls[p.layout].length, frames, 0, cx, 0);
  }

  // index pages
  const per = site.per_page;
  const nPosts = posts.length;
  const total = Math.max(1, Math.ceil(nPosts / per));
  if (tpls['index']) {
    for (let i = 1; i <= total; i++) {
      const slice = posts.slice((i - 1) * per, i * per).map(q => cardByPage.get(q));
      const pager = {
        number: i, total,
        url: i === 1 ? base + '/' : base + '/page/' + i + '/',
        newer_url: i > 1 ? (i - 1 === 1 ? base + '/' : base + '/page/' + (i - 1) + '/') : '',
        older_url: i < total ? base + '/page/' + (i + 1) + '/' : ''
      };
      cx.ctx = {
        site: { title: site.title, base_url: base },
        page: undefined, posts: slice, pager,
        tags: tagObjs,
        recent: recentCards,
        tag: undefined
      };
      out[i === 1 ? 'index.html' : 'page/' + i + '/index.html'] = renderOps(tpls['index'], 0, tpls['index'].length, frames, 0, cx, 0);
    }
  }

  // tag pages + tags index
  if (tpls['tag']) {
    for (const t of tagList) {
      cx.ctx = {
        site: { title: site.title, base_url: base },
        page: undefined, posts: undefined, pager: undefined,
        tags: tagObjs,
        recent: recentCards,
        tag: { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map(q => cardByPage.get(q)) }
      };
      out['tags/' + t.slug + '/index.html'] = renderOps(tpls['tag'], 0, tpls['tag'].length, frames, 0, cx, 0);
    }
  }
  if (tpls['tags']) {
    cx.ctx = {
      site: { title: site.title, base_url: base },
      page: undefined, posts: undefined, pager: undefined,
      tags: tagObjs,
      recent: recentCards,
      tag: undefined
    };
    out['tags/index.html'] = renderOps(tpls['tags'], 0, tpls['tags'].length, frames, 0, cx, 0);
  }

  // static files
  let nStatic = statics.length;
  for (const f of statics) {
    if (Object.hasOwn(out, f.path)) { report.add('shadowed ' + f.path + ': a built page has its path'); continue; }
    out[f.path] = f.content;
  }

  // report
  const nPages = pages.filter(p => !p.isPost).length;
  const nPostCount = posts.length;
  const lines = [...report].sort();
  let rep = '';
  for (const l of lines) rep += l + '\n';
  rep += 'built ' + nPages + ' pages, ' + nPostCount + ' posts, ' + tagList.length + ' tags and ' + nStatic + ' static files\n';
  out['build-report.txt'] = rep;
  return out;
}
