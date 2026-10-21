# Third-party materials

The vendored `bs_roformer_infer` source comes from:
https://github.com/openmirlab/bs-roformer-infer
Revision: 95c8de7b0b091d00f064d694bf916a21866c32f5
Version: 0.1.6
License: MIT. Original license is included in the vendor directory.

That implementation acknowledges Phil Wang's lucidrains/BS-RoFormer and the
Band-Split RoPE Transformer research by Wei-Tsung Lu, Ju-Chiang Wang,
Qiuqiang Kong and Yun-Ning Hung. See the vendored README for acknowledgments.

No model checkpoint bytes are distributed in this source package.
The SW checkpoint is obtained from a public Hugging Face mirror at first use,
and verified against the recorded SHA-256 and byte count. The mirror labels
the checkpoint license unknown. Code license and pretrained-weight permission
are separate. The original YAML config is included, with a recorded hash.
