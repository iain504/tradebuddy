# mt-monitor collector
# Build: docker build -t mt-monitor-collector .
# Run:   docker run --rm -e APP_URL=... -e INGEST_TOKEN=... -p 8000:8000 mt-monitor-collector
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY collector.py ./

# Non-root user
RUN useradd --system --uid 10001 --no-create-home collector \
    && chown -R collector:collector /app
USER collector

EXPOSE 8000

# Minimal healthcheck using stdlib only (no curl in slim image)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; \
r=urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4); \
sys.exit(0 if r.status==200 else 1)" || exit 1

CMD ["python", "collector.py"]
