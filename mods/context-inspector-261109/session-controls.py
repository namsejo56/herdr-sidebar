"""Control an already loaded Codex thread through its existing local daemon."""
import base64
import hashlib
import json
import os
import queue
import re
import struct
import subprocess
import sys
import threading
import time

UUID = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'


class ControlError(Exception):
    pass


class Client:
    def __init__(self):
        self.deadline = time.monotonic() + 9
        self.events, self.buffer, self.serial = queue.Queue(), bytearray(), 0
        self.p = subprocess.Popen(['codex', 'app-server', 'proxy'], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._read, daemon=True).start()
        try:
            key = base64.b64encode(os.urandom(16)).decode()
            self.p.stdin.write(f'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
            self.p.stdin.flush()
            header = bytearray()
            while not header.endswith(b'\r\n\r\n') and len(header) < 8192:
                header.extend(self.take(1))
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            headers = header.decode('ascii')
            if not headers.startswith('HTTP/1.1 101 ') or f'sec-websocket-accept: {accept}'.lower() not in headers.lower():
                raise ControlError('Codex control connection unavailable.')
            self.call('initialize', dict(clientInfo=dict(name='herdr_session_controls', version='1.0'), capabilities=dict(experimentalApi=True)))
            self.send(dict(method='initialized', params={}))
        except BaseException:
            self.close()
            raise

    def _read(self):
        try:
            while True:
                data = self.p.stdout.read1(8192)
                self.events.put(data)
                if not data:
                    return
        except (OSError, ValueError):
            self.events.put(b'')

    def take(self, size):
        while len(self.buffer) < size:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise ControlError('Codex session controls timed out.')
            data = self.events.get(timeout=remaining)
            if not data:
                raise ControlError('Codex control connection closed.')
            self.buffer.extend(data)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def send(self, value, opcode=1):
        raw = json.dumps(value).encode() if isinstance(value, dict) else value
        size, mask = len(raw), os.urandom(4)
        if size < 126:
            header = bytes([128 | opcode, 128 | size])
        elif size <= 65535:
            header = bytes([128 | opcode, 254]) + struct.pack('!H', size)
        else:
            header = bytes([128 | opcode, 255]) + struct.pack('!Q', size)
        self.p.stdin.write(header + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(raw)))
        self.p.stdin.flush()

    def receive(self):
        fragments = bytearray()
        while True:
            first, second = self.take(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H', self.take(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.take(8))[0]
            if second & 128 or size + len(fragments) > 8 * 1024 * 1024:
                raise ControlError('Unsupported Codex control response.')
            data, opcode = self.take(size), first & 15
            if opcode == 9:
                self.send(data, 10)
                continue
            if opcode == 10:
                continue
            if opcode == 8:
                raise ControlError('Codex control connection closed.')
            if opcode not in (0, 1):
                raise ControlError('Unsupported Codex control frame.')
            fragments.extend(data)
            if first & 128:
                return json.loads(fragments)

    def call(self, method, params):
        self.serial += 1
        serial = self.serial
        self.send(dict(id=serial, method=method, params=params))
        for _ in range(1000):
            message = self.receive()
            if message.get('id') == serial and ('result' in message or 'error' in message):
                if 'error' in message:
                    raise ControlError('Codex could not access or update this session.')
                return message.get('result') or {}
        raise ControlError('Too many Codex notifications.')

    def close(self):
        try:
            self.p.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            self.p.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            self.p.terminate()
            try:
                self.p.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(timeout=0.5)
        self.p.stdout.close()


def pages(client, method, params=None):
    result, seen, cursor = [], set(), None
    for _ in range(32):
        response = client.call(method, dict(params or {}, **({'cursor': cursor} if cursor else {})))
        result.extend(response.get('data') or [])
        cursor = response.get('nextCursor')
        if not cursor:
            return result
        if cursor in seen:
            break
        seen.add(cursor)
    raise ControlError('Codex catalog pagination incomplete.')


def normalized_folder(value):
    return os.path.normcase(os.path.normpath(str(value).removeprefix('\\\\?\\')))


def state_from(response):
    sandbox = response.get('sandbox') or {}
    profile = response.get('activePermissionProfile') or {}
    permission = profile.get('id') or {'dangerFullAccess': ':danger-full-access', 'readOnly': ':read-only', 'workspaceWrite': ':workspace'}.get(sandbox.get('type'))
    return dict(model=response.get('model'), effort=response.get('reasoningEffort'),
                mode=(response.get('collaborationMode') or {}).get('mode'), permission=permission,
                approvalPolicy=response.get('approvalPolicy'), approvalsReviewer=response.get('approvalsReviewer'))


def current_state(client, request):
    sid = request.get('session')
    if not isinstance(sid, str) or not re.fullmatch(UUID, sid) or not request.get('cwd'):
        raise ControlError('Session identity unavailable. Refresh the sidebar.')
    if sid not in pages(client, 'thread/loaded/list'):
        raise ControlError('This session is not loaded in the running Codex server.')
    # Rejoin only an already loaded thread, with no configuration overrides or turn history.
    response = client.call('thread/resume', dict(threadId=sid, excludeTurns=True))
    thread = response.get('thread') or {}
    if thread.get('id') != sid or normalized_folder(response.get('cwd')) != normalized_folder(request['cwd']):
        raise ControlError('Session identity changed. Close and reopen the picker.')
    return state_from(response)


def catalog(client, field):
    if field in ('model', 'effort'):
        return [dict(id=m['model'], name=m.get('displayName') or m['model'],
                     efforts=[e['reasoningEffort'] for e in m.get('supportedReasoningEfforts', [])],
                     defaultEffort=m.get('defaultReasoningEffort'))
                for m in pages(client, 'model/list') if m.get('model') and not m.get('hidden')]
    if field == 'mode':
        return [dict(id=m['mode'], name=m.get('name') or m['mode'])
                for m in pages(client, 'collaborationMode/list') if m.get('mode') in ('default', 'plan')]
    if field == 'permissions':
        return [dict(id=p['id'], name=p['id'], description=p.get('description'))
                for p in pages(client, 'permissionProfile/list') if p.get('allowed') is True and p.get('id')]
    raise ControlError('Unsupported session control.')


def update_params(field, value, current, choices):
    if field == 'model':
        if not isinstance(value, dict):
            raise ControlError('Select a model and effort.')
        chosen = next((m for m in choices if m['id'] == value.get('model')), None)
        if not chosen or value.get('effort') not in chosen['efforts']:
            raise ControlError('That model and effort combination is unavailable.')
        return dict(model=chosen['id'], effort=value['effort'])
    if field == 'effort':
        model = next((m for m in choices if m['id'] == current['model']), None)
        if not model or value not in model['efforts']:
            raise ControlError('That effort is unavailable for the current model.')
        return dict(effort=value)
    if field == 'mode':
        if value not in [m['id'] for m in choices] or not current.get('model'):
            raise ControlError('That mode is unavailable.')
        return dict(collaborationMode=dict(mode=value, settings=dict(model=current['model'], reasoning_effort=current.get('effort'), developer_instructions=None)))
    if field == 'permissions':
        if not isinstance(value, dict) or value.get('permission') not in [p['id'] for p in choices] or value.get('approvalPolicy') not in ('on-request', 'never'):
            raise ControlError('That permissions choice is unavailable.')
        return dict(permissions=value['permission'], approvalPolicy=value['approvalPolicy'])
    raise ControlError('Unsupported session control.')


def matches(field, value, current):
    if field == 'model':
        return current.get('model') == value['model'] and current.get('effort') == value['effort']
    if field == 'permissions':
        return current.get('permission') == value['permission'] and current.get('approvalPolicy') == value['approvalPolicy']
    return current.get(field) == value


def operate(request, client):
    operation, field = request.get('operation', 'read'), request.get('field')
    if operation == 'options':
        return dict(choices=catalog(client, field))
    current = current_state(client, request)
    if operation == 'read':
        return dict(state=current)
    choices = catalog(client, field)
    if operation != 'update':
        raise ControlError('Unsupported session operation.')
    current = current_state(client, request)
    if request.get('expected') != current:
        raise ControlError('Session settings changed. Close and reopen the picker.')
    params = update_params(field, request.get('value'), current, choices)
    client.call('thread/settings/update', dict(threadId=request['session'], **params))
    # The acknowledgment means accepted, not necessarily applied. Verify fresh effective state.
    for _ in range(8):
        updated = current_state(client, request)
        if matches(field, request['value'], updated):
            return dict(state=updated, verified=True)
        time.sleep(0.05)
    raise ControlError('Change was accepted but could not be verified. Refresh before retrying.')


def run(request):
    client = Client()
    try:
        return operate(request, client)
    finally:
        client.close()


if __name__ == '__main__':
    try:
        result = run(json.loads(sys.argv[1]))
    except ControlError as error:
        result = dict(error=str(error))
    except Exception:
        result = dict(error='Codex session controls unavailable on this machine.')
    print(json.dumps(result, ensure_ascii=True))
