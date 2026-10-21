"""Windows sharing failures are injected; concurrency runs against real files."""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import lab_pipeline as lp


def windows_denied(code=5):
    exc=PermissionError(13,'Access is denied')
    exc.winerror=code
    return exc


class AtomicSaveChecks(unittest.TestCase):
    def test_windows_sharing_conflict_retries_without_truncating_old_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json';lp.write_json(path,{'old':True})
            original=os.replace;attempts=[]
            def replace(source,target):
                attempts.append(Path(source))
                self.assertEqual(json.loads(path.read_text()),{'old':True})
                if len(attempts)<3:raise windows_denied(5 if len(attempts)==1 else 32)
                return original(source,target)
            with patch.object(lp.os,'replace',side_effect=replace),patch.object(lp.time,'sleep') as sleep:
                lp.write_json(path,{'new':'中文'})
            self.assertEqual(lp.read_json(path),{'new':'中文'})
            self.assertEqual(len(attempts),3);self.assertEqual(sleep.call_count,2)
            self.assertNotEqual(attempts[0].name,'manifest.json.tmp')
            self.assertEqual(list(Path(tmp).glob('*.tmp')),[])

    def test_persistent_denial_retains_original_and_reports_actionable_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json';lp.write_json(path,{'old':True})
            with patch.object(lp.os,'replace',side_effect=windows_denied()),patch.object(lp.time,'sleep'):
                with self.assertRaisesRegex(PermissionError,'已有结果未覆盖'):
                    lp.write_json(path,{'new':True})
            self.assertEqual(lp.read_json(path),{'old':True})
            self.assertEqual(list(Path(tmp).glob('*.tmp')),[])

    def test_writers_have_unique_temp_files_and_invalid_values_leave_no_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json';seen=[];original=os.replace
            def replace(a,b):seen.append(str(a));return original(a,b)
            with patch.object(lp.os,'replace',side_effect=replace):
                lp.write_json(path,{'n':1});lp.write_json(path,{'n':2})
            self.assertEqual(len(set(seen)),2)
            with self.assertRaises(ValueError):lp.write_json(path,{'n':float('nan')})
            self.assertEqual(lp.read_json(path),{'n':2})
            self.assertEqual(list(Path(tmp).glob('*.tmp')),[])

    def test_polling_and_concurrent_writes_keep_valid_complete_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json';lp.write_json(path,{'writer':0,'n':0,'body':'x'*2048})
            errors=[];stop=threading.Event()
            def reader():
                try:
                    while not stop.is_set():
                        value=lp.read_json(path)
                        self.assertEqual(value['body'],'x'*2048)
                except Exception as exc:errors.append(exc)
            def writer(number):
                try:
                    for n in range(30):lp.write_json(path,{'writer':number,'n':n,'body':'x'*2048})
                except Exception as exc:errors.append(exc)
            poller=threading.Thread(target=reader);poller.start()
            writers=[threading.Thread(target=writer,args=(n,)) for n in range(3)]
            for t in writers:t.start()
            for t in writers:t.join(timeout=10)
            stop.set();poller.join(timeout=5)
            self.assertTrue(all(not t.is_alive() for t in writers))
            self.assertFalse(poller.is_alive());self.assertEqual(errors,[])
            self.assertEqual(lp.read_json(path)['n'],29)
            self.assertEqual(list(Path(tmp).glob('*.tmp')),[])


if __name__=='__main__':unittest.main()
