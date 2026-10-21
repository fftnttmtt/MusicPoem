"""Meaningful checks for sample alignment, tail coverage and six-channel ordering."""
import tempfile
from pathlib import Path
import unittest

import torch

from bs_roformer_test import STEMS, infer_chunks, load_config, verify_weights


class KnownStemModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("gains", torch.arange(1, 7, dtype=torch.float32) / 21)

    def forward(self, audio):
        return audio[:, None] * self.gains[None, :, None, None]


class ChunkingTests(unittest.TestCase):
    def test_short_exact_and_multi_chunk_alignment(self):
        torch.manual_seed(7)
        model = KnownStemModel()
        for overlap in (2, 4):
            for length in (1, 20, 64, 65, 127, 200):
                with self.subTest(length=length, overlap=overlap):
                    mix = torch.randn(2, length)
                    result = infer_chunks(model, mix, device="cpu", chunk_size=64, overlap=overlap)
                    expected = mix[None] * model.gains[:, None, None]
                    self.assertEqual(tuple(result.shape), (6, 2, length))
                    torch.testing.assert_close(result, expected)
                    torch.testing.assert_close(result.sum(0), mix)

    def test_sw_config_has_exact_six_stems_and_rate(self):
        config = load_config()
        self.assertEqual(tuple(config.training.instruments), STEMS)
        self.assertEqual(config.model.num_stems, 6)
        self.assertEqual(config.audio.sample_rate, 44100)
        self.assertEqual(config.audio.chunk_size % config.model.stft_hop_length, 0)

    def test_rejects_wrong_checkpoint_instead_of_loading_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "not-the-sw-model.ckpt"
            path.write_bytes(b"not a checkpoint")
            with self.assertRaises(ValueError):
                verify_weights(path)


if __name__ == "__main__":
    unittest.main()
