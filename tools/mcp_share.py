#!/usr/bin/env python3
"""Share of MCP tool results in Claude Code transcripts.

Reads ~/.claude/projects/**/*.jsonl. Counts characters of text that entered the context:
tool results (by tool), user text, assistant text, thinking and tool inputs.
A tool result is counted once (by tool_use_id). `weighted` multiplies the size of a result by the
count of later API requests in the same file: each later request reads the result again.
"""
import collections
import datetime
import glob
import json
import os
import statistics
import sys

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
ONLY = sys.argv[2] if len(sys.argv) > 2 else None  # one file, for a check
since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DAYS)
root = os.path.expanduser('~/.claude/projects')
files = [ONLY] if ONLY else [f for f in glob.glob(root + '/**/*.jsonl', recursive=True)
                             if os.path.getmtime(f) >= since.timestamp()]


def text_len(content):
    """Characters of text and count of images in a content value."""
    if isinstance(content, str):
        return len(content), 0
    chars = images = 0
    if isinstance(content, list):
        for b in content:
            if isinstance(b, str):
                chars += len(b)
            elif isinstance(b, dict):
                t = b.get('type')
                if t == 'text':
                    chars += len(b.get('text') or '')
                elif t == 'image':
                    images += 1
                elif t == 'tool_reference':
                    chars += len(json.dumps(b, ensure_ascii=False))
                else:
                    chars += len(json.dumps(b, ensure_ascii=False))
    return chars, images


def cls(name):
    if name.startswith('mcp__'):
        parts = name.split('__')
        return 'mcp', parts[1] if len(parts) > 1 else '?'
    return 'builtin', name


seen_results = set()
seen_msgs = set()
seen_uuids = set()
names = {}  # tool_use_id -> tool name
size = collections.Counter()      # (kind, group) -> chars
weighted = collections.Counter()  # (kind, group) -> chars * later requests
calls = collections.Counter()
images = collections.Counter()
mcp_sizes = []
mcp_tool = collections.Counter()
mcp_tool_calls = collections.Counter()
other = collections.Counter()     # user_text, assistant_text, thinking, tool_input
other_w = collections.Counter()
usage = collections.Counter()
requests_total = 0
sessions = set()
side = collections.Counter()

for f in files:
    rows = []
    try:
        with open(f, errors='replace') as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get('type') in ('user', 'assistant') and isinstance(o.get('message'), dict):
                    rows.append(o)
    except OSError:
        continue
    # API requests of the file, in order: one per distinct message id of the assistant
    req_at = []  # index in rows where a new request starts
    ids = set()
    for i, o in enumerate(rows):
        if o['type'] == 'assistant':
            mid = o['message'].get('id')
            if mid and mid not in ids:
                ids.add(mid)
                req_at.append(i)

    def later(i):
        # requests that start after row i
        lo, hi = 0, len(req_at)
        while lo < hi:
            m = (lo + hi) // 2
            if req_at[m] > i:
                hi = m
            else:
                lo = m + 1
        return len(req_at) - lo

    for i, o in enumerate(rows):
        ts = o.get('timestamp')
        try:
            when = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')) if ts else None
        except Exception:
            when = None
        if when is not None and when < since:
            continue
        uid = o.get('uuid')
        m = o['message']
        content = m.get('content')
        n_later = later(i)
        if o['type'] == 'assistant':
            mid = m.get('id')
            if mid and mid not in seen_msgs:
                seen_msgs.add(mid)
                requests_total += 1
                u = m.get('usage') or {}
                for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'):
                    usage[k] += int(u.get(k) or 0)
                sessions.add(o.get('sessionId'))
                side['sidechain' if o.get('isSidechain') else 'main'] += 1
            if uid in seen_uuids:
                continue
            seen_uuids.add(uid)
            if isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    t = b.get('type')
                    if t == 'tool_use':
                        names[b.get('id')] = b.get('name') or '?'
                        n = len(json.dumps(b.get('input'), ensure_ascii=False))
                        other['tool_input'] += n
                        other_w['tool_input'] += n * n_later
                    elif t == 'text':
                        n = len(b.get('text') or '')
                        other['assistant_text'] += n
                        other_w['assistant_text'] += n * n_later
                    elif t == 'thinking':
                        n = len(b.get('thinking') or '')
                        other['thinking'] += n
            continue
        # user row
        if uid in seen_uuids:
            continue
        seen_uuids.add(uid)
        if isinstance(content, str):
            other['user_text'] += len(content)
            other_w['user_text'] += len(content) * n_later
            continue
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get('type') == 'tool_result':
                tid = b.get('tool_use_id')
                if tid in seen_results:
                    continue
                seen_results.add(tid)
                name = names.get(tid, '?unknown')
                key = cls(name)
                chars, imgs = text_len(b.get('content'))
                size[key] += chars
                weighted[key] += chars * n_later
                calls[key] += 1
                images[key] += imgs
                if key[0] == 'mcp':
                    mcp_sizes.append(chars)
                    mcp_tool[name] += chars
                    mcp_tool_calls[name] += 1
            elif b.get('type') == 'text':
                n = len(b.get('text') or '')
                other['user_text'] += n
                other_w['user_text'] += n * n_later


