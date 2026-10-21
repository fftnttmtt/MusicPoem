"""Real FFmpeg encoding, HTTP frame ordering and cancellation; no model calls."""
import http.client
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
import zlib

from video_export import VideoExports
from spectra_server import make_server, Jobs


def png(width,height,rgb):
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    rows=b''.join(b'\x00'+bytes(rgb)*width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')


class FakeLab:
    def __init__(self,root):self.root=Path(root);self.id='a'*32;self.duration=.2;self.directory=self.root/self.id;self.directory.mkdir()
    def folder(self,key):
        if key!=self.id:raise FileNotFoundError('unknown run')
        return self.directory
    def manifest(self,key):
        self.folder(key)
        return {'id':key,'name':'音频测试.wav','sha256':'f'*64,'duration_seconds':self.duration,'stages':{'mapping':{'status':'ready'}}}
    def file(self,key,relative):
        root=self.folder(key);p=(root/relative).resolve()
        if not p.is_relative_to(root.resolve()) or not p.is_file():raise FileNotFoundError()
        return p


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg is required')
class VideoExportChecks(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.lab=FakeLab(self.tmp.name);self.exports=VideoExports(self.lab);self.addCleanup(self.exports.close)
        self.options={'width':160,'height':90,'fps':30,'audio_stem':'mix','scene':{'size':1,'geometry':{'texture_enabled':True}}}
        with wave.open(str(self.lab.directory/'listen.wav'),'wb') as f:
            f.setparams((1,2,8000,0,'NONE','not compressed'))
            f.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(2*math.pi*440*i/8000))) for i in range(1600)))

    def test_real_mp4_contains_every_frame_audio_and_the_full_tail(self):
        export=self.exports.create(self.lab.id,self.options)
        self.assertEqual(export['frames'],23)
        for i in range(export['frames']):self.exports.append(export['id'],i,png(160,90,(30+i*5,100,160)))
        result=self.exports.finish(export['id']);output=self.lab.directory/result['path']
        self.assertTrue(output.is_file());self.assertGreater(output.stat().st_size,1000)
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(output)]))
        video=next(s for s in probe['streams'] if s['codec_type']=='video');audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
        self.assertEqual(video['nb_frames'],'23');self.assertEqual(video['avg_frame_rate'],'30/1');self.assertEqual(video['width'],160);self.assertEqual(video['height'],90)
        self.assertEqual(video['codec_name'],'h264');self.assertEqual(audio['codec_name'],'aac')
        self.assertAlmostEqual(float(video['duration']),23/30,places=5);self.assertLess(abs(float(audio['duration'])-23/30),.05)
        frames=subprocess.check_output(['ffmpeg','-v','error','-i',str(output),'-map','0:v:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
        stride=160*90*3;self.assertEqual(len(frames),23*stride)
        for i in (0,22):self.assertLess(abs(frames[i*stride+3*100]-(30+i*5)),6)
        settings=json.loads(output.with_suffix('.settings.json').read_text())
        self.assertEqual(settings['settings']['scene']['size'],1);self.assertEqual(settings['result']['frames'],23)
        self.assertFalse(list(output.parent.glob('*.part.mp4')))

    def test_rejects_bad_settings_dimensions_sequence_and_incomplete_finish_then_cleans_cancel(self):
        for patch in ({'width':161},{'fps':0},{'height':80},{'width':True},{'audio_stem':'../../bad'}):
            with self.assertRaises(ValueError):self.exports.create(self.lab.id,{**self.options,**patch})
        ex=self.exports.create(self.lab.id,self.options)
        with self.assertRaises(ValueError):self.exports.create(self.lab.id,self.options)
        with self.assertRaises(ValueError):self.exports.append(ex['id'],1,png(160,90,(30,40,50)))
        with self.assertRaises(ValueError):self.exports.append(ex['id'],0,png(320,180,(30,40,50)))
        self.exports.append(ex['id'],0,png(160,90,(30,40,50)))
        with self.assertRaises(ValueError):self.exports.finish(ex['id'])
        process=self.exports.sessions[ex['id']]['process'];self.exports.cancel(ex['id'])
        self.assertIsNotNone(process.poll());self.assertEqual(self.exports.sessions,{})
        self.assertEqual(list((self.lab.directory/'videos').iterdir()),[])
        self.exports.cancel(ex['id'])

    def test_http_routes_encode_and_download_video_and_enforce_frame_order(self):
        jobs=Jobs(self.lab.root/'cache');server=make_server(0,jobs=jobs,lab=self.lab)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(jobs.executor.shutdown,wait=True);self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        def post(path,body=b'',kind='application/json'):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=20)
            conn.request('POST',path,body,{'X-Spectra-Client':'1','Content-Type':kind});r=conn.getresponse();data=r.read();status=r.status;conn.close();return status,json.loads(data)
        status,ex=post('/api/lab/runs/'+self.lab.id+'/video',json.dumps(self.options).encode());self.assertEqual(status,201)
        prefix='/api/lab/videos/'+ex['id'];frame=png(160,90,(80,140,100))
        self.assertEqual(post(prefix+'/frame?index=1',frame,'image/png')[0],400)
        for i in range(ex['frames']):self.assertEqual(post(prefix+'/frame?index='+str(i),frame,'image/png')[0],200)
        status,result=post(prefix+'/finish');self.assertEqual(status,200)
        for _ in range(200):
            if result['state']=='done':break
            time.sleep(.02);status,result=post(prefix+'/status')
        self.assertEqual(result['state'],'done');result=result['result']
        conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
        conn.request('GET',result['url'],headers={'Range':'bytes=0-63'});r=conn.getresponse();data=r.read()
        self.assertEqual(r.status,206);self.assertEqual(r.getheader('Content-Type'),'video/mp4');self.assertEqual(len(data),64);self.assertIn(b'ftyp',data);conn.close()

    def test_lost_acknowledgements_and_finish_are_idempotent(self):
        ex=self.exports.create(self.lab.id,self.options);key=ex['id'];frame=png(160,90,(80,140,100))
        for i in range(ex['frames']):
            self.exports.append(key,i,frame)
            self.assertEqual(self.exports.append(key,i,frame)['received'],i+1)
        with self.assertRaises(ValueError):self.exports.append(key,ex['frames']-1,png(160,90,(0,0,0)))
        a=self.exports.finish(key);b=self.exports.finish(key)
        self.assertEqual(a,b);self.assertEqual(self.exports.status(key)['state'],'done')
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(self.lab.directory/a['path'])]))
        self.assertEqual(next(s for s in probe['streams'] if s['codec_type']=='video')['nb_frames'],str(ex['frames']))

    def test_encoder_crash_returns_details_and_keeps_diagnostics_after_cancel(self):
        ex=self.exports.create(self.lab.id,self.options);key=ex['id'];s=self.exports.sessions[key]
        s['process'].kill();s['process'].wait()
        with self.assertRaisesRegex(RuntimeError,'退出码'):
            self.exports.append(key,0,png(160,90,(20,30,40)))
        status=self.exports.status(key);self.assertEqual(status['state'],'error');self.assertIn('0/23',status['error'])
        self.exports.cancel(key)
        self.assertTrue(s['log'].exists());self.assertTrue(s['settings'].exists());self.assertFalse(s['partial'].exists())
        self.assertIn('error',json.loads(s['settings'].read_text()))

    def test_frame_http_connection_is_reused_and_repeated_finish_is_safe(self):
        jobs=Jobs(cache_root=self.lab.root/'cache');server=make_server(0,jobs=jobs,lab=self.lab)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(jobs.executor.shutdown,wait=True);self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=20);self.addCleanup(conn.close)
        def post(path,body=b''):
            conn.request('POST',path,body,{'X-Spectra-Client':'1'});r=conn.getresponse();self.assertEqual(r.status,201 if path.endswith('/video') else 200)
            self.assertEqual(r.version,11);return json.loads(r.read())
        ex=post('/api/lab/runs/'+self.lab.id+'/video',json.dumps(self.options).encode());sock=conn.sock
        prefix='/api/lab/videos/'+ex['id'];frame=png(160,90,(80,140,100))
        for i in range(ex['frames']):
            self.assertEqual(post(prefix+'/frame?index='+str(i),frame)['received'],i+1)
            self.assertIs(conn.sock,sock)
        status=post(prefix+'/finish')
        for _ in range(200):
            if status['state']=='done':break
            time.sleep(.02);status=post(prefix+'/status')
        self.assertEqual(status['state'],'done');self.assertEqual(post(prefix+'/finish')['result'],status['result'])

    def test_creation_response_can_be_retried_without_starting_two_encoders(self):
        options={**self.options,'export_id':'c'*32}
        first=self.exports.create(self.lab.id,options);second=self.exports.create(self.lab.id,dict(options))
        self.assertEqual(first,second);self.assertEqual(len(self.exports.sessions),1)
        with self.assertRaises(ValueError):self.exports.create(self.lab.id,{**options,'fps':60})

    def test_stalled_pipe_is_terminated_without_needing_the_frame_lock(self):
        ex=self.exports.create(self.lab.id,self.options);s=self.exports.sessions[ex['id']]
        s['writing_since']=time.monotonic()-self.exports.FRAME_WRITE_TIMEOUT-1
        self.exports._check_stalled();s['process'].wait(timeout=5)
        self.assertTrue(s['write_timed_out']);self.assertIsNotNone(s['process'].poll())
        self.assertEqual(self.exports.status(ex['id'])['state'],'error')

    def test_cancel_unblocks_a_real_pipe_writer(self):
        ex=self.exports.create(self.lab.id,self.options);key=ex['id'];s=self.exports.sessions[key]
        original=s['process'];original.kill();original.wait();original.stdin.close()
        # A child that never reads its pipe reproduces an encoder hang, without
        # depending on FFmpeg's buffering or the speed of this test machine.
        s['process']=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=s['stream'])
        errors=[]
        def write():
            try:self.exports.append(key,0,png(160,90,(80,140,100))+b'\x00'*1048576)
            except Exception as exc:errors.append(exc)
        writer=threading.Thread(target=write,daemon=True);writer.start()
        for _ in range(100):
            if s.get('writing_since') is not None:break
            time.sleep(.01)
        self.assertIsNotNone(s.get('writing_since'));self.assertTrue(writer.is_alive())
        self.exports.cancel(key);writer.join(timeout=5)
        self.assertFalse(writer.is_alive());self.assertTrue(errors);self.assertEqual(self.exports.sessions,{})
