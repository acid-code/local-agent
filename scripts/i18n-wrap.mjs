/**
 * One-shot codemod: wraps user-visible English in web/src (JSX text, a few attributes, toast/confirm messages and
 * label-like object props) with t('...'). Re-running is safe: wrapped strings are skipped.
 * Usage: node scripts/i18n-wrap.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..', 'packages/web/src');
const FILES = [
  ...fs.readdirSync(path.join(ROOT, 'pages')).map((f) => `pages/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'components')).map((f) => `components/${f}`),
  'App.tsx', 'lib/models.tsx',
].filter((f) => /\.tsx?$/.test(f));
const ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'description', 'text', 'blurb', 'hint', 'help', 'aria-description', 'heading', 'subtitle', 'emptyText', 'confirmText']);
const PROPS = new Set(['label', 'title', 'blurb', 'description', 'hint', 'detail', 'text', 'placeholder', 'help', 'empty', 'tagline', 'summary', 'caption', 'note']);
const CALLS = new Set(['toast', 'confirm', 'prompt', 'alert']);
const dry = process.argv.includes('--dry');

const ENT = { '&apos;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&middot;': '·', '&rarr;': '→', '&larr;': '←' };
const looksLikeText = (s) => /[A-Za-z]/.test(s) && !/^(https?:|\/|#|\.|mailto:)/.test(s.trim()) && !/^[a-z0-9_\-.:/@#%=?&]+$/.test(s.trim()) && !/[{}<>]/.test(s) && s.trim().length > 1;
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

let total = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // A local named t (parameter or variable) would shadow the import; use tr there.
  let shadow = false;
  const scan = (node) => { if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && node.name.text === 't') shadow = true; ts.forEachChild(node, scan); };
  scan(sf);
  const fn = shadow ? 'tr' : 't';
  const edits = [];
  const claimed = [];
  const covered = (node) => claimed.some(([a, b]) => node.getStart(sf) >= a && node.end <= b);
  const claim = (node, text) => { if (covered(node)) return; edits.push([node.getStart(sf), node.end, text]); claimed.push([node.getStart(sf), node.end]); total += 1; };

  /** A string-ish expression as a t() call, or null when it is not UI text. */
  const asCall = (expr) => {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return looksLikeText(expr.text) ? `${fn}(${q(expr.text)})` : null;
    if (ts.isTemplateExpression(expr)) {
      let key = expr.head.text;
      const args = [];
      expr.templateSpans.forEach((span, i) => { key += `{${i}}` + span.literal.text; args.push(span.expression.getText(sf)); });
      if (!looksLikeText(key.replace(/\{\d+\}/g, ''))) return null;
      return `${fn}(${q(key)}, [${args.join(', ')}])`;
    }
    return null;
  };
  /** Wrap string branches of a JSX expression (a ? 'x' : 'y', a || 'x', `...`). */
  const wrapBranches = (expr) => {
    if (ts.isParenthesizedExpression(expr)) return wrapBranches(expr.expression);
    if (ts.isConditionalExpression(expr)) { wrapBranches(expr.whenTrue); wrapBranches(expr.whenFalse); return; }
    if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(expr.operatorToken.kind)) { wrapBranches(expr.right); if (expr.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) wrapBranches(expr.left); return; }
    const call = asCall(expr);
    if (call) claim(expr, call);
  };
  const isTCall = (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 't' || node.expression.text === 'tr');

  const visit = (node) => {
    if (isTCall(node)) return;
    if (ts.isJsxText(node)) {
      const raw = node.getFullText(sf);
      let text = raw;
      for (const [k, v] of Object.entries(ENT)) text = text.split(k).join(v);
      if (/&[a-z]+;/.test(text) || !looksLikeText(text)) return;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const key = text.trim().replace(/\s+/g, ' ');
      const start = node.getFullStart() + lead.length;
      const end = node.end - trail.length;
      // JSX drops whitespace that holds a newline; keep a plain space where the text touched an expression.
      const pre = lead && !lead.includes('\n') ? ' ' : (lead.includes('\n') ? '' : '');
      const post = trail && !trail.includes('\n') ? ' ' : '';
      edits.push([start - (pre ? lead.length : 0), end + (post ? trail.length : 0), `${pre ? "{' '}" : ''}{${fn}(${q(key)})}${post ? "{' '}" : ''}`]);
      total += 1;
      return;
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (!ATTRS.has(name)) return ts.forEachChild(node, visit);
      if (ts.isStringLiteral(node.initializer)) { const call = asCall(node.initializer); if (call) claim(node.initializer, `{${call}}`); return; }
      if (ts.isJsxExpression(node.initializer) && node.initializer.expression) wrapBranches(node.initializer.expression);
      return ts.forEachChild(node, visit);
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) wrapBranches(node.expression);
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (CALLS.has(callee) && node.arguments[0]) wrapBranches(node.arguments[0]);
      if (callee === 'errorText' && node.arguments[1]) wrapBranches(node.arguments[1]);
    }
    if (ts.isPropertyAssignment(node) && PROPS.has(node.name.getText(sf).replace(/['"]/g, ''))) wrapBranches(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) continue;
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [a, b, text] of edits) out = out.slice(0, a) + text + out.slice(b);
  const hasImport = /from '(\.\.?\/)+i18n'/.test(out);
  if (!hasImport) {
    const depth = rel.split('/').length - 1;
    const from = depth ? `${'../'.repeat(depth)}i18n` : './i18n';
    const importLine = `import { ${shadow ? 't as tr' : 't'} } from '${from}';\n`;
    const lastImport = [...out.matchAll(/^import [^;]+;\n/gm)].pop();
    out = lastImport ? out.slice(0, lastImport.index + lastImport[0].length) + importLine + out.slice(lastImport.index + lastImport[0].length) : importLine + out;
  }
  if (!dry) fs.writeFileSync(file, out);
  console.log(rel, edits.length);
}
console.log('wrapped', total);
