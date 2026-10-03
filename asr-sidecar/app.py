"""OpenAI-compatible transcription proxy in front of a vLLM Qwen3-ASR server.

Two jobs the upstream cannot do itself:

1. Decode whatever container the browser produced. Chrome on macOS/Android records
   Opus in WebM, which the upstream's ``soundfile`` read rejects with
   ``Format not recognised`` (HTTP 500). Everything is transcoded to 16 kHz mono wav
   before it is forwarded, so every browser takes the same path.
2. Strip the model's raw ``language <Lang><asr_text>`` prefix. vLLM's transcription
   handler returns the generation verbatim; ``qwen_asr`` only applies
   ``parse_asr_output`` in its inference layer, never on the server path.

The response contract is fixed by LibreChat's STT service, which reads
``response.data.text`` and treats anything else as a failure. Upstream error bodies
are never relayed: they can echo dictated audio, and the caller surfaces provider
text to the browser.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import requests
from flask import Flask, jsonify, request

ASR_TEXT_TAG = "<asr_text>"

UPSTREAM_URL = os.environ.get(
    "UPSTREAM_URL", "http://qwen3-asr:80/v1/audio/transcriptions"
)
ASR_MODEL = os.environ.get("ASR_MODEL", "qwen-asr")
UPSTREAM_API_KEY = os.environ.get("UPSTREAM_API_KEY", "")
SIDECAR_API_KEY = os.environ.get("SIDECAR_API_KEY", "")
UPSTREAM_TIMEOUT_SECONDS = float(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "300"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(256 * 1024 * 1024)))
SAMPLE_RATE = int(os.environ.get("SAMPLE_RATE", "16000"))
FFMPEG_TIMEOUT_SECONDS = float(os.environ.get("FFMPEG_TIMEOUT_SECONDS", "120"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [asr-sidecar] %(message)s",
)
log = logging.getLogger("asr-sidecar")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


def error(message: str, status: int):
    """A stable, content-free failure the caller can surface to the user."""
    return jsonify({"error": {"message": message, "type": "sidecar_error", "code": status}}), status


def authorized() -> bool:
    if not SIDECAR_API_KEY:
        return True
    header = request.headers.get("Authorization", "")
    return header == f"Bearer {SIDECAR_API_KEY}"


def strip_prefix(raw: str) -> str:
    """Return the transcript, dropping the ``language <Lang><asr_text>`` prefix.

    Mirrors ``qwen_asr.inference.utils.parse_asr_output``: silence arrives as
    ``language None<asr_text>``, which must become an empty string rather than the
    word ``None``. Text with no tag at all is passed through, since an older build
    or a forced-language prompt may already emit a bare transcript.
    """
    if ASR_TEXT_TAG in raw:
        return raw.split(ASR_TEXT_TAG, 1)[1].strip()
    return raw.strip()


def transcode(source: Path, destination: Path) -> tuple[bool, str]:
    """Decode any input container to 16 kHz mono wav. Returns (ok, ffmpeg stderr)."""
    command = [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "wav",
        str(destination),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "ffmpeg timed out"
    if completed.returncode != 0:
        # ffmpeg diagnostics name codecs and paths, never spoken content.
        return False, (completed.stderr or "").strip()[:500]
    return True, ""


@app.get("/healthz")
def healthz():
    return jsonify({"status": "ok", "upstream": UPSTREAM_URL, "model": ASR_MODEL})


@app.post("/v1/audio/transcriptions")
def transcribe():
    if not authorized():
        log.warning("rejected unauthenticated request from %s", request.remote_addr)
        return error("unauthorized", 401)

    upload = request.files.get("file")
    if upload is None or not upload.stream:
        return error("no audio file in the multipart body", 400)

    model = (request.form.get("model") or ASR_MODEL).strip() or ASR_MODEL
    started = time.monotonic()

    workdir = Path(tempfile.mkdtemp(prefix="asr-sidecar-"))
    source = workdir / "input"
    wav = workdir / "audio.wav"
    try:
        upload.save(source)
        size = source.stat().st_size
        if size == 0:
            return error("uploaded audio is empty", 400)

        # Names the client and the upstream this request was routed to, so a
        # transcription that bypasses the sidecar entirely is visible as a gap
        # here rather than inferred from an upstream log line.
        log.info(
            "transcribe from %s: %s (%d bytes, model=%s) -> %s",
            request.remote_addr,
            upload.filename,
            size,
            model,
            UPSTREAM_URL,
        )

        ok, detail = transcode(source, wav)
        if not ok:
            log.warning("decode failed: %s", detail)
            return error("could not decode the uploaded audio", 400)

        headers = {"Authorization": f"Bearer {UPSTREAM_API_KEY}"} if UPSTREAM_API_KEY else {}
        data = {"model": model}
        language = (request.form.get("language") or "").strip()
        if language:
            data["language"] = language

        with wav.open("rb") as handle:
            files = {"file": ("audio.wav", handle, "audio/wav")}
            try:
                upstream = requests.post(
                    UPSTREAM_URL,
                    files=files,
                    data=data,
                    headers=headers,
                    timeout=UPSTREAM_TIMEOUT_SECONDS,
                )
            except requests.RequestException as exc:
                log.error("upstream unreachable: %s", type(exc).__name__)
                return error("transcription backend unreachable", 502)

        if upstream.status_code != 200:
            # The upstream body can echo dictated audio, so only the status travels.
            log.error("upstream returned HTTP %s", upstream.status_code)
            return error(f"transcription backend returned HTTP {upstream.status_code}", 502)

        try:
            payload = upstream.json()
        except ValueError:
            log.error("upstream response was not JSON")
            return error("transcription backend returned an unreadable response", 502)

        raw = payload.get("text")
        if not isinstance(raw, str):
            log.error("upstream response has no text field")
            return error("transcription backend returned no transcript", 502)

        text = strip_prefix(raw)
        elapsed = time.monotonic() - started
        log.info("transcribed %s chars in %.2fs (model=%s)", len(text), elapsed, model)
        return jsonify({"text": text, "usage": payload.get("usage")})
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.errorhandler(413)
def too_large(_error):
    return error("uploaded audio is too large", 413)


if __name__ == "__main__":
    # Development entry point only; the image runs gunicorn.
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required but was not found on PATH")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
