import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from spectra_server import Jobs, make_server


class StemServerChecks(unittest.TestCase):
    def test_six_stem_upload_options_and_exact_cached_playback_route(self):
        observed={};audio=b'RIFF-test-canonical-wave';run_id='a'*32
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def predict(path,**kwargs):
                observed.update(kwargs);observed['upload']=path.read_bytes()
                preview=kwargs['cache_root']/run_id/'preview';preview.mkdir(parents=True)
                (preview/'mixture.wav').write_bytes(audio)
                return dict(schema='spectra-stems-v1',run_id=run_id,audio={'playback_url':f'/api/stems/{run_id}/mixture.wav'})
            jobs=Jobs(predictor=predict,cache_root=root/'runs');server=make_server(0,jobs=jobs)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=4)
            try:
                payload=b'user-music-upload'
                conn.request('POST','/api/analyze?mode=stems&unit=bar&chunk_seconds=4&sw_weights=C%3A%5CModels%5Csw.ckpt',payload,{'X-Spectra-Client':'1','X-Audio-Name':'song.mp3'})
                response=conn.getresponse();job_id=json.loads(response.read())['job_id'];self.assertEqual(response.status,202)
                deadline=time.monotonic()+3
                while time.monotonic()<deadline:
                    conn.request('GET','/api/jobs/'+job_id);status=json.loads(conn.getresponse().read())
                    if status['status'] in ['done','error']:break
                    time.sleep(.01)
                self.assertEqual(status['status'],'done')
                self.assertEqual(observed['chunk_seconds'],4)
                self.assertEqual(observed['sw_weights'],r'C:\Models\sw.ckpt')
                self.assertEqual(observed['prediction_unit'],'bar')
                self.assertEqual(observed['sha256'],hashlib.sha256(payload).hexdigest())
                conn.request('GET',status['result']['audio']['playback_url']);response=conn.getresponse()
                self.assertEqual(response.status,200);self.assertEqual(response.read(),audio)
                for url in ['/api/stems/../../spectra_server.py','/api/stems/'+run_id+'/bass.wav']:
                    conn.request('GET',url);response=conn.getresponse();response.read();self.assertEqual(response.status,404)
            finally:
                conn.close();server.shutdown();server.server_close();jobs.executor.shutdown(wait=True);thread.join(2)

    def test_incompatible_units_or_chunk_sizes_are_rejected(self):
        server=make_server(0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=4)
        try:
            for url in ['/api/analyze?mode=stems&unit=beat','/api/analyze?mode=stems&chunk_seconds=1']:
                conn.request('POST',url,b'audio',{'X-Spectra-Client':'1'})
                response=conn.getresponse();response.read();self.assertEqual(response.status,400)
        finally:
            conn.close();server.shutdown();server.server_close();server.jobs.executor.shutdown(wait=True);thread.join(2)


if __name__=='__main__':unittest.main()
