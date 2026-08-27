FROM python:3.12-slim

# psycopg2-binary rather than building from source: no compiler in the image,
# and this app is not doing anything exotic with libpq.
RUN pip install --no-cache-dir --root-user-action=ignore \
      "psycopg2-binary==2.9.9" "flask==3.0.3" "gunicorn==22.0.0" "requests==2.32.3"

WORKDIR /app
COPY app.py collector.py schema.sql ./
COPY docker/collector-loop.sh /usr/local/bin/collector-loop
RUN chmod +x /usr/local/bin/collector-loop \
 && useradd --system --uid 10001 clio \
 && mkdir -p /data && chown clio /data
USER clio

ENV CLIO_AUTH_FILE=/data/webauth
EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "30", "app:app"]
