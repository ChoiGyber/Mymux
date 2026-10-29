"""Transcribe one audio file with faster-whisper and print the text.

Bundled with Mymux and invoked as:

    python.exe whisper_wrapper.py <audio.wav> --model small --language ko

It exists so the Python route needs nothing from the user beyond
`pip install faster-whisper`. Mymux used to require a purpose-built
`faster-whisper.exe` that it never shipped and never explained, so the local
voice path could not be set up without writing this file yourself.

Output is the transcript on stdout and nothing else; anything on stderr is
shown to the user as the failure reason.
"""

import argparse
import sys


def load_audio(path: str):
    """Return audio in the form WhisperModel.transcribe takes.

    Mymux always sends 16 kHz mono 16-bit WAV, which is read here directly. The
    fallback (the path itself) goes through faster-whisper's PyAV decoder, and
    that breaks whenever pip resolves a PyAV newer than the faster-whisper
    release was written for (av 19 dropped the `metadata_errors` argument it
    passes), so the normal route must not depend on it.
    """
    try:
        import wave

        import numpy as np

        with wave.open(path, "rb") as wav:
            if (
                wav.getsampwidth() == 2
                and wav.getnchannels() == 1
                and wav.getframerate() == 16000
            ):
                pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
                return pcm.astype(np.float32) / 32768.0
    except Exception:
        pass
    return path


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("audio", nargs="?", help="path to the audio file")
    parser.add_argument("--model", default="small")
    # "auto" lets whisper detect; anything else is passed through as-is.
    parser.add_argument("--language", default="ko")
    # Only download and load the model, so the first dictation is not the one
    # that waits minutes for it. Used by Mymux's one-click setup.
    parser.add_argument("--prefetch", action="store_true")
    args = parser.parse_args()
    if not args.prefetch and not args.audio:
        parser.error("audio file is required unless --prefetch is given")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write(
            "faster-whisper 가 설치돼 있지 않습니다. "
            "명령 프롬프트에서 `pip install faster-whisper` 를 실행하세요."
        )
        return 2

    audio = None if args.prefetch else load_audio(args.audio)
    language = None if args.language == "auto" else args.language

    def run(device: str) -> str:
        # compute_type="auto" takes the fastest precision the device supports
        # (int8 on CPU) instead of converting the float16 weights to float32.
        model = WhisperModel(args.model, device=device, compute_type="auto")
        if args.prefetch:
            return "ok"
        segments, _info = model.transcribe(audio, language=language)
        # Segments are decoded lazily, so a broken CUDA runtime only fails here.
        return " ".join(segment.text.strip() for segment in segments).strip()

    # device="auto" picks CUDA whenever the driver shows a GPU, but the cuBLAS /
    # cuDNN libraries it needs are a separate install most machines lack, and
    # that surfaces as an error partway through decoding. Fall back to CPU
    # rather than fail on a machine that has a GPU and nothing to run it with.
    try:
        text = run("auto")
    except RuntimeError as error:
        if not any(k in str(error).lower() for k in ("cublas", "cudnn", "cuda")):
            raise
        text = run("cpu")
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
