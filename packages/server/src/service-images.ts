/**
 * Images local-agent builds for itself (no third-party image to trust): OCR (Tesseract eng+heb with ImageMagick
 * preprocessing and HEIC) and Piper TTS (with a Hebrew voice). Each is a tiny HTTP server on the stdlib.
 */
export const OCR_IMAGE = 'local-agent/ocr:2';
export const OCR_CONTAINER = 'local-agent-ocr';
export const OCR_PORT = 8092;

export const OCR_DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-heb tesseract-ocr-osd imagemagick libheif-examples python3 ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
COPY server.py /app/server.py
EXPOSE 8080
USER nobody
CMD ["python3", "-u", "/app/server.py"]
`;

export const OCR_SERVER = String.raw`
import json, os, subprocess, tempfile, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

def run(cmd, timeout=120):
    return subprocess.run(cmd, capture_output=True, timeout=timeout)

def langs():
    out = run(["tesseract", "--list-langs"]).stdout.decode()
    return [l.strip() for l in out.splitlines()[1:] if l.strip()]

def decode(raw, tmp):
    """Write the upload, convert HEIC with heif-convert, return a path ImageMagick can read."""
    src = os.path.join(tmp, "in")
    with open(src, "wb") as f:
        f.write(raw)
    head = raw[:32]
    if b"ftypheic" in head or b"ftypheix" in head or b"ftypmif1" in head or b"ftyphevc" in head or b"ftypmsf1" in head:
        jpg = os.path.join(tmp, "heic.jpg")
        r = run(["heif-convert", "-q", "95", src, jpg])
        if r.returncode != 0:
            raise ValueError("Could not read this HEIC photo: " + r.stderr.decode()[-200:])
        return jpg
    return src

def prepare(src, out, gray):
    # EXIF rotation, then (for OCR) grayscale, contrast stretch and deskew, capped at 2400 px.
    cmd = ["convert", src + "[0]", "-auto-orient", "-resize", "2400x2400>"]
    if gray:
        cmd += ["-colorspace", "Gray", "-normalize", "-deskew", "40%", "+repage"]
    else:
        cmd += ["-quality", "90"]
    r = run(cmd + [out])
    if r.returncode != 0:
        raise ValueError("Could not read this image: " + r.stderr.decode()[-200:])

def ocr(path, lang, psm):
    r = run(["tesseract", path, "stdout", "-l", lang, "--psm", str(psm), "tsv"])
    if r.returncode != 0:
        raise ValueError("Tesseract failed: " + r.stderr.decode()[-300:])
    lines, confs, current, key = [], [], [], None
    low = 0
    for row in r.stdout.decode("utf-8", "replace").splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12:
            continue
        level, block, par, line, conf, text = cols[0], cols[2], cols[3], cols[4], float(cols[10]), cols[11]
        if level != "5":
            continue
        k = (block, par, line)
        if k != key:
            if current:
                lines.append(" ".join(current))
            current, key = [], k
        if text.strip():
            current.append(text)
            if conf >= 0:
                confs.append(conf)
                if conf < 60:
                    low += 1
    if current:
        lines.append(" ".join(current))
    text = "\n".join(lines).replace("\u200e", "").replace("\u200f", "")
    return text, (sum(confs) / len(confs) if confs else 0.0), len(confs), low

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self.send(200, {"ok": True, "langs": langs(), "heic": True, "engine": run(["tesseract", "--version"]).stdout.decode().splitlines()[0]})
        self.send(404, {"error": "not found"})
    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        size = int(self.headers.get("content-length") or 0)
        if size <= 0 or size > 40 * 1024 * 1024:
            return self.send(413, {"error": "Send an image up to 40 MB."})
        raw = self.rfile.read(size)
        started = time.time()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                src = decode(raw, tmp)
                if url.path == "/prepare":
                    out = os.path.join(tmp, "out.jpg")
                    prepare(src, out, gray=False)
                    with open(out, "rb") as f:
                        return self.send(200, f.read(), "image/jpeg")
                if url.path == "/ocr":
                    out = os.path.join(tmp, "out.png")
                    prepare(src, out, gray=True)
                    lang = (q.get("lang") or ["eng+heb"])[0]
                    allowed = set(langs())
                    if not all(part in allowed for part in lang.split("+")):
                        return self.send(400, {"error": "Unknown language " + lang})
                    text, conf, words, low = ocr(out, lang, int((q.get("psm") or ["3"])[0]))
                    return self.send(200, {"text": text, "confidence": round(conf, 1), "words": words, "lowWords": low, "ms": int((time.time() - started) * 1000)})
        except ValueError as e:
            return self.send(422, {"error": str(e)})
        except subprocess.TimeoutExpired:
            return self.send(504, {"error": "OCR took too long."})
        self.send(404, {"error": "not found"})

ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
`;

export const PIPER_IMAGE = 'local-agent/piper:2';
export const PIPER_CONTAINER = 'local-agent-piper';
export const PIPER_PORT = 8093;
/** Voices baked into the image: Hebrew first (Kokoro has none), plus an English one. */
export const PIPER_VOICES = { he: 'he_IL-saspeech-medium', en: 'en_US-lessac-medium' } as const;

export const PIPER_DOCKERFILE = `FROM python:3.11-slim
RUN pip install --no-cache-dir "piper-tts==1.3.0"
RUN mkdir -p /voices && cd /voices && python3 -m piper.download_voices --data-dir /voices ${PIPER_VOICES.he} ${PIPER_VOICES.en}
# The Hebrew voice was trained on phonikud phonemes ("hebrew"), which piper-tts 1.3 cannot load; espeak-ng's Hebrew
# phonemizer gives the same IPA symbol set, so speech is understandable without the extra diacritizer model.
RUN sed -i 's/"phoneme_type": *"hebrew"/"phoneme_type": "espeak"/' /voices/${PIPER_VOICES.he}.onnx.json
COPY server.py /app/server.py
EXPOSE 8080
USER nobody
CMD ["python3", "-u", "/app/server.py"]
`;

export const PIPER_SERVER = String.raw`
import io, json, os, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from piper import PiperVoice

VOICES = {}
for name in os.listdir("/voices"):
    if name.endswith(".onnx"):
        VOICES[name[:-5]] = os.path.join("/voices", name)
LOADED = {}

def voice(name):
    if name not in LOADED:
        LOADED[name] = PiperVoice.load(VOICES[name])
    return LOADED[name]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path.startswith("/health"):
            return self.send(200, {"ok": True, "voices": sorted(VOICES)})
        self.send(404, {"error": "not found"})
    def do_POST(self):
        size = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(size) or b"{}")
        text, name = str(body.get("text", ""))[:3000], body.get("voice")
        if not text.strip():
            return self.send(400, {"error": "No text."})
        if name not in VOICES:
            return self.send(400, {"error": "Unknown voice", "voices": sorted(VOICES)})
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            voice(name).synthesize_wav(text, w)
        self.send(200, buf.getvalue(), "audio/wav")

ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
`;
