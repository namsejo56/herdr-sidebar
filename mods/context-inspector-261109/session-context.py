"""Read only safe usage metadata for an identified Codex session."""
import json
import math
import os
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

UUID = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
MAX_TAIL = 2 * 1024 * 1024
# The Codex TUI gauge excludes this fixed baseline from usage and capacity.
BASELINE_TOKENS = 12000


def folder(value):
    return os.path.normcase(os.path.normpath(str(value).removeprefix('\\\\?\\')))


def count(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def identify(request, home, screen):
    ids = set(re.findall(r'^\s*Session:\s*(' + UUID + r')\s*$', screen, re.M))
    if len(ids) == 1:
        return ids.pop(), None, 'terminal status'
    if ids or request.get('duplicateTitle'):
        return None, None, None
    title = (request.get('title') or '').split(' | ', 1)[0].strip()
    if not title:
        return None, None, None
    # Use exact names and folders, never the most recently modified session.
    # Read-only URI avoids creating or migrating the provider's database.
    databases = sorted(home.glob('state_*.sqlite'))
    if len(databases) != 1:
        return None, None, None
    try:
        with closing(sqlite3.connect(databases[0].as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            rows = db.execute('select id,cwd,model from threads where name = ? or title = ?', (title, title)).fetchall()
        rows = [row for row in rows if folder(row[1]) == folder(request.get('cwd')) and re.fullmatch(UUID, row[0])]
        if len(rows) == 1:
            return rows[0][0], rows[0][2], 'session title and folder'
    except (sqlite3.Error, OSError):
        pass
    return None, None, None


def collect(request, home):
    result = {}
    if request.get('agent') != 'codex':
        return result
    screen = request.get('screen') or ''
    # Only the status/footer forms are recognized, not arbitrary percentages.
    matches = re.findall(r'\bContext\s+(\d+(?:\.\d+)?)%|\b(\d+(?:\.\d+)?)%\s+context left\b', screen, re.I)
    if matches:
        used, left = matches[-1]
        value = float(used) if used else 100 - float(left)
        if 0 <= value <= 100:
            result['contextPercent'] = value
    models = re.findall(r'^\s*(GPT-[\w.-]+|o\d[\w.-]*)\s+(high|medium|low|xhigh|minimal|none|max|ultra|·|\|)', screen, re.M | re.I)
    if models:
        result['model'] = models[-1][0]
        if models[-1][1] not in ('·', '|'):
            result['effort'] = models[-1][1].lower()
    sid, model, identity = identify(request, home, screen)
    if not sid:
        return result
    result.update(session=sid, identity=identity)
    if model and not result.get('model'):
        result['model'] = model
    paths = list((home / 'sessions').glob('*/*/*/*' + sid + '.jsonl'))
    if len(paths) != 1:
        return result
    try:
        with paths[0].open('rb') as stream:
            header = json.loads(stream.readline(128 * 1024))
            meta = header.get('payload', {})
            if header.get('type') != 'session_meta' or meta.get('id') != sid or folder(meta.get('cwd')) != folder(request.get('cwd')):
                return result
            stream.seek(0, 2)
            offset = max(0, stream.tell() - MAX_TAIL)
            stream.seek(offset)
            if offset:
                stream.readline()  # Discard the partial first record.
            lines = stream.read(MAX_TAIL).splitlines()
        latest = None
        for line in lines:
            try:
                event = json.loads(line)
                payload = event.get('payload') or {}
                if event.get('type') == 'turn_context' and isinstance(payload.get('model'), str):
                    result['model'] = payload['model']
                    if isinstance(payload.get('effort'), str):
                        result['effort'] = payload['effort']
                    mode = (payload.get('collaboration_mode') or {}).get('mode')
                    if mode in ('default', 'plan'):
                        result['mode'] = mode
                    sandbox = (payload.get('sandbox_policy') or {}).get('type')
                    if sandbox in ('read-only', 'workspace-write', 'danger-full-access'):
                        result['permission'] = {'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access'}[sandbox]
                    if payload.get('approval_policy') in ('never', 'on-request'):
                        result['approvalPolicy'] = payload['approval_policy']
                if event.get('type') == 'event_msg' and payload.get('type') == 'token_count' and isinstance(payload.get('info'), dict):
                    latest = payload['info']
            except (ValueError, AttributeError, TypeError):
                continue  # A live writer may leave its last line incomplete.
        if latest:
            limit = latest.get('model_context_window')
            if count(limit) and limit > 0:
                result['contextWindow'] = limit
                usage = latest.get('last_token_usage')
                total = usage.get('total_tokens') if isinstance(usage, dict) else None
                if 'contextPercent' not in result and count(total):
                    if limit <= BASELINE_TOKENS:
                        percent = 100
                    else:
                        effective = limit - BASELINE_TOKENS
                        remaining = max(0, effective - max(0, total - BASELINE_TOKENS))
                        # Rust rounds nonnegative halves upward; round remaining before inversion.
                        percent = 100 - math.floor(remaining / effective * 100 + 0.5)
                    result['contextPercent'] = percent
                    result['contextPercentSource'] = 'session log'
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return result


if __name__ == '__main__':
    try:
        request = json.loads(sys.argv[1])
        result = collect(request, Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').resolve())
    except (ValueError, TypeError, IndexError, OSError):
        result = {}
    print(json.dumps(result, ensure_ascii=True))
