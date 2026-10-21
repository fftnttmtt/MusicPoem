"""Download the five required checkpoints; verify size and SHA-256 before use.

Uses only Python's standard library, supports interrupted .part files and servers
that ignore Range, and never replaces the target with unverified bytes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
BLOCK = 1024 * 1024


def entries(root=ROOT):
    root = Path(root).resolve()
    manifest = json.loads((root / 'models_manifest.json').read_text(encoding='utf-8'))
    for entry in manifest['files']:
        target = (root / entry['path']).resolve()
        if root not in target.parents:
            raise ValueError('Model destination must be inside the project')
        yield entry, target


def valid(path, info):
    if not path.is_file() or path.stat().st_size != info['size']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(BLOCK), b''):
            digest.update(block)
    return digest.hexdigest() == info['sha256']


def download(info, target, attempts=3):
    target = Path(target)
    if valid(target, info):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.part')
    last_error = None
    for attempt in range(attempts):
        try:
            if partial.is_file() and partial.stat().st_size >= info['size']:
                if valid(partial, info):
                    os.replace(partial, target)
                    return
                partial.unlink()
            offset = partial.stat().st_size if partial.is_file() else 0
            headers = {'User-Agent': 'SPECTRA-model-downloader/1', 'Accept-Encoding': 'identity'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            request = urllib.request.Request(info['url'], headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                resumed = response.status == 206
                if resumed:
                    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                    if not match or int(match[1]) != offset or int(match[3]) != info['size']:
                        raise RuntimeError('Unexpected Content-Range')
                elif response.status != 200:
                    raise RuntimeError(f'Unexpected HTTP status {response.status}')
                # A server may ignore Range and return the whole file: restart.
                received = offset if resumed else 0
                next_report = received + 50 * BLOCK
                with partial.open('ab' if resumed else 'wb') as output:
                    for block in iter(lambda: response.read(BLOCK), b''):
                        received += len(block)
                        if received > info['size']:
                            raise RuntimeError('Response exceeds expected model size')
                        output.write(block)
                        if received >= next_report:
                            print(f"  {received / 1e6:.0f} / {info['size'] / 1e6:.0f} MB", flush=True)
                            next_report = received + 50 * BLOCK
                    output.flush()
                    os.fsync(output.fileno())
            if not valid(partial, info):
                raise RuntimeError('Incomplete download or SHA-256 mismatch')
            os.replace(partial, target)
            return
        except (OSError, ValueError, RuntimeError) as exc:
            last_error = exc
            print(f'  Attempt {attempt + 1}/{attempts}: {exc}', file=sys.stderr, flush=True)
            if attempt + 1 < attempts:
                time.sleep(attempt + 1)
    raise RuntimeError(f'Download failed; rerun to resume: {last_error}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check-only', action='store_true', help='Verify all files without network access')
    mode.add_argument('--links', action='store_true', help='Print exact paths, URLs and SHA-256 values')
    args = parser.parse_args(argv)
    failed = []
    for info, target in entries():
        if args.links:
            print(f"{info['path']}\n{info['url']}\n{info['size']} bytes; SHA256 {info['sha256']}\n")
            continue
        if valid(target, info):
            print('OK:', info['path'], flush=True)
            continue
        if args.check_only:
            failed.append(info['path'])
            continue
        try:
            print(f"Downloading: {info['path']} ({info['size'] / 1e6:.1f} MB)", flush=True)
            download(info, target)
            print('Verified:', info['path'], flush=True)
        except Exception as exc:
            failed.append(info['path'])
            print('FAILED:', info['path'], str(exc), file=sys.stderr)
    if failed:
        print('\nMissing or invalid files:\n' + '\n'.join(failed), file=sys.stderr)
        return 1
    if not args.links:
        print('All five checkpoints and four support files verified.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
