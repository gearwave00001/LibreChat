FROM python:3.12-slim

# ffmpeg is the whole reason this image is built rather than bind-mounted: the
# sidecar must decode whatever container the browser produced.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

ENV PORT=8080
EXPOSE 8080

# Two workers so a long transcription does not block health checks and short requests.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "600", "--access-logfile", "-", "app:app"]
