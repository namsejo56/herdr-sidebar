"""Run on Windows: python tests/codex-mcp-details-integration.py

Uses an isolated temporary CODEX_HOME and local MCP test servers. Requires
node and codex on PATH. Does not read or change the user's Codex configuration.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'mods/context-inspector-261109/mcp-connection.js').read_text(encoding='utf-8')
probe = source[source.index('function codexProbe()'):source.index('\nconst TTL')] + '\ncodexProbe()'

with tempfile.TemporaryDirectory(prefix='codex-mcp-details-test-') as folder:
    root = Path(folder)
    log = root / 'servers.jsonl'
    server = root / 'server.js'
    server.write_text(r'''const fs = require("fs");
const lines = require("readline").createInterface({input: process.stdin});
fs.appendFileSync(process.argv[2], JSON.stringify({name: process.argv[3], pid: process.pid, ppid: process.ppid}) + "\n");
if (process.argv[3] === "broken") process.exit(1);
lines.on("line", line => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  const result = req.method === "initialize"
    ? {protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"test",version:"1"}}
    : req.method === "tools/list"
      ? {tools:process.argv[3] === "empty" ? [] : [{name:"find",description:"Find items",inputSchema:{type:"object"}}]}
      : {};
  console.log(JSON.stringify({jsonrpc:"2.0", id:req.id, result}));
});''', encoding='utf-8')
    node = subprocess.check_output(['where.exe', 'node'], text=True).splitlines()[0]
    def toml_string(value):
        return json.dumps(str(value).replace('\\', '/'))
    (root / 'config.toml').write_text(''.join(
        '[mcp_servers.' + name + ']\ncommand = ' + toml_string(node) +
        '\nargs = [' + ','.join(map(toml_string, (server, log, name))) + ']\n'
        for name in ('one', 'two', 'empty', 'broken')), encoding='utf-8')
    env = os.environ.copy()
    env['CODEX_HOME'] = folder
    completed = False
    try:
        previous_count = 0
        for selected in ('one', 'empty', 'broken'):
            result = subprocess.run(['node', '-e', probe, selected], env=env,
                                    capture_output=True, text=True, timeout=26)
            assert result.returncode == 0, 'probe failed'
            response = json.loads(result.stdout)
            all_records = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()]
            records = all_records[previous_count:]
            previous_count = len(all_records)
            assert [record['name'] for record in records] == [selected], 'unexpected server started'
            if selected == 'broken':
                assert response.get('status') != 'connected', 'broken server reported connected'
                assert response.get('discoveryFailed') or response.get('error'), 'missing failure evidence'
            else:
                assert response['status'] == 'connected', 'successful initialize was not reported connected'
                expected = [{'name': 'find', 'description': 'Find items'}] if selected == 'one' else []
                assert response['tools'] == expected, 'wrong tool inventory'
            time.sleep(0.3)
            for record in records:
                for key in ('pid', 'ppid'):
                    pid = record[key]
                    output = subprocess.check_output(['tasklist', '/FI', f'PID eq {pid}', '/NH'], text=True)
                    assert str(pid) not in output, f'test process {key}={pid} remains alive'
            print(f'PASS: {selected}: status={response.get("status")}, selected server only, processes exited')
        completed = True
        print('PASS: successful, empty and failed MCP checks verified')
    finally:
        # Stop a leftover only after verifying it is this test's server process.
        if not completed and log.exists():
            for line in log.read_text(encoding='utf-8').splitlines():
                record = json.loads(line)
                pid = int(record['pid'])
                query = f"(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"
                current = subprocess.run(['powershell', '-NoProfile', '-Command', query],
                                         capture_output=True, text=True, timeout=5).stdout
                if str(server).lower() in current.lower():
                    parent = int(record['ppid'])
                    parent_query = f"(Get-CimInstance Win32_Process -Filter 'ProcessId = {parent}').CommandLine"
                    parent_command = subprocess.run(['powershell', '-NoProfile', '-Command', parent_query],
                                                    capture_output=True, text=True, timeout=5).stdout.lower()
                    owner = parent if 'codex' in parent_command and 'app-server' in parent_command else pid
                    subprocess.run(['taskkill', '/PID', str(owner), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
