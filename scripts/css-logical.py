"""One-off: convert physical left/right CSS in styles.css to logical properties so RTL (Hebrew) mirrors the layout."""
import re, sys
path = sys.argv[1]
css = open(path).read()

def split_vals(v):
    out, depth, cur = [], 0, ''
    for ch in v:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ' ' and depth == 0:
            if cur: out.append(cur)
            cur = ''
        else:
            cur += ch
    if cur: out.append(cur)
    return out

def four(m):
    prop, val, end = m.group(1), m.group(2).strip(), m.group(3)
    imp = ''
    if val.endswith('!important'):
        imp, val = ' !important', val[:-10].strip()
    parts = split_vals(val)
    if len(parts) == 4 and parts[1] != parts[3]:
        t, r, b, l = parts
        return f'{prop}-block: {t} {b}{imp}; {prop}-inline: {l} {r}{imp}{end}'
    return m.group(0)

css = re.sub(r'(?<![\w-])(padding|margin):\s*([^;{}]+?)\s*(;|(?=\}))', four, css)
pairs = [
    (r'(?<![\w-])margin-left(?=\s*:)', 'margin-inline-start'), (r'(?<![\w-])margin-right(?=\s*:)', 'margin-inline-end'),
    (r'(?<![\w-])padding-left(?=\s*:)', 'padding-inline-start'), (r'(?<![\w-])padding-right(?=\s*:)', 'padding-inline-end'),
    (r'(?<![\w-])border-left(?=[\s:-])', 'border-inline-start'), (r'(?<![\w-])border-right(?=[\s:-])', 'border-inline-end'),
    (r'border-top-left-radius', 'border-start-start-radius'), (r'border-top-right-radius', 'border-start-end-radius'),
    (r'border-bottom-left-radius', 'border-end-start-radius'), (r'border-bottom-right-radius', 'border-end-end-radius'),
    (r'text-align:\s*left', 'text-align: start'), (r'text-align:\s*right', 'text-align: end'),
    (r'float:\s*left', 'float: inline-start'), (r'float:\s*right', 'float: inline-end'),
]
for a, b in pairs:
    css = re.sub(a, b, css)

# left/right offsets, except "left: 50%" centring that pairs with translateX(-50%) in the same rule.
def offsets(rule):
    body = rule.group(0)
    if 'translateX(-50%)' in body and re.search(r'(?<![\w-])left:\s*50%', body):
        return body
    body = re.sub(r'(?<![\w-])left:', 'inset-inline-start:', body)
    body = re.sub(r'(?<![\w-])right:', 'inset-inline-end:', body)
    return body
css = re.sub(r'\{[^{}]*\}', offsets, css)
open(path, 'w').write(css)
