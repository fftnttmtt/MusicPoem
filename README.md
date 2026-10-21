# MusicPoem · 音乐情绪与几何实验台

把一首音乐分成六个声部，沿原曲的节拍与小节分析情绪、音高和音量，再生成可播放、可调参、可导出 MP4 的几何画面。当前源码基于 **R56**，包含位置与尺寸的连续运动修正。

本仓库提供运行源码、必要的小型配置与前端资源，**不包含模型权重、歌曲、个人参数、预测结果或虚拟环境**。权重下载后约占 **1.18 GB（十进制）**；安装依赖、音频分轨、缓存与视频还需要额外空间。

## 快速开始（Windows 10/11，64 位）

1. 安装 **Python 3.10 或 3.11（64 位，推荐 3.10）**，安装时勾选 Add Python to PATH。准备 NVIDIA 显卡时先装好显卡驱动。
2. 将仓库完整下载/解压到一个可写目录。建议使用较短的英文路径，例如 `D:\Projects\MusicPoem`。后续命令均在仓库根目录执行。
3. 双击 **`install_gpu.bat`**。它创建本项目自己的 `.venv`，安装匹配的 PyTorch/torchaudio 与项目依赖，并实际运行 CUDA 内核自检。没有 NVIDIA GPU 则用 **`install_cpu.bat`**。
4. 双击 **`download_models.bat`**，等待全部 **5 个权重**下载并校验完成。网络中断后重开可继续；已通过校验的文件会跳过。也可按下表手动下载。
5. 双击 **`start_MusicPoem.bat`**。浏览器会打开本地实验台，通常为 <http://127.0.0.1:8765/lab/>；端口被占用时会自动另选，实际网址见启动窗口。
6. 上传自己的歌曲，检查设置，点击 **“一键执行全部过程”**。无 NVIDIA GPU 时，先把页面里的设备从默认 `cuda` 改成 `cpu` 并保存，再运行分析。
7. 完成后试听、查看分轨/逐拍音高/情绪/过程文件，在 16:9 预览中调参；需要视频时展开 **“导出视频 · 离线逐帧渲染”**。

首次运行需要联网安装依赖和下载权重。前端资源与 Melodia WASM 已随源码提供，不需要 npm 构建、Node、WSL、Basic Pitch 权重或额外的 Melodia 神经网络权重。浏览器音频播放如被拦截，先点击播放按钮。

### 不使用批处理 / Linux

需要对应平台可用的 PyTorch、音频和 mini-racer 二进制包；下面命令是同一安装入口。Windows 路径中的 `.venv/bin/python` 换为 `.venv\Scripts\python.exe`。

```bash
# 二选一；Python 必须是 3.10 / 3.11
python3 setup_env.py --torch auto   # NVIDIA GPU
# python3 setup_env.py --torch cpu

.venv/bin/python download_models.py
.venv/bin/python download_models.py --check-only
.venv/bin/python spectra_server.py --lab
```

也可以用 `bash start_MusicPoem.sh`。无图形界面启动时加 `--no-browser`；端口通过 `--port 8765` 指定。服务只监听本机，用浏览器打开页面，不能直接双击 HTML 代替后端。

## 模型下载与放置位置

下表的路径均**相对于仓库根目录**。不要把 Hugging Face 网页另存为权重，不要把文件名改成带 `(1)` 的名字。无需克隆整个模型仓库，也不要下载 MERT 的 fairseq 等其他格式。

