import json
import os
import sys
import uuid
from pathlib import Path


def valid_id(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def collect(targets, home):
    index = home / 'session_index.jsonl'
    if not index.exists():
        return {}
    entries = {}
    for line in index.read_text(encoding='utf-8').splitlines():
        try:
            item = json.loads(line)
            entries[item['id']] = item['thread_name']
        except (ValueError, KeyError, TypeError):
            continue
    result = {}
    for target in targets:
        title = target.get('title', '').split(' | ', 1)[0].strip()
        if sum(t.get('title', '').split(' | ', 1)[0].strip() == title for t in targets) != 1:
            continue
        ids = [key for key, value in entries.items() if value == title and valid_id(key)]
        if not title or len(ids) != 1:
            continue
        matches = list((home / 'sessions').glob(f'*/*/*/*{ids[0]}.jsonl'))
        if len(matches) != 1:
            continue
        states = {}
        try:
            with matches[0].open(encoding='utf-8') as f:
                meta = json.loads(next(f))['payload']
                if os.path.normcase(os.path.normpath(meta.get('cwd', ''))) != os.path.normcase(os.path.normpath(target.get('cwd') or '')):
                    continue
                for line in f:
                    try:
                        event = json.loads(line)
                        item = event.get('payload', {}).get('item', {})
                        if item.get('type') != 'SubAgentActivity':
                            continue
                        key = item.get('agent_thread_id')
                        kind = item.get('kind')
                        if not valid_id(key) or kind not in ('started', 'completed'):
                            continue
                        current = states.setdefault(key, {'thread_id': key})
                        current.update({k: v for k, v in item.items() if k in ('agent_path', 'model') and v})
                        current['kind'] = kind
                    except (ValueError, AttributeError):
                        continue
        except (OSError, ValueError, KeyError, StopIteration):
            continue
        result[target['address']] = list(states.values())
    return result


def resolve(request, home):
    thread_id = request.get('thread_id')
    address = request.get('address')
    targets = request.get('targets')
    if not valid_id(thread_id) or not isinstance(targets, list) or not isinstance(address, str):
        raise ValueError('Invalid subagent reference')
    rows = collect(targets, home).get(address, [])
    if sum(row.get('thread_id') == thread_id for row in rows) != 1:
        raise ValueError('Subagent is no longer associated with this session')
    matches = list((home / 'sessions').glob(f'*/*/*/*{thread_id}.jsonl'))
    if len(matches) != 1:
        raise ValueError('Subagent transcript is missing or ambiguous')
    with matches[0].open(encoding='utf-8') as f:
        entry = json.loads(next(f))
    meta = entry.get('payload', {})
    cwd = meta.get('cwd')
    if entry.get('type') != 'session_meta' or meta.get('id') != thread_id or not isinstance(cwd, str) or not os.path.isdir(cwd):
        raise ValueError('Subagent session metadata is unavailable')
    row = next(row for row in rows if row.get('thread_id') == thread_id)
    model = row.get('model') if isinstance(row.get('model'), str) else None
    return {'thread_id': thread_id, 'cwd': cwd, 'model': model}


def main():
    home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'resolve':
            result = resolve(json.loads(sys.argv[2]), home)
        elif len(sys.argv) == 2:
            result = collect(json.loads(sys.argv[1]), home)
        else:
            raise ValueError('Invalid arguments')
    except (ValueError, OSError, KeyError, TypeError, StopIteration, AttributeError) as exc:
        result = {'error': str(exc)}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
