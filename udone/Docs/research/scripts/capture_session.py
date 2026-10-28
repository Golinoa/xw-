"""Capture agent-browser page, request details or HAR; redact before workspace writes."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit

from sanitize_evidence import sanitize_obj

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CLI = Path.home() / '.workbuddy/binaries/node/versions/22.22.2/node_modules/agent-browser/bin/agent-browser-win32-x64.exe'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=['page', 'requests', 'detail', 'har', 'stage'])
    parser.add_argument('name')
    parser.add_argument('--request-id')
    parser.add_argument('--session', default='oms-recheck')
    args = parser.parse_args()
    if not args.name.replace('_', '').replace('-', '').isalnum():
        parser.error('Use an alphanumeric evidence name')
    command = [os.environ.get('AGENT_BROWSER_BINARY', str(DEFAULT_CLI)), '--session', args.session, '--json']

    def call(parts, input_text=None):
        result = subprocess.run(command + parts, input=input_text, text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=45)
        data = json.loads(result.stdout)
        if result.returncode or not data.get('success'):
            raise RuntimeError('agent-browser command failed; no evidence promoted')
        return data

    if args.kind == 'page':
        outer = call(['eval', '--stdin'], (ROOT/'scripts/probe_page.js').read_text(encoding='utf-8'))
        data = outer['data']['result']
        if isinstance(data, str):
            data = json.loads(data)
        output = ROOT/'evidence/pages'/f'{args.name}.json'
    elif args.kind == 'har':
        fd, raw = tempfile.mkstemp(prefix='oms-har-', suffix='.json')
        os.close(fd)
        try:
            call(['network', 'har', 'stop', raw])
            data = json.loads(Path(raw).read_text(encoding='utf-8-sig'))
        finally:
            Path(raw).unlink(missing_ok=True)
        output = ROOT/'evidence'/f'{args.name}.har.json'
    elif args.kind == 'stage':
        listing = call(['network', 'requests'])
        candidates = {}
        for item in listing.get('data', {}).get('requests', []):
            if urlsplit(item.get('url', '')).hostname != 'trip.lipseo.com':
                continue
            if item.get('method') != 'POST' and item.get('resourceType') not in ['Document', 'Fetch', 'XHR']:
                continue
            key = item['requestId'] if item.get('method') == 'POST' else (item.get('method'), item.get('url'))
            candidates[key] = item
        details = []
        for item in candidates.values():
            try:
                details.append(call(['network', 'request', item['requestId']]))
            except RuntimeError:
                details.append({'requestId': item['requestId'], 'detail_unavailable': True})
        data = {'session': args.session, 'requests': listing, 'details': details}
        output = ROOT/'evidence'/f'{args.name}.json'
    else:
        if args.kind == 'detail' and not args.request_id:
            parser.error('detail requires --request-id')
        data = call(['network', 'request', args.request_id] if args.kind == 'detail' else ['network', 'requests'])
        output = ROOT/'evidence'/f'{args.name}.json'
    if output.exists():
        raise FileExistsError('Evidence exists; choose a new name')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(sanitize_obj(data), ensure_ascii=False, indent=2), encoding='utf-8')
    if args.kind == 'stage':
        call(['network', 'requests', '--clear'])
    print(json.dumps({'saved': str(output), 'kind': args.kind}, ensure_ascii=False))


if __name__ == '__main__':
    main()
