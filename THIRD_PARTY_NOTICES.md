# Third-party components and provenance

This source snapshot does not assign a new blanket license to all files. Preserve the upstream notices and consult each upstream license/model card. No neural model checkpoint bytes are shipped. The original application author's overall license has not been selected in this snapshot.

| Component | Source / revision | License and included notices |
|---|---|---|
| Music2Emo code, configuration, tag list and two checkpoints | [amaai-lab/music2emo](https://huggingface.co/amaai-lab/music2emo/tree/b036e59471583c3d5b30c69e63e8c7323cc36c4a), revision `b036e59471583c3d5b30c69e63e8c7323cc36c4a` | Upstream model card declares Apache-2.0; card preserved as `vendor/README.md`. Adapter patches are in `backend.py`; vendored `vendor/music2emo.py` is retained for exact-source checks. |
| MERT-v1-95M checkpoint and accompanying custom code/config | [m-a-p/MERT-v1-95M](https://huggingface.co/m-a-p/MERT-v1-95M), revision `12af15fef9d0ac838c3f475bfbbf26d2060dd4f5` | Model card declares **CC-BY-NC-4.0**. Bundled source retains its own MIT headers. The source headers do not override the model-weight license. |
| Beat This! code and published model weights | [CPJKU/beat_this](https://github.com/CPJKU/beat_this), installed `beat-this==1.1.0`; fixed `final0` digest in `models_manifest.json` | Official README declares MIT for code and weights; copy included at `models/LICENSE-BeatThis.txt`. |
| BS Roformer inference code | [openmirlab/bs-roformer-infer](https://github.com/openmirlab/bs-roformer-infer), version 0.1.6, revision `95c8de7b0b091d00f064d694bf916a21866c32f5` | MIT; original license, attribution and README under `stem_separator/vendor/bs_roformer_infer/`. Additional provenance in `stem_separator/THIRD_PARTY_NOTICES.md`. |
| BS Roformer SW checkpoint | [enerjazzer/BS-ROFO-SW-Fixed](https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/tree/a443a2985534b3bc815ef54a5d446c6a0390f974), revision `a443a2985534b3bc815ef54a5d446c6a0390f974` | Mirror labels license **unknown**. Checkpoint permissions are separate from the MIT inference code. Exact checksum is in the manifest. Original YAML is bundled at `stem_separator/model_config.yaml`. |
| Essentia.js / Essentia | [MTG/essentia.js](https://github.com/MTG/essentia.js), package 0.1.3 | **AGPL-3.0-or-later**; full license and provenance in `vendor/essentia_js/`. Core and WASM distribution files are unmodified and required by Melodia. |
| MERT/BTC transformer support code | Upstream Music2Emo package, `vendor/model/` and `vendor/utils/` | Preserve the inline author/copyright notices and upstream model card. |

Other Python dependencies (PyTorch, torchaudio, transformers, librosa, mini-racer, imageio-ffmpeg and others) are installed separately through `requirements.txt` and the installer and keep their respective upstream licenses. FFmpeg distribution terms are supplied by imageio-ffmpeg. No training dataset, user song, personal prediction cache or exported video is part of this repository package.

## Reproducibility manifest

- `models_manifest.json`: 5 external checkpoints and 4 bundled MERT support files, destinations, URLs, sizes and SHA-256 values.
- Music2Emo upstream commit is also recorded in `upstream_revision.txt`.
- SW original YAML SHA-256: `f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b` (verified by the runner).
- Application: MusicPoem; code baseline: R56 (previously named SPECTRA). The repository package removes historical app entrypoints and documentation; its shared visual/inference implementation is retained. Packaging adds a unified model downloader and installation/usage documentation.
