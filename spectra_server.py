"""Local-only MusicPoem server. Uses the project's existing CUDA environment."""
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote
import argparse
import errno
import hashlib
import json
import re
import shutil
import tempfile
import threading
import time
import uuid
import webbrowser

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 1024 * 1024 * 1024
UI_BUILD = 'local-lab-r56'


def frontend_metadata(web_root):
    web_root = Path(web_root).resolve()
    html = (web_root / 'index.html').read_text(encoding='utf-8')
    visuals = (web_root / 'visuals.js').read_text(encoding='utf-8') if (web_root / 'visuals.js').exists() else ''
    build = re.search(r'<meta name="spectra-build" content="([^"]+)"', html)
    gap = re.search(r'EPIC_OUTLINE_GAP\s*=\s*(\d+)', visuals)
    digest = hashlib.sha256()
    for path in sorted(web_root.iterdir()):
        if path.is_file() and path.suffix in ('.html', '.js', '.css'):
            digest.update(path.name.encode('utf-8'))
            digest.update(path.read_bytes())
    return dict(build_id=build.group(1) if build else None,
        epic_outline_gap_css_px=int(gap.group(1)) if gap else None,
        asset_revision=digest.hexdigest()[:12], web_directory=str(web_root))


class Jobs:
    def __init__(self, predictor=None, cache_root=None):
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.jobs = {}
        self.resources = {}
        self.predictor = predictor
        self.cache_root = Path(cache_root or ROOT/'spectra_runs')

    def reserve(self):
        with self.lock:
            if any(j['status'] in ('uploading', 'running') for j in self.jobs.values()):
                raise ValueError('上一首音乐仍在分析，请等待完成后再选择。')
            # Keep at most two recent results, avoiding unbounded RAM growth.
            while len(self.jobs) >= 2:
                self.jobs.pop(next(iter(self.jobs)))
            key = uuid.uuid4().hex
            self.jobs[key] = {'status': 'uploading', 'message': '接收音乐…', 'progress': 0.}
            return key

    def snapshot(self, key):
        with self.lock:
            return dict(self.jobs[key]) if key in self.jobs else None

    def update(self, key, **values):
        with self.lock:
            self.jobs[key].update(values)

    def submit(self, key, path, directory, unit, name, digest, mode='mix', options=None):
        self.update(key, status='running')
        self.executor.submit(self.run, key, path, directory, unit, name, digest, mode, options or {})

    def run(self, key, path, directory, unit, name, digest, mode='mix', options=None):
        try:
            if self.predictor is None:
                if mode == 'stems':
                    from stem_pipeline import predict_stems_file
                    predictor = predict_stems_file
                else:
                    from spectra_prediction import predict_file
                    predictor = predict_file
            else:
                predictor = self.predictor
            extra = {**(options or {}), 'cache_root':self.cache_root} if mode == 'stems' else {}
            bundle = predictor(path, prediction_unit=unit, resources=self.resources,
                audio_name=name, sha256=digest,
                progress=lambda message, fraction: self.update(key, message=message, progress=fraction), **extra)
            self.update(key, status='done', progress=1., message='预测完成', result=bundle)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self.update(key, status='error', message=f'{type(exc).__name__}: {exc}', progress=0.)
        finally:
            directory.cleanup()