| 模型 | 直接下载 | 放置位置 | 大小 |
|---|---|---|---|
| BTC 和弦特征 | [下载 btc_model_large_voca.pt](https://huggingface.co/amaai-lab/music2emo/resolve/b036e59471583c3d5b30c69e63e8c7323cc36c4a/inference/data/btc_model_large_voca.pt) | `vendor/inference/data/btc_model_large_voca.pt` | 12,229,576 字节 |
| Music2Emo 情绪头 | [下载 J_all.ckpt](https://huggingface.co/amaai-lab/music2emo/resolve/b036e59471583c3d5b30c69e63e8c7323cc36c4a/saved_models/J_all.ckpt) | `vendor/saved_models/J_all.ckpt` | 12,958,092 字节 |
| MERT-v1-95M 特征提取 | [下载 pytorch_model.bin](https://huggingface.co/m-a-p/MERT-v1-95M/resolve/12af15fef9d0ac838c3f475bfbbf26d2060dd4f5/pytorch_model.bin) | `models/MERT-v1-95M/pytorch_model.bin` | 377,552,987 字节 |
| Beat This! final0 节拍/小节 | [下载 final0.ckpt](https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt) | `models/final0.ckpt` | 81,058,141 字节 |
| BS Roformer SW 六声部分离 | [下载 BS-Rofo-SW-Fixed.ckpt](https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/a443a2985534b3bc815ef54a5d446c6a0390f974/BS-Rofo-SW-Fixed.ckpt) | `models/BS-Rofo-SW-Fixed.ckpt` | 699,412,152 字节 |

### 校验与断点续传

```bat
rem Windows：验证本地文件，不访问网络
.venv\Scripts\python.exe download_models.py --check-only
rem 输出每个文件的链接、大小与 SHA-256
.venv\Scripts\python.exe download_models.py --links
```

`models_manifest.json` 固定了上述权重的大小与 SHA-256，以及 Hugging Face 的具体提交版本；同一文件用于下载与校验。Beat This 的官方 URL 不含提交号，因此以固定大小和 SHA-256 锁定文件内容。下载器写入 `.part`，验证成功后才替换目标文件。若上游内容改变，会报错而不会接受新权重。下载失败可重试；如果网络无法访问源站，手动下载到对应位置后再次执行校验。

四个 MERT 小型配套文件（`config.json`、`preprocessor_config.json`、`configuration_MERT.py`、`modeling_MERT.py`）已经放在 `models/MERT-v1-95M/`，其校验也包含在清单中；缺失时下载器可恢复。Music2Emo 的标签、配置、和弦字典与 SW 配置均已随源码提供。

<details>
<summary>5 个权重的 SHA-256</summary>

- `vendor/inference/data/btc_model_large_voca.pt`

  `1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51`

- `vendor/saved_models/J_all.ckpt`

  `deaceb291f7974deb688167d3639b7f6eb66eb0715824668618393777d1e07a5`

- `models/MERT-v1-95M/pytorch_model.bin`

  `a2b8b747f72c06e0595aeae41ae5473f4364938c6b39b2c58be38c48e6bd3fcd`

- `models/final0.ckpt`

  `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`

- `models/BS-Rofo-SW-Fixed.ckpt`

  `24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e`

</details>

## 分析流程与默认行为

1. 在原曲上用 Beat This! `final0` 获取节拍与小节，所有分轨共用同一时间轴。
2. BS Roformer SW 分离人声、鼓、其他伴奏、钢琴、吉他、贝斯，保持各轨的时间对齐。
3. 每种乐器逐小节预测情绪；较短段按 Foote 变化自适应扩展上下文，默认目标 6 秒，情绪模型输入最短 3 秒。原曲也独立分析，生成随时间变化的背景色与整曲色彩标签。
4. X 使用各轨唤醒度；Y 使用各轨旋律音高（先转 MIDI），鼓使用逐拍平均频谱质心。坐标按各轨自身 P5～P95 映射，低置信度或无音高时保持位置。默认混合音高方法：人声/贝斯 pYIN，钢琴/吉他/其他伴奏 PredominantPitchMelodia，带高音偏好；可切换逐拍概括/连续音高跟随。
5. 用稳定的乐器形态、情绪颜色、音量尺寸、描边与肌理生成画面。Foote 调节移动进度，同时平滑位置和尺寸；保留 R56 的速度连续修正。人声在最上层，依次为鼓、其他伴奏、钢琴、吉他、贝斯。

颜色只使用 `calm/romantic/dream/sad/epic/happy/love/nature/energetic` 九个标签，色相角依次为 `180/310/270/240/40/60/330/110/10`。`funny` 禁用，没有 0.3 分数截断。H 使用得分 γ=2 的圆周加权平均；S/V γ=1、Sigmoid k=0、自适应增强强度 0.5，S 输出范围 0.2～1，V 为 0.25～1。颜色过渡从当前小节起点开始，默认最多占相邻起点间隔 15%。

**混音重叠色默认关闭。** 开启后仅对当前画面实际需要的“声部组合×小节”预测，不计算全部组合。改变尺寸、旋转、运动或显示范围后，可点“补齐当前交叠色”；导出前也会检查。这会增加计算时间。

默认设备为 CUDA，强边界阈值 0.7；当前尺寸默认 100% 已采用后期放大的尺寸基准。完整初始参数见 `lab_pipeline.py` 的 `PARAMETERS` / `PRESENTATION_DEFAULTS` 和 `spectra_prediction.py` 的 `DEFAULTS`。页面支持保存为个人默认值；源码包不带个人默认文件。

## 缓存、复现与导出

- 每首歌曲的实验及中间结果保存在 **`spectra_lab/<实验ID>/`**，新歌曲不会统一覆盖旧歌曲。页面可恢复旧实验；相同输入和兼容设置会复用已完成阶段。
- **长期保留/备份整个 `spectra_lab/`**，不要只备份 `mapped.json`。其中包含原音频、分轨、节拍、特征、原始预测、映射和视频/日志等；个人默认在 `spectra_lab/defaults.json`。
- 修改预测参数可能使对应阶段需要重算；改变画面参数通常复用情绪结果。旧版本结果能否复用由各阶段的数据版本检查决定。
- 共享实验复现时，另行提供有权共享的音频、实验目录、页面参数/manifest、源码提交号、`python --version`、`pip freeze` 和 GPU/PyTorch 信息。仓库依赖固定了主要版本，CPU/GPU 浮点运算与平台差异仍可能带来细小差异。
- 视频通过相同场景逻辑离线逐帧渲染，再由 FFmpeg 编码。`imageio-ffmpeg` 提供可执行文件，不要求另装系统 FFmpeg；首次导出请先用较短曲目验证。运行期间保持后端与页面打开。失败时查看实验 `videos/` 中的日志与设置文件。

## 环境与故障排查

- 安装脚本只写本项目 `.venv`。CPU 安装固定 `torch/torchaudio 2.5.1`；GPU 按能力选择匹配的 `cu121: 2.5.1` 或 `cu128: 2.7.1`，实现见 `gpu_compat.py`。驱动必须支持选用的 CUDA 运行时。
- `no kernel image is available`：关闭旧进程，运行 `diagnose_cuda.bat` 查看实际内核测试；可用 `repair_cuda.bat` 重装匹配组合。输出 `cuda_diagnostic.json` 可用于排查。
- 显存不足：减小页面 SW 分块设置（例如 4 秒/2 秒），关闭混音重叠色；CPU 也可运行，但分轨、音高和情绪推理都会慢很多。所需显存与歌曲、分块等设置有关，未限定固定最低显存。
- Melodia 不可用：在项目虚拟环境运行 `python check_melodia.py`。确认 `mini-racer==0.12.4` 与 `vendor/essentia_js/` 完整，避免只复制 Python 文件。
- 本项目不需要 Streamlit/Gradio 启动。`hsv_timeline.py` 等保留部分旧 UI 辅助函数，但当前实验台不调用它们，也未为这些旧 UI 安装 Streamlit。
- 完整真实模型推理需要下载上述权重。本源码包的校验以自动化回归和本地 HTTP/视频通路为主，不能替代你的 Windows、显卡及真实歌曲全流程验证。

## 开发与回归检查

无需下载模型即可运行核心回归（先安装依赖）。下面的 Node 检查只供开发验证，正常使用实验台不需要 Node：

```bash
# Windows 用 .venv\Scripts\python.exe 替换 Python 路径
.venv/bin/python -m unittest test_download_models test_gpu_compat test_lab test_lab_atomic test_spectra_delivery test_video_export
node --test spectra_tests/*.test.js
```

测试中的微型音频、合成预测和 JSON fixtures 仅用于回归，不是待上传歌曲或训练数据。`spectra_web/` 保留服务兼容模块与必要校验资源，不应只上传 `spectra_web/lab/` 子目录。

## 上传 GitHub

解压后将本目录的**内容**放到仓库根目录（README、requirements、启动器与 Python 文件同级），连同 `.gitignore` 和 `.gitattributes` 上传；不需要把 ZIP 自身再上传。之后安装或运行生成的权重、环境、缓存、音频与导出文件已列入 `.gitignore`，不要另行强制加入版本控制。`.gitignore` 不会阻止通过网页手动选中文件上传，网页上传时也只选择本源码包内的文件。

项目来源与各组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。模型权重单独下载，上游权重许可不等同于本项目源码许可。