def pct(a, b):
    return f'{100 * a / b:5.1f}%' if b else '   n/a'


res_total = sum(size.values())
res_w = sum(weighted.values())
mcp = sum(v for k, v in size.items() if k[0] == 'mcp')
mcp_w = sum(v for k, v in weighted.items() if k[0] == 'mcp')
ctx = res_total + other['user_text'] + other['assistant_text'] + other['tool_input']
ctx_w = res_w + other_w['user_text'] + other_w['assistant_text'] + other_w['tool_input']

print(f'days={DAYS} files={len(files)} sessions={len(sessions)} api_requests={requests_total} {dict(side)}')
print('usage tokens:', dict(usage))
print()
print(f'transcript text that the model reads again (chars): {ctx:,}')
print(f'  tool results   {res_total:>14,} {pct(res_total, ctx)}')
print(f'  tool inputs    {other["tool_input"]:>14,} {pct(other["tool_input"], ctx)}')
print(f'  assistant text {other["assistant_text"]:>14,} {pct(other["assistant_text"], ctx)}')
print(f'  user text      {other["user_text"]:>14,} {pct(other["user_text"], ctx)}')
print(f'  (thinking, not counted in the total: {other["thinking"]:,})')
print()
print(f'MCP results: {mcp:,} chars, calls={sum(v for k, v in calls.items() if k[0] == "mcp")}')
print(f'  share of tool results       {pct(mcp, res_total)}')
print(f'  share of transcript text    {pct(mcp, ctx)}')
print(f'  weighted share of results   {pct(mcp_w, res_w)}')
print(f'  weighted share of text      {pct(mcp_w, ctx_w)}')
print()
print('by group (chars, share of results, weighted share, calls, images):')
for key, v in size.most_common(25):
    print(f'  {key[0]:8}{key[1][:34]:36}{v:>13,} {pct(v, res_total)} {pct(weighted[key], res_w)} {calls[key]:>6} {images[key]:>4}')
print()
if mcp_sizes:
    s = sorted(mcp_sizes)
    q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    print(f'MCP result size: median={statistics.median(s):,.0f} p90={q(0.9):,} p99={q(0.99):,} max={s[-1]:,}')
    for lim in (2000, 10000, 40000):
        big = [x for x in s if x > lim]
        print(f'  results > {lim:>6,} chars: {len(big):>5} calls ({pct(len(big), len(s))}), {pct(sum(big), mcp)} of MCP chars')
    print('top MCP tools by chars:')
    for name, v in mcp_tool.most_common(15):
        print(f'  {name[:60]:62}{v:>12,} {pct(v, mcp)} calls={mcp_tool_calls[name]}')
