"""Bounded-memory, ordered PNG -> FFmpeg MP4 exports. No model inference."""
import atexit
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import threading
import time
import uuid

from stem_separator.audio_io import ffmpeg_executable


class VideoExports:
    FRAME_WRITE_TIMEOUT=45
    def __init__(self, lab):
        self.lab=lab;self.sessions={};self.lock=threading.RLock()
        self.stop=threading.Event()
        self.watchdog=threading.Thread(target=self._watch,daemon=True);self.watchdog.start()
        atexit.register(self.close)

    def _watch(self):
        while not self.stop.wait(1):self._check_stalled()

    def _check_stalled(self):
        # Do not acquire the frame lock: a blocked pipe writer holds it. Killing
        # the child releases the write on Windows as well as POSIX.
        with self.lock:sessions=list(self.sessions.values())
        now=time.monotonic()
        for s in sessions:
            started=s.get('writing_since')
            if started is not None and now-started>self.FRAME_WRITE_TIMEOUT:
                s['write_timed_out']=True
                try:s['process'].kill()
                except OSError:pass

    def create(self, run_id, options):
        if not isinstance(options,dict):raise ValueError('视频设置无效。')
        width,height,fps=(options.get(k) for k in ('width','height','fps'))
        if any(isinstance(x,bool) or not isinstance(x,int) for x in (width,height,fps)):
            raise ValueError('视频尺寸和帧率须为整数。')
        if not 160<=width<=3840 or not 90<=height<=2160 or width%2 or height%2 or width*9!=height*16 or fps not in (24,30,60):
            raise ValueError('视频须为16:9偶数尺寸，帧率24、30或60。')
        audio_stem=options.get('audio_stem','mix')
        if audio_stem not in ('mix','bass','drums','other','vocals','guitar','piano'):
            raise ValueError('导出音轨无效。')
        requested=options.get('export_id')
        if requested is not None and (not isinstance(requested,str) or len(requested)!=32 or any(c not in '0123456789abcdef' for c in requested)):
            raise ValueError('视频任务标识无效。')
        m=self.lab.manifest(run_id)
        if m['stages']['mapping']['status']!='ready':raise ValueError('请先完成颜色和坐标映射。')
        duration=m['duration_seconds'];frames=math.ceil((duration+.55)*fps)
        folder=self.lab.folder(run_id);audio=folder/('listen.wav' if audio_stem=='mix' else 'previews/'+audio_stem+'.wav')
        if not audio.is_file():raise FileNotFoundError('所选导出音轨尚未生成。')
        from lab_pipeline import write_json
        executable=ffmpeg_executable()
        with self.lock:expired=[key for key,s in self.sessions.items() if time.monotonic()-s['updated']>1800]
        for key in expired:self.cancel(key)
        with self.lock:
            if requested in self.sessions:
                previous=self.sessions[requested]
                if previous['run_id']!=run_id or previous['options']!=options:raise ValueError('视频任务标识已被不同设置使用。')
                return {'id':requested,'frames':previous['frames'],'fps':fps,'duration_seconds':frames/fps}
            if any(s['run_id']==run_id and s['state'] in ('frames','encoding') for s in self.sessions.values()):
                raise ValueError('本曲已有视频正在导出，请等待或取消。')
            key=requested or uuid.uuid4().hex;output=folder/'videos';output.mkdir(exist_ok=True)
            path=output/(key+'.mp4');partial=output/(key+'.part.mp4');log=output/(key+'.log')
            info={'run_id':run_id,'source_sha256':m['sha256'],'source_name':m['name'],
                  'duration_seconds':duration,'frames':frames,'tail_seconds':.55,'settings':options,
                  'timebase':'frame index / fps; no wall clock, dropped frames or metronome clicks'}
            settings=output/(key+'.settings.json');write_json(settings,info)
            error_stream=log.open('wb')
            command=[executable,'-hide_banner','-loglevel','error','-y','-filter_threads','1',
                     '-f','image2pipe','-framerate',str(fps),'-vcodec','png','-threads','2','-i','pipe:0','-i',str(audio),
                     '-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','18',
                     '-threads','4','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-af','apad',
                     '-t',str(frames/fps),'-movflags','+faststart',str(partial)]
            try:
                process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=error_stream,
                                         creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            except Exception:
                error_stream.close();settings.unlink(missing_ok=True);log.unlink(missing_ok=True);raise
            self.sessions[key]={'id':key,'run_id':run_id,'width':width,'height':height,'fps':fps,'frames':frames,
                'received':0,'state':'frames','updated':time.monotonic(),'process':process,'stream':error_stream,
                'path':path,'partial':partial,'log':log,'settings':settings,'lock':threading.RLock(),
                'last_digest':None,'error':None,'result':None,'options':dict(options)}
            return {'id':key,'frames':frames,'fps':fps,'duration_seconds':frames/fps}

    def _session(self,key):
        with self.lock:
            s=self.sessions.get(key)
        if not s:raise FileNotFoundError('视频导出任务不存在或已取消。')
        return s

    def append(self,key,index,data):
        s=self._session(key)
        with s['lock']:
            if s['error']:raise RuntimeError(s['error'])
            if len(data)<33 or data[:8]!=b'\x89PNG\r\n\x1a\n' or data[12:16]!=b'IHDR' or struct.unpack('>II',data[16:24])!=(s['width'],s['height']):
                raise ValueError('视频帧不是指定尺寸的PNG。')
            digest=hashlib.sha256(data).digest()
            # A response can be lost after FFmpeg has received the frame. Retrying
            # the last identical frame must acknowledge it, never encode it twice.
            if index==s['received']-1 and digest==s['last_digest']:
                return {'received':s['received'],'frames':s['frames']}
            if s['state']!='frames' or index!=s['received'] or index>=s['frames']:
                raise ValueError('视频帧序号不连续，请重新导出。')
            try:
                if s['process'].poll() is not None:raise BrokenPipeError('FFmpeg exited')
                s['writing_since']=time.monotonic()
                s['process'].stdin.write(data);s['process'].stdin.flush()
            except (BrokenPipeError,OSError) as exc:
                if s.get('cancel_requested'):raise ValueError('视频导出已取消。') from exc
                if s.get('write_timed_out'):exc=TimeoutError(f'FFmpeg连续 {self.FRAME_WRITE_TIMEOUT} 秒未接收完当前帧')
                self._fail(s,'视频帧写入失败',exc)
                raise RuntimeError(s['error']) from exc
            finally:s['writing_since']=None
            s['received']+=1;s['last_digest']=digest;s['updated']=time.monotonic()
            return {'received':s['received'],'frames':s['frames']}

    def _fail(self,s,stage,exc=None):
        """Keep diagnostics on failures; cancel only removes disposable output."""
        process=s['process']
        if process.poll() is None:
            process.kill();process.wait(timeout=5)
        if process.stdin and not process.stdin.closed:
            try:process.stdin.close()
            except OSError:pass
        s['stream'].close()
        detail=s['log'].read_text(encoding='utf-8',errors='replace')[-2500:].strip()
        if s.get('write_timed_out'):detail=f'FFmpeg连续 {self.FRAME_WRITE_TIMEOUT} 秒未接收完当前帧。'+detail
        s['error']=f'{stage}（已接收 {s["received"]}/{s["frames"]} 帧，FFmpeg退出码 {process.returncode}）：'+(detail or str(exc or '未生成有效视频'))+f'。日志：{s["log"]}'
        s['state']='error';s['updated']=time.monotonic()
        from lab_pipeline import read_json,write_json
        try:
            info=read_json(s['settings']);info['error']=s['error'];write_json(s['settings'],info)
        except OSError:pass

    def status(self,key):
        s=self._session(key)
        with s['lock']:
            if s['state']=='frames' and s['process'].poll() is not None:self._fail(s,'视频编码进程提前退出')
            return {'id':key,'state':s['state'],'received':s['received'],'frames':s['frames'],
                    'error':s['error'],'result':s['result'],'log_path':str(s['log'])}

    def start_finish(self,key):
        s=self._session(key)
        with s['lock']:
            if s['error']:raise RuntimeError(s['error'])
            if s['state'] in ('encoding','done'):return self.status(key)
            if s['state']!='frames' or s['received']!=s['frames']:raise ValueError('尚有视频帧未渲染，不能完成导出。')
            s['state']='encoding';s['updated']=time.monotonic()
            try:s['process'].stdin.close()
            except OSError as exc:
                self._fail(s,'关闭视频输入失败',exc);raise RuntimeError(s['error']) from exc
            s['worker']=threading.Thread(target=self._finalize,args=(s,),daemon=True)
            s['worker'].start()
            return self.status(key)

    def _finalize(self,s):
        try:
            code=s['process'].wait(timeout=180)
            with s['lock']:
                if s['state']=='cancelled' or s.get('cancel_requested'):return
                s['stream'].close()
                if code or not s['partial'].is_file():raise RuntimeError('FFmpeg未能生成完整视频')
                # Windows scanners may briefly hold a just-written MP4 open.
                for attempt in range(6):
                    try:s['partial'].replace(s['path']);break
                    except PermissionError:
                        if attempt==5:raise
                        time.sleep(.1*(attempt+1))
                url=f'/api/lab/runs/{s["run_id"]}/files/videos/{s["path"].name}'
                result={'url':url,'path':'videos/'+s['path'].name,'bytes':s['path'].stat().st_size,
                        'frames':s['frames'],'fps':s['fps'],'width':s['width'],'height':s['height']}
                from lab_pipeline import read_json,write_json
                info=read_json(s['settings']);info['result']=result;write_json(s['settings'],info)
                s['result']=result;s['state']='done';s['updated']=time.monotonic()
        except Exception as exc:
            with s['lock']:
                if s['state']!='cancelled' and not s.get('cancel_requested'):self._fail(s,'视频封装失败',exc)

    def finish(self,key):
        """Blocking Python API; the HTTP API uses start_finish + status polling."""
        self.start_finish(key);s=self._session(key);s['worker'].join()
        status=self.status(key)
        if status['state']!='done':raise RuntimeError(status['error'] or '视频导出已取消。')
        return status['result']

    def cancel(self,key,*,preserve=False):
        with self.lock:s=self.sessions.get(key)
        if not s:return {'cancelled':True}
        # A stalled append holds s['lock']; terminate before waiting for it.
        # Keep the session registered until cleanup so the watchdog can help.
        if s['state']!='done':
            s['cancel_requested']=True;process=s['process']
            if process.poll() is None:
                try:process.terminate()
                except OSError:pass
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        with s['lock']:
            with self.lock:self.sessions.pop(key,None)
            if s['state']=='done':return {'cancelled':False}
            preserve=preserve or s['state']=='error'
            s['state']='cancelled';process=s['process']
            if process.stdin and not process.stdin.closed:
                try:process.stdin.close()
                except OSError:pass
            s['stream'].close()
            for field in (('partial',) if preserve else ('partial','log','settings')):s[field].unlink(missing_ok=True)
            return {'cancelled':True}

    def close(self):
        self.stop.set()
        with self.lock:keys=list(self.sessions)
        for key in keys:self.cancel(key)
