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


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("audio", help="path to the audio file")
    parser.add_argument("--model", default="small")
    # "auto" lets whisper detect; anything else is passed through as-is.
    parser.add_argument("--language", default="ko")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write(
            "faster-whisper 가 설치돼 있지 않습니다. "
            "명령 프롬프트에서 `pip install faster-whisper` 를 실행하세요."
        )
        return 2

    # device="auto" picks CUDA when the runtime libraries are present and falls
    # back to CPU otherwise; compute_type="default" lets CTranslate2 choose a
    # precision that the chosen device actually supports.
    model = WhisperModel(args.model, device="auto", compute_type="default")
    segments, _info = model.transcribe(
        args.audio,
        language=None if args.language == "auto" else args.language,
    )
    sys.stdout.write(" ".join(segment.text.strip() for segment in segments).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
