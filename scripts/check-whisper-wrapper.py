"""Exercise Mymux's local voice CLI without models, downloads, or a GPU.

Run with: python scripts/check-whisper-wrapper.py
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "crates/mycli-desktop/resources/whisper_wrapper.py"
TRANSCRIPT = "안녕하세요 음성 입력"
FAKE_WHISPER = '''
import json
import os
from types import SimpleNamespace

def record(value):
    with open(os.environ["WHISPER_TEST_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps(value) + "\\n")

class WhisperModel:
    def __init__(self, model, device, compute_type):
        record({"event": "load", "model": model, "device": device, "compute_type": compute_type})
        if os.environ.get("WHISPER_TEST_ERROR") == "model":
            raise RuntimeError("Invalid model size")
        self.device = device

    def transcribe(self, audio, language, task):
        record({"event": "transcribe", "language": language, "task": task})
        def segments():
            if os.environ.get("WHISPER_TEST_ERROR") == "cuda" and self.device == "auto":
                raise RuntimeError("cublas64_12.dll CUDA runtime unavailable")
            yield SimpleNamespace(text=" 안녕하세요 ")
            yield SimpleNamespace(text=" 음성 입력 ")
        return segments(), None
'''


class WrapperContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mymux whisper test ")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.log = self.work / "calls.jsonl"
        (self.work / "faster_whisper.py").write_text(FAKE_WHISPER, encoding="utf-8")
        # A decoder-independent fixture; load_audio falls back to passing its
        # path to the mocked transcriber, so no numpy/PyAV install is needed.
        self.audio = self.work / "input recording.wav"
        self.audio.write_bytes(b"fixture")

    def invoke(self, *args, error="", stdio_encoding="utf-8"):
        env = os.environ.copy()
        env.update(
            PYTHONPATH=str(self.work),
            PYTHONUTF8="1",
            PYTHONIOENCODING=stdio_encoding,
            WHISPER_TEST_LOG=str(self.log),
            WHISPER_TEST_ERROR=error,
        )
        return subprocess.run(
            [sys.executable, str(WRAPPER), *map(str, args)],
            cwd=self.work,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
        )

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_exact_standalone_flags_write_utf8_transcript_in_output_dir(self):
        # Match voice.rs, including its input.wav filename and a directory
        # different from both the working directory and the audio directory.
        audio = self.work / "input.wav"
        audio.write_bytes(b"fixture")
        output = self.work / "output files"
        result = self.invoke(
            audio, "--model", "small", "--language", "ko", "--task", "transcribe",
            "--output_format", "txt", "--output_dir", output,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, TRANSCRIPT)
        self.assertEqual((output / "input.txt").read_bytes(), TRANSCRIPT.encode("utf-8"))
        self.assertFalse((self.work / "input.txt").exists())
        self.assertEqual(self.calls(), [
            {"event": "load", "model": "small", "device": "auto", "compute_type": "auto"},
            {"event": "transcribe", "language": "ko", "task": "transcribe"},
        ])

    def test_python_mode_keeps_stdout_only_contract_and_paths_with_spaces(self):
        result = self.invoke(self.audio, "--model", "base", "--language", "en")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, TRANSCRIPT)
        self.assertFalse(list(self.work.glob("*.txt")))
        self.assertEqual(self.calls()[0]["model"], "base")
        self.assertEqual(self.calls()[1]["language"], "en")

    def test_auto_language_is_passed_as_none(self):
        result = self.invoke(self.audio, "--language", "auto")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.calls()[1]["language"])

    def test_stdout_is_utf8_even_when_host_stdio_defaults_to_ascii(self):
        result = self.invoke(self.audio, stdio_encoding="ascii")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, TRANSCRIPT)

    def test_prefetch_loads_model_without_audio_or_transcription_file(self):
        output = self.work / "unused output"
        result = self.invoke("--prefetch", "--model", "small", "--output_dir", output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "ok")
        self.assertEqual([call["event"] for call in self.calls()], ["load"])
        self.assertFalse(output.exists())

    def test_cuda_failure_during_lazy_decode_retries_cpu(self):
        result = self.invoke(self.audio, error="cuda")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, TRANSCRIPT)
        self.assertEqual(
            [call["device"] for call in self.calls() if call["event"] == "load"],
            ["auto", "cpu"],
        )

    def test_non_cuda_failure_stays_error_and_does_not_write_transcript(self):
        output = self.work / "failed output"
        result = self.invoke(self.audio, "--output_dir", output, error="model")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid model size", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(len(self.calls()), 1)
        self.assertFalse(output.exists())

    def test_help_and_invalid_arguments_do_not_load_a_model(self):
        self.assertEqual(self.invoke("--help").returncode, 0)
        for args in [[], [self.audio, "--task", "translate"],
                     [self.audio, "--output_format", "srt"]]:
            with self.subTest(args=args):
                self.assertEqual(self.invoke(*args).returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_spec_uses_bundled_wrapper_from_unrelated_working_directory(self):
        captured = {}

        def analysis(scripts, **kwargs):
            captured["scripts"] = scripts
            return type("AnalysisResult", (), dict(pure=[], scripts=[], binaries=[], datas=[]))()

        spec = ROOT / "faster-whisper.spec"
        # PyInstaller executes the spec without a guaranteed __file__ global.
        scope = {"SPECPATH": str(ROOT), "Analysis": analysis,
                 "PYZ": lambda *args, **kwargs: None,
                 "EXE": lambda *args, **kwargs: None}
        previous = Path.cwd()
        try:
            os.chdir(self.work)
            exec(compile(spec.read_text(encoding="utf-8"), str(spec), "exec"), scope)
        finally:
            os.chdir(previous)
        self.assertEqual(captured["scripts"], [str(WRAPPER)])
        self.assertTrue(Path(captured["scripts"][0]).is_file())


if __name__ == "__main__":
    unittest.main()
