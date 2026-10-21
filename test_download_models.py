"""Downloader contracts without downloading any real checkpoint."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest

from download_models import download, entries, valid


class Downloads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = b'test checkpoint bytes\x00' * 100
        payload = cls.payload

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                start = int(self.headers.get('Range', 'bytes=0-')[6:-1])
                if self.path == '/ignore-range':
                    start = 0
                body = payload[start:] if self.path != '/bad' else b'x' * len(payload)
                self.send_response(206 if start else 200)
                self.send_header('Content-Length', str(len(body)))
                if start:
                    self.send_header('Content-Range', f'bytes {start}-{len(payload)-1}/{len(payload)}')
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def info(self, path='/normal'):
        return {'url': f'http://127.0.0.1:{self.server.server_port}{path}',
                'size': len(self.payload), 'sha256': hashlib.sha256(self.payload).hexdigest()}

    def test_clean_download_resume_and_ignored_range(self):
        for url, offset in [('/normal', 0), ('/normal', 57), ('/ignore-range', 57)]:
            with self.subTest(url=url, offset=offset), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / 'nested/model.ckpt'
                target.parent.mkdir()
                if offset:
                    target.with_suffix('.ckpt.part').write_bytes(self.payload[:offset])
                download(self.info(url), target, attempts=1)
                self.assertEqual(target.read_bytes(), self.payload)
                self.assertTrue(valid(target, self.info()))
                self.assertFalse(target.with_suffix('.ckpt.part').exists())

    def test_corrupt_download_never_replaces_existing_target(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'model.ckpt'
            target.write_bytes(b'existing file')
            with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                download(self.info('/bad'), target, attempts=1)
            self.assertEqual(target.read_bytes(), b'existing file')

    def test_completed_partial_and_corrupt_partial(self):
        for payload in [self.payload, b'x' * len(self.payload), self.payload + b'x']:
            with self.subTest(length=len(payload)), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / 'model.ckpt'
                target.with_suffix('.ckpt.part').write_bytes(payload)
                download(self.info(), target, attempts=1)
                self.assertTrue(valid(target, self.info()))

    def test_valid_existing_file_needs_no_network(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'model.ckpt'
            target.write_bytes(self.payload)
            info = {**self.info(), 'url': 'http://127.0.0.1:1/unreachable'}
            download(info, target, attempts=1)

    def test_manifest_cannot_escape_project(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, 'models_manifest.json').write_text(json.dumps({'files': [{'path': '../outside'}]}))
            with self.assertRaises(ValueError):
                list(entries(temp))

    def test_packaged_support_files_match_manifest(self):
        large = []
        for info, target in entries():
            if info.get('bundled'):
                self.assertTrue(valid(target, info), info['path'])
            else:
                self.assertRegex(info['sha256'], r'^[0-9a-f]{64}$')
                large.append(info)
        self.assertEqual(len(large), 5)


if __name__ == '__main__':
    unittest.main()
