import json
import os
import re
import subprocess
import sys
from pathlib import Path

UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
AGENT = re.compile(r'^[a-zA-Z0-9_-]{1,128}$')
# JSON escaping can expand each input byte to six bytes. Keep the result below
# Herdr's 8 MiB exec output limit, including labels and JSON framing.
MAX_BYTES = 1024 * 1024
MAX_META = 64 * 1024


def projects_root():
    return (Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude') / 'projects').resolve()


def contained(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def root_for_session(session_id):
    if not isinstance(session_id, str) or not UUID.fullmatch(session_id):
        raise ValueError('Invalid session ID')
    root = projects_root()
    matches = [p for p in root.glob('*/' + session_id + '.jsonl')
               if p.is_file() and contained(p, root) and contained(p.parent, root)]
    if len(matches) != 1:
        raise ValueError('Session transcript not found or ambiguous')
    return matches[0].parent


def validate_ref(ref):
    if not isinstance(ref, dict):
        raise ValueError('Invalid transcript reference')
    project, session, agent = (ref.get(k) for k in ('project', 'session_id', 'agent_id'))
    if (not isinstance(project, str) or not project or project in ('.', '..')
            or '/' in project or '\\' in project or ':' in project):
        raise ValueError('Invalid project')
    if not isinstance(agent, str) or not AGENT.fullmatch(agent):
        raise ValueError('Invalid agent ID')
    parent = root_for_session(session)
    if parent.name != project:
        raise ValueError('Project does not match session')
    base = parent / session / 'subagents'
    path = base / ('agent-' + agent + '.jsonl')
    if not contained(base, parent) or not contained(path, base) or not contained(path, parent):
        raise ValueError('Transcript path escapes project')
    return path


def resume_transcript(ref):
    result = {'path': None, 'cwd': None, 'error': None}
    try:
        path = validate_ref(ref)
        with path.open('rb') as f:
            first = f.readline(MAX_META + 1)
        result['path'] = str(path.resolve())
        if len(first) <= MAX_META:
            try:
                record = json.loads(first)
                cwd = record.get('cwd') if isinstance(record, dict) else None
                if isinstance(cwd, str) and os.path.isdir(cwd):
                    result['cwd'] = cwd
            except (ValueError, UnicodeDecodeError):
                pass
    except (OSError, ValueError, RuntimeError) as exc:
        result['error'] = str(exc)
    return result


def read_transcript(ref):
    result = {'text': '', 'partial': False, 'error': None}
    try:
        path = validate_ref(ref)
        chunks = []
        with path.open('rb') as f:
            data = f.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            data = data[:MAX_BYTES]
            result['partial'] = True
        for line in data.splitlines():
            try:
                record = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                result['partial'] = True
                continue
            if not isinstance(record, dict) or record.get('type') not in ('user', 'assistant'):
                continue
            message = record.get('message')
            if not isinstance(message, dict):
                result['partial'] = True
                continue
            content = message.get('content')
            parts = []
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str):
                        parts.append(block['text'])
                    else:
                        parts.append('[Unsupported content omitted]')
                        result['partial'] = True
            else:
                parts.append('[Unsupported content omitted]')
                result['partial'] = True
            if parts:
                chunks.append(record['type'].capitalize() + ':\n' + '\n'.join(parts))
        result['text'] = '\n\n'.join(chunks)
    except (OSError, ValueError, RuntimeError) as exc:
        result['error'] = str(exc)
    return result


def process_parents():
    proc = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
        capture_output=True, text=True, timeout=20, check=True)
    data = json.loads(proc.stdout)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise ValueError('Invalid process data')
    return {p['ProcessId']: p['ParentProcessId'] for p in data
            if isinstance(p, dict) and isinstance(p.get('ProcessId'), int)
            and isinstance(p.get('ParentProcessId'), int)}