def make_server(port=8765, *, jobs=None, web_root=None, lab=None):
    jobs = jobs or Jobs()
    web_root = Path(web_root or ROOT / 'spectra_web')
    from lab_pipeline import Lab
    lab = lab or Lab()
    from video_export import VideoExports
    videos=VideoExports(lab)

    def lab_job(key, action, directory=None):
        jobs.update(key,status='running')
        try:
            jobs.resources.clear()
            from stem_separation import release_accelerators
            release_accelerators()
            result=action(lambda message,fraction=0.:jobs.update(key,message=message,progress=fraction))
            jobs.update(key,status='done',result=result,message='实验步骤完成',progress=1.)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            jobs.update(key,status='error',message=f'{type(exc).__name__}: {exc}',progress=0.)
        finally:
            if directory: directory.cleanup()

    class Handler(SimpleHTTPRequestHandler):
        # Reuse the local TCP connection instead of opening one per video frame.
        protocol_version = 'HTTP/1.1'
        disable_nagle_algorithm = True

        def log_request(self,code='-',size='-'):
            # Thousands of successful frame lines can block a Windows console.
            if code==200 and re.fullmatch(r'/api/lab/videos/[0-9a-f]{32}/(?:frame|status)(?:\?.*)?',self.path):return
            super().log_request(code,size)
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_root), **kwargs)

        def allowed_host(self):
            return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def end_headers(self):
            # Local updates must not keep old HTML or renderer modules alive.
            self.send_header('Cache-Control', 'no-store, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('X-Spectra-Build', UI_BUILD)
            super().end_headers()

        def send_head(self):
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
            return super().send_head()

        def send_json(self, value, status=200):
            body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            if status>=400:
                self.send_header('Connection','close');self.close_connection=True
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def send_file(self,path):
            size=path.stat().st_size
            start,end=0,size-1
            partial=False
            requested=self.headers.get('Range')
            if requested:
                found=re.fullmatch(r'bytes=(\d*)-(\d*)',requested)
                if not found or not any(found.groups()):
                    return self.send_json({'error':'无效音频范围。'},416)
                a,b=found.groups()
                start=int(a) if a else max(0,size-int(b))
                end=min(size-1,int(b)) if a and b else size-1
                if start>=size or end<start:
                    self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.send_header('Content-Length','0');self.end_headers();return
                partial=True
            self.send_response(206 if partial else 200)
            types={'.wav':'audio/wav','.json':'application/json; charset=utf-8','.csv':'text/csv; charset=utf-8','.log':'text/plain; charset=utf-8','.mp4':'video/mp4'}
            self.send_header('Content-Type',types.get(path.suffix,'application/octet-stream'))
            self.send_header('Content-Length',str(end-start+1))
            self.send_header('Accept-Ranges','bytes')
            if partial:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            self.send_header('X-Content-Type-Options','nosniff'); self.end_headers()
            try:
                with path.open('rb') as f:
                    f.seek(start);remaining=end-start+1
                    while remaining:
                        data=f.read(min(1024*1024,remaining))
                        if not data:break
                        self.wfile.write(data);remaining-=len(data)
            except (BrokenPipeError,ConnectionResetError):pass

        def do_GET(self):
            if not self.allowed_host():
                return self.send_json({'error': '不支持这个访问地址。'}, 403)
            path = urlsplit(self.path).path
            if path=='/api/lab/defaults':
                try:return self.send_json(lab.defaults())
                except (ValueError,OSError) as exc:return self.send_json({'error':str(exc)},400)
            if path=='/api/lab/runs':
                return self.send_json({'runs':lab.list_runs()})
            match=re.fullmatch(r'/api/lab/runs/([0-9a-f]{32})(?:/(inspect|files|clip|motion)(?:/(.*))?)?',path)
            if match:
                run_id,kind,relative=match.groups()
                try:
                    query=parse_qs(urlsplit(self.path).query)
                    if kind=='files': return self.send_file(lab.file(run_id,unquote(relative or '')))
                    if kind=='motion': return self.send_json(lab.motion_foote(run_id))
                    if kind=='inspect': return self.send_json(lab.inspect(run_id,query.get('stem',['bass'])[0]))
                    if kind=='clip':
                        data,meta=lab.clip(run_id,query.get('stem',['bass'])[0],int(query.get('row',['1'])[0]),query.get('kind',['context'])[0])
                        self.send_response(200);self.send_header('Content-Type','audio/wav');self.send_header('Content-Length',str(len(data)))
                        self.send_header('X-Clip-Samples',f'{meta["start_sample"]}:{meta["end_sample"]}');self.end_headers();self.wfile.write(data);return
                    return self.send_json(lab.snapshot(run_id))
                except (ValueError,FileNotFoundError,KeyError,OSError) as exc:
                    return self.send_json({'error':str(exc)},400 if isinstance(exc,ValueError) else 404)
            if path == '/api/config':
                from spectra_prediction import DEFAULTS
                return self.send_json({'engine': 'spectra-local-v1', 'defaults': DEFAULTS,
                    'capabilities':{'stems_v1':True,'lab_v1':True}, 'lab_entry':'/lab/',
                    'frontend': frontend_metadata(web_root), 'project_directory': str(ROOT)})
            match = re.fullmatch(r'/api/stems/([0-9a-f]{32})/mixture\.wav', path)
            if match:
                playback = jobs.cache_root/match.group(1)/'preview/mixture.wav'
                if not playback.is_file():
                    return self.send_json({'error':'对应的分轨缓存原曲不存在，请重新选择音乐分析。'},404)
                self.send_response(200)
                self.send_header('Content-Type','audio/wav')
                self.send_header('Content-Length',str(playback.stat().st_size))
                self.end_headers()
                try:
                    with playback.open('rb') as f:
                        shutil.copyfileobj(f,self.wfile)
                except (BrokenPipeError,ConnectionResetError):
                    pass
                return
            if path.startswith('/api/jobs/'):
                value = jobs.snapshot(path.rsplit('/', 1)[-1])
                return self.send_json(value or {'error': '任务不存在。'}, 200 if value else 404)
            if path.startswith('/api/'):
                return self.send_json({'error': '接口不存在。'}, 404)
            # Static assets only; never expose the project's weights or Python source.
            return super().do_GET()

        def do_POST(self):
            origin = self.headers.get('Origin')
            allowed_origins = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
            if not self.allowed_host() or (origin and origin not in allowed_origins) or self.headers.get('X-Spectra-Client') != '1':
                return self.send_json({'error': '请从本机 SPECTRA 页面选择音乐。'}, 403)
            parsed = urlsplit(self.path)
            if parsed.path=='/api/lab/defaults':
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if not 0<length<=65536:raise ValueError('默认参数大小无效。')
                    return self.send_json(lab.save_defaults(json.loads(self.rfile.read(length))))
                except (ValueError,OSError) as exc:return self.send_json({'error':str(exc)},400)
            video_create=re.fullmatch(r'/api/lab/runs/([0-9a-f]{32})/video',parsed.path)
            video_action=re.fullmatch(r'/api/lab/videos/([0-9a-f]{32})/(frame|finish|status|cancel)',parsed.path)
            if video_create or video_action:
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if video_create:
                        if not 0<length<=65536:raise ValueError('视频设置大小无效。')
                        return self.send_json(videos.create(video_create.group(1),json.loads(self.rfile.read(length))),201)
                    key,action=video_action.groups()
                    if action=='frame':
                        if not 0<length<=32*1024*1024:raise ValueError('视频帧过大或为空。')
                        index=int(parse_qs(parsed.query).get('index',['-1'])[0])
                        data=self.rfile.read(length)
                        if len(data)!=length:raise ValueError('视频帧上传中断，请重试当前帧。')
                        return self.send_json(videos.append(key,index,data))
                    if length:self.rfile.read(min(length,65536))
                    if action=='finish':return self.send_json(videos.start_finish(key))
                    if action=='status':return self.send_json(videos.status(key))
                    return self.send_json(videos.cancel(key,preserve=parse_qs(parsed.query).get('preserve')==['1']))
                except (ValueError,FileNotFoundError,RuntimeError,OSError) as exc:
                    return self.send_json({'error':str(exc)},400)
                except Exception as exc:
                    import traceback
                    traceback.print_exc()
                    return self.send_json({'error':f'视频服务异常：{type(exc).__name__}: {exc}。请查看启动窗口。'},500)
            action_match=re.fullmatch(r'/api/lab/runs/([0-9a-f]{32})/action',parsed.path)
            if action_match:
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if not 0<length<4*1024*1024:raise ValueError('参数请求大小无效。')
                    options=json.loads(self.rfile.read(length))
                    if not isinstance(options,dict):raise ValueError('请求格式无效。')
                    lab.manifest(action_match.group(1))
                    key=jobs.reserve()
                    jobs.update(key,status='running',message='准备实验步骤…')
                    jobs.executor.submit(lab_job,key,lambda report:lab.action(action_match.group(1),options,report))
                    return self.send_json({'job_id':key},202)
                except (ValueError,FileNotFoundError) as exc:
                    return self.send_json({'error':str(exc)},400)
            is_lab_upload=parsed.path=='/api/lab/upload'
            if parsed.path != '/api/analyze' and not is_lab_upload:
                return self.send_json({'error': '接口不存在。'}, 404)
            unit = parse_qs(parsed.query).get('unit', ['bar'])[0]
            params = parse_qs(parsed.query)
            mode = params.get('mode',['mix'])[0]
            if mode not in ('mix','stems') or (mode == 'stems' and unit != 'bar'):
                return self.send_json({'error':'六声部模式固定按原曲小节预测。'},400)
            try:
                chunk_seconds = float(params.get('chunk_seconds',['0'])[0])
                if chunk_seconds not in (0.,2.,4.):
                    raise ValueError()
            except ValueError:
                return self.send_json({'error':'SW 计算块须为原配置、4秒或2秒。'},400)
            amp=params.get('amp',['1'])[0]
            if amp not in ('0','1'):
                return self.send_json({'error':'无效的 SW 半精度设置。'},400)
            options = dict(chunk_seconds=chunk_seconds,sw_weights=params.get('sw_weights',[None])[0],amp=amp=='1')
            if unit not in ('bar', 'beat'):
                return self.send_json({'error': '无效预测单位。'}, 400)
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                length = 0
            if not 0 < length <= MAX_UPLOAD:
                return self.send_json({'error': '音频为空或超过 1 GB。'}, 413)
            try:
                key = jobs.reserve()
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, 409)
            name = Path(unquote(self.headers.get('X-Audio-Name', 'audio.wav')).replace('\\', '/')).name
            suffix = Path(name).suffix.lower()
            if suffix not in ('.mp3', '.wav', '.wave', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.aif', '.aiff', '.webm', '.mp4'):
                suffix = '.audio'
            directory = tempfile.TemporaryDirectory(prefix='spectra_')
            path = Path(directory.name) / ('input' + suffix)
            try:
                digest = hashlib.sha256()
                remaining = length
                with path.open('wb') as out:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError('上传未完成，请重试。')
                        out.write(chunk)
                        digest.update(chunk)
                        remaining -= len(chunk)
                if is_lab_upload:
                    jobs.update(key,status='running',message='正在导入原曲…')
                    jobs.executor.submit(lab_job,key,lambda report:lab.upload(path,name,digest.hexdigest(),report),directory)
                else:
                    jobs.submit(key, path, directory, unit, name, digest.hexdigest(), mode, options)
                self.send_json({'job_id': key}, 202)
            except Exception as exc:
                directory.cleanup()
                jobs.update(key, status='error', message=str(exc))
                self.send_json({'error': str(exc)}, 400)

    class LabServer(ThreadingHTTPServer):
        def server_close(self):
            videos.close();super().server_close()
    server = LabServer(('127.0.0.1', port), Handler)
    server.videos=videos
    server.jobs = jobs
    return server


def make_available_server(port=8765, **kwargs):
    # Keep existing servers/jobs untouched; launch this folder on a free port.
    for candidate in ([0] if port == 0 else range(port, min(65535, port + 20) + 1)):
        try:
            return make_server(candidate, **kwargs)
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, 10048) and getattr(exc, 'winerror', None) != 10048:
                raise
    raise OSError('附近端口均被占用，请使用 --port 指定其他端口。')


