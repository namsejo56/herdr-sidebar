import importlib.util
import json
import sqlite3
import tempfile
import unittest
import sys
from contextlib import closing
from pathlib import Path

MODULE = Path(__file__).parents[1] / 'mods/context-inspector-261109/session-context.py'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('session_context', MODULE)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
SID = '11111111-2222-4333-8444-555555555555'


class SessionContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.cwd = str(self.home / 'project')
        self.log = self.home / 'sessions/2026/11/12' / f'rollout-{SID}.jsonl'
        self.log.parent.mkdir(parents=True)
        self.events = [dict(type='session_meta', payload=dict(id=SID, cwd=self.cwd)),
                       dict(type='turn_context', payload=dict(model='gpt-example', effort='high', collaboration_mode=dict(mode='plan'),
                           sandbox_policy=dict(type='workspace-write'), approval_policy='on-request')),
                       dict(type='event_msg', payload=dict(type='token_count', info=dict(
                           last_token_usage=dict(input_tokens=90, output_tokens=10, total_tokens=100),
                           total_token_usage=dict(input_tokens=900, output_tokens=100, total_tokens=1000),
                           model_context_window=1000)))]
        self.write()

    def write(self):
        self.log.write_text('\n'.join(json.dumps(e) for e in self.events) + '\n', encoding='utf-8')

    def read(self, **kwargs):
        return reader.collect(dict(agent='codex', cwd=self.cwd, screen=f'Session: {SID}\nGPT-example high · Context 10% used', **kwargs), self.home)

    def test_exact_session_reads_usage_without_conversation_text(self):
        self.events.append(dict(type='response_item', payload=dict(secret='private conversation')))
        self.write()
        result = self.read()
        self.assertEqual(result['session'], SID)
        self.assertEqual(result['contextPercent'], 10)
        self.assertEqual(result['contextWindow'], 1000)
        self.assertEqual(result['effort'], 'high')
        self.assertEqual(result['mode'], 'plan')
        self.assertEqual(result['permission'], ':workspace')
        self.assertNotIn('last', result)
        self.assertNotIn('total', result)
        self.assertNotIn('private conversation', json.dumps(result))

    def test_no_identity_still_displays_screen_context_and_model(self):
        result = reader.collect(dict(agent='codex', cwd=self.cwd, screen='GPT-6.1-Sol high · Context 27% used'), self.home)
        self.assertEqual(result['contextPercent'], 27)
        self.assertEqual(result['model'], 'GPT-6.1-Sol')
        self.assertNotIn('last', result)

    def test_unique_title_and_folder_resolve_but_duplicates_do_not(self):
        with closing(sqlite3.connect(self.home / 'state_5.sqlite')) as db, db:
            db.execute('create table threads (id text, name text, title text, cwd text, rollout_path text, model text)')
            db.execute('insert into threads values (?,?,?,?,?,?)', (SID, 'My session', 'prompt', self.cwd, str(self.log), 'gpt-example'))
        request = dict(agent='codex', cwd=self.cwd, title='My session | project | weekly 88% left', screen='')
        self.assertEqual(reader.collect(request, self.home)['session'], SID)
        self.assertNotIn('session', reader.collect(dict(request, duplicateTitle=True), self.home))
        with closing(sqlite3.connect(self.home / 'state_5.sqlite')) as db, db:
            db.execute('insert into threads select * from threads')
        self.assertNotIn('session', reader.collect(request, self.home))

    def test_wrong_cwd_or_metadata_never_publishes_tokens(self):
        self.events[0]['payload']['cwd'] = 'another project'
        self.write()
        self.assertNotIn('last', self.read())
        self.events[0]['payload'] = dict(id='other', cwd=self.cwd)
        self.write()
        self.assertNotIn('last', self.read())

    def test_empty_session_partial_lines_and_invalid_window(self):
        self.log.unlink()
        self.assertNotIn('last', self.read())
        self.events[-1]['payload']['info']['model_context_window'] = -1
        self.write()
        with self.log.open('a') as stream:
            stream.write('{partial')
        self.assertNotIn('last', self.read())
        self.assertNotIn('contextWindow', self.read())

    def test_context_left_and_out_of_range(self):
        base = dict(agent='codex', cwd=self.cwd)
        self.assertEqual(reader.collect(dict(base, screen='GPT-example · 72% context left'), self.home)['contextPercent'], 28)
        self.assertNotIn('contextPercent', reader.collect(dict(base, screen='Context 120% used'), self.home))

    def test_bounded_tail_keeps_latest_usage_and_ignores_partial_record(self):
        self.events.insert(1, dict(type='response_item', payload=dict(text='private' * 400000)))
        self.write()
        with self.log.open('a') as stream:
            stream.write('{incomplete')
        result = self.read()
        self.assertEqual(result['contextWindow'], 1000)
        self.assertEqual(result['model'], 'gpt-example')

    def narrow(self, total=141227, window=475000):
        info = self.events[-1]['payload']['info']
        info['model_context_window'] = window
        info['last_token_usage'] = dict(total_tokens=total)
        info['total_token_usage'] = dict(total_tokens=9000000)
        self.write()
        return reader.collect(dict(agent='codex', cwd=self.cwd, screen=f'Session: {SID}\nGPT-example high · Context …'), self.home)

    def test_clipped_footer_uses_latest_session_context_report(self):
        result = self.narrow()
        self.assertEqual(result['contextPercent'], 28)
        self.assertEqual(result['contextPercentSource'], 'session log')
        self.assertNotIn('total', result)

    def test_visible_footer_takes_priority_over_log_fallback(self):
        self.narrow()
        self.assertEqual(self.read()['contextPercent'], 10)

    def test_log_fallback_matches_codex_rounding_and_bounds(self):
        for total, window, expected in [(12420, 40000, 1), (0, 475000, 0), (600000, 475000, 100), (500, 12000, 100), (300000, 1000000, 29)]:
            with self.subTest(total=total, window=window):
                self.assertEqual(self.narrow(total, window)['contextPercent'], expected)

    def test_invalid_usage_and_wrong_session_cannot_supply_a_fallback(self):
        for total in [None, -1, True, float('nan')]:
            self.assertNotIn('contextPercent', self.narrow(total))
        self.events[0]['payload']['cwd'] = 'another project'
        self.assertNotIn('contextPercent', self.narrow())

    def test_compaction_uses_the_new_report_instead_of_cumulative_tokens(self):
        before = self.narrow(200000)['contextPercent']
        after = self.narrow(50000)['contextPercent']
        self.assertLess(after, before)


if __name__ == '__main__':
    unittest.main()