def is_descendant(pid, terminal, parents):
    seen = set()
    while pid in parents and pid not in seen:
        seen.add(pid)
        pid = parents[pid]
        if pid == terminal:
            return True
    return False


def sessions():
    # cmd resolves the Windows claude.cmd installation; all arguments are fixed.
    command = ['cmd', '/d', '/c', 'claude', 'agents', '--json', '--all'] if os.name == 'nt' else ['claude', 'agents', '--json', '--all']
    proc = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
    data = json.loads(proc.stdout)
    if not isinstance(data, list):
        raise ValueError('Invalid Claude agents response')
    return data


def list_subagents(session):
    project = root_for_session(session)
    subdir = project / session / 'subagents'
    if not contained(subdir, project):
        raise ValueError('Subagent directory escapes project')
    rows = []
    if not subdir.exists():
        return rows
    for path in sorted(subdir.glob('agent-*.jsonl')):
        agent = path.name[len('agent-'):-len('.jsonl')]
        if not AGENT.fullmatch(agent) or not path.is_file() or not contained(path, subdir):
            continue
        meta = {}
        metadata = subdir / ('agent-' + agent + '.meta.json')
        if metadata.is_file() and contained(metadata, subdir):
            try:
                with metadata.open('rb') as f:
                    raw = f.read(MAX_META + 1)
                if len(raw) <= MAX_META:
                    obj = json.loads(raw)
                    if isinstance(obj, dict):
                        meta = obj
            except (OSError, ValueError, UnicodeDecodeError):
                pass
        name = meta.get('description') or meta.get('agentType') or agent
        rows.append({'project': project.name, 'session_id': session, 'agent_id': agent,
                     'name': name if isinstance(name, str) else agent,
                     'finished': meta.get('finished') if isinstance(meta.get('finished'), bool) else None})
    return rows


def list_activity(targets):
    result = {'parents': {}, 'background': [], 'error': None}
    try:
        if not isinstance(targets, list):
            raise ValueError('Invalid targets')
        valid = []
        for target in targets:
            if not isinstance(target, dict) or not isinstance(target.get('address'), str) or not target['address'] or type(target.get('pid')) is not int or target['pid'] <= 0:
                raise ValueError('Invalid terminal target')
            if target['address'] in result['parents']:
                raise ValueError('Duplicate terminal address')
            result['parents'][target['address']] = []
            valid.append(target)
        records = sessions()
        background_keys = ('id', 'name', 'cwd', 'state', 'status', 'sessionId', 'startedAt')
        for record in records:
            if isinstance(record, dict) and record.get('kind') == 'background' and isinstance(record.get('id'), str) and record['id']:
                result['background'].append({k: record.get(k) for k in background_keys})
        parents = process_parents() if valid else {}
        interactive = [r for r in records if isinstance(r, dict) and r.get('kind') == 'interactive' and type(r.get('pid')) is int]
        errors = []
        for record in interactive:
            matches = [t for t in valid if is_descendant(record['pid'], t['pid'], parents)]
            if len(matches) != 1:
                continue
            # A terminal with multiple live Claude processes is ambiguous.
            target = matches[0]
            candidates = [r for r in interactive if is_descendant(r['pid'], target['pid'], parents)]
            if len(candidates) != 1:
                continue
            try:
                result['parents'][target['address']] = list_subagents(record.get('sessionId'))
            except (OSError, ValueError, RuntimeError) as exc:
                errors.append(str(exc))
        if errors:
            result['error'] = '; '.join(errors)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        result['error'] = str(exc)
    return result


def main():
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ('list', 'read', 'resume'):
            raise ValueError('Usage: claude-activity.py list|read|resume JSON')
        arg = json.loads(sys.argv[2])
        result = list_activity(arg) if sys.argv[1] == 'list' else resume_transcript(arg) if sys.argv[1] == 'resume' else read_transcript(arg)
    except (ValueError, TypeError) as exc:
        result = {'error': str(exc)}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