def main():
    parser = argparse.ArgumentParser(description='MusicPoem 本地 CUDA 音乐情绪几何')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--lab', action='store_true', help='打开分阶段实验台，不自动运行完整预测')
    parser.add_argument('--convert', type=Path, help='把原完整预测 JSON 转成网站导入格式，无需重新预测')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.convert:
        from spectra_prediction import make_spectra_bundle
        bundle = make_spectra_bundle(json.loads(args.convert.read_text(encoding='utf-8-sig')))
        destination = args.output or args.convert.with_suffix('.spectra.json')
        destination.write_text(json.dumps(bundle, ensure_ascii=False, allow_nan=False), encoding='utf-8')
        print(destination)
        return
    metadata = frontend_metadata(ROOT / 'spectra_web')
    if metadata['build_id'] != UI_BUILD or metadata['epic_outline_gap_css_px'] != 3:
        raise SystemExit('页面文件未完整更新：请将 spectra_web 文件夹与 spectra_server.py 一起覆盖到同一项目目录。')
    server = make_available_server(args.port)
    entry='lab/' if args.lab else ''
    url = f'http://127.0.0.1:{server.server_port}/{entry}?build={UI_BUILD}&session={uuid.uuid4().hex[:8]}'
    if args.port and server.server_port != args.port:
        print(f'Port {args.port} is occupied; this instance uses {server.server_port}.', flush=True)
    print(f'MusicPoem: {url}\nBuild: {UI_BUILD} / '+('staged experiment workbench' if args.lab else 'six-stem preview')+f'\nProject: {ROOT}\nPage files: {metadata["web_directory"]}\nCUDA / Beat This! final0 / BS Roformer SW / Music2Emo · Ctrl+C to exit', flush=True)
    if not args.no_browser:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.jobs.executor.shutdown(wait=True)


if __name__ == '__main__':
    main()
