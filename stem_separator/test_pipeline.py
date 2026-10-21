"""Integration checks for decoding, relative levels and aligned exports; no weights needed."""
import argparse
import os
from pathlib import Path
import tempfile
import unittest
import wave

import numpy as np
import soundfile as sf

from audio_io import decode_audio, export_audio, nonnegative


class PipelineTests(unittest.TestCase):
    def test_decode_offset_duration_stereo_and_sample_rate(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "有 空格的输入.wav"
            sr = 22050
            # Quiet then loud halves: check that seeking actually selects the second half.
            phase = np.arange(sr * 2) / sr
            mono = np.sin(2 * np.pi * 440 * phase) * np.where(phase < 1, 0.1, 0.6)
            with wave.open(str(source), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(sr)
                wav.writeframes((mono * 32767).astype("<i2").tobytes())
            audio = decode_audio(source, start=1.1, duration=0.5)
            self.assertEqual(audio.shape, (22050, 2))
            self.assertTrue(np.isfinite(audio).all())
            self.assertGreater(float(np.sqrt(np.mean(audio**2))), 0.25)
            np.testing.assert_allclose(audio[:, 0], audio[:, 1], atol=1e-7)
            remainder = decode_audio(source, start=1.1, duration=0)
            self.assertAlmostEqual(len(remainder) / 44100, 0.9, places=3)
            with self.assertRaises(ValueError):
                decode_audio(source, start=99, duration=1)

    def test_float_export_and_common_preview_gain(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            phase = np.arange(4410) / 44100
            loud = np.repeat((1.5 * np.sin(2 * np.pi * 440 * phase))[:, None], 2, axis=1).astype("float32")
            quiet = loud * 0.1
            mix = loud + quiet
            gain, _ = export_audio(output, 44100, mix, {"vocals": loud, "other": quiet})
            self.assertLess(gain, 1)
            for name, original in {"mixture": mix, "vocals": loud, "other": quiet}.items():
                data, sr = sf.read(output / f"{name}.wav", dtype="float32", always_2d=True)
                self.assertEqual(sr, 44100)
                self.assertEqual(sf.info(output / f"{name}.wav").subtype, "FLOAT")
                np.testing.assert_array_equal(data, original)
                preview, _ = sf.read(output / "preview" / f"{name}.wav", always_2d=True)
                np.testing.assert_allclose(preview, original * gain, atol=3.1e-5)
            self.assertGreater(float(np.max(np.abs(sf.read(output / "vocals.wav")[0]))), 1)

    def test_invalid_times_rejected(self):
        for value in ("-1", "nan", "inf", "-inf"):
            with self.assertRaises(argparse.ArgumentTypeError):
                nonnegative(value)


if __name__ == "__main__":
    unittest.main()
