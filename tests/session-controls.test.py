import importlib.util
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('controls', Path(__file__).parents[1] / 'mods/context-inspector-261109/session-controls.py')
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)
SID = '11111111-2222-4333-8444-555555555555'
STATE = dict(model='gpt-example', effort='high', mode='default', permission=':workspace', approvalPolicy='on-request', approvalsReviewer='user')


class Server:
    def __init__(self):
        self.state = dict(STATE)
        self.calls = []
        self.loaded = [SID]
        self.cwd = 'C:/project'
        self.apply = True

    def call(self, method, params):
        self.calls.append((method, params))
        if method == 'thread/loaded/list':
            return dict(data=self.loaded)
        if method == 'thread/resume':
            return dict(thread=dict(id=SID), cwd=self.cwd, model=self.state['model'], reasoningEffort=self.state['effort'],
                        collaborationMode=dict(mode=self.state['mode']), activePermissionProfile=dict(id=self.state['permission']),
                        approvalPolicy=self.state['approvalPolicy'], approvalsReviewer=self.state['approvalsReviewer'])
        if method == 'model/list':
            return dict(data=[dict(model='gpt-example', displayName='Example', supportedReasoningEfforts=[dict(reasoningEffort='high'), dict(reasoningEffort='low')])])
        if method == 'collaborationMode/list':
            return dict(data=[dict(mode='default', name='Default'), dict(mode='plan', name='Plan')])
        if method == 'permissionProfile/list':
            return dict(data=[dict(id=':workspace', allowed=True), dict(id=':read-only', allowed=True), dict(id=':danger-full-access', allowed=False)])
        if method == 'thread/settings/update':
            if self.apply:
                for key in ('model', 'effort', 'approvalPolicy'):
                    if key in params:
                        self.state[key] = params[key]
                if 'permissions' in params:
                    self.state['permission'] = params['permissions']
                if 'collaborationMode' in params:
                    self.state['mode'] = params['collaborationMode']['mode']
            return {}
        raise AssertionError('Unexpected method: ' + method)


class ControlsTests(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.request = dict(session=SID, cwd='C:/project', expected=dict(STATE), operation='update')

    def run_update(self, field, value):
        return controls.operate(dict(self.request, field=field, value=value), self.server)

    def test_effort_updates_exact_thread_and_verifies_fresh_state(self):
        result = self.run_update('effort', 'low')
        self.assertTrue(result['verified'])
        self.assertEqual(result['state']['effort'], 'low')
        updates = [p for m, p in self.server.calls if m == 'thread/settings/update']
        self.assertEqual(updates, [dict(threadId=SID, effort='low')])
        self.assertEqual(result['state']['mode'], STATE['mode'])
        self.assertEqual(result['state']['permission'], STATE['permission'])

    def test_mode_preserves_model_and_effort(self):
        self.run_update('mode', 'plan')
        update = next(p for m, p in self.server.calls if m == 'thread/settings/update')
        self.assertEqual(update['collaborationMode'], dict(mode='plan', settings=dict(model='gpt-example', reasoning_effort='high', developer_instructions=None)))

    def test_permissions_changes_only_profile_and_approval_policy(self):
        result = self.run_update('permissions', dict(permission=':read-only', approvalPolicy='never'))
        self.assertEqual(result['state']['approvalsReviewer'], 'user')
        update = next(p for m, p in self.server.calls if m == 'thread/settings/update')
        self.assertEqual(update, dict(threadId=SID, permissions=':read-only', approvalPolicy='never'))

    def test_invalid_or_disallowed_choices_never_mutate(self):
        for field, value in [('effort', 'ultra'), ('model', dict(model='unknown', effort='high')),
                             ('permissions', dict(permission=':danger-full-access', approvalPolicy='never')),
                             ('mode', 'unknown')]:
            with self.assertRaises(controls.ControlError):
                self.run_update(field, value)
        self.assertFalse(any(m == 'thread/settings/update' for m, _ in self.server.calls))

    def test_changed_settings_or_identity_never_mutate(self):
        self.server.state['effort'] = 'low'
        with self.assertRaisesRegex(controls.ControlError, 'settings changed'):
            self.run_update('mode', 'plan')
        self.server.cwd = 'C:/another'
        with self.assertRaisesRegex(controls.ControlError, 'identity changed'):
            self.run_update('mode', 'plan')
        self.server.loaded = []
        with self.assertRaisesRegex(controls.ControlError, 'not loaded'):
            self.run_update('mode', 'plan')
        self.assertFalse(any(m == 'thread/settings/update' for m, _ in self.server.calls))

    def test_acknowledgment_without_effective_change_is_not_success(self):
        self.server.apply = False
        with self.assertRaisesRegex(controls.ControlError, 'could not be verified'):
            self.run_update('effort', 'low')

    def test_options_and_reads_never_start_or_fork_a_session(self):
        result = controls.operate(dict(self.request, operation='options', field='permissions'), self.server)
        self.assertEqual([p['id'] for p in result['choices']], [':workspace', ':read-only'])
        self.assertEqual([m for m, _ in self.server.calls], ['permissionProfile/list'])

    def test_catalogs_do_not_require_a_session_or_loaded_thread(self):
        self.server.loaded = []
        for field in ('model', 'effort', 'mode', 'permissions'):
            result = controls.operate(dict(operation='options', field=field, cwd='C:/project'), self.server)
            self.assertTrue(result['choices'])
        self.assertFalse(any(m.startswith('thread/') for m, _ in self.server.calls))

    def test_websocket_fragmentation_and_ping(self):
        client = controls.Client.__new__(controls.Client)
        payload = bytearray(b'\x01\x07{"id":1\x89\x01!\x80\x01}')
        sent = []
        def take(size):
            data = bytes(payload[:size]); del payload[:size]
            return data
        client.take = take
        client.send = lambda data, opcode: sent.append((data, opcode))
        self.assertEqual(client.receive(), dict(id=1))
        self.assertEqual(sent, [(b'!', 10)])


if __name__ == '__main__':
    unittest.main()
