# agent-service — Python 3.11 + Flask (Onyx, guardrail engine, OTP gate, webhooks)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# App source (context is the repo root; agent-service is standalone Python).
COPY apps/agent-service/requirements.txt apps/agent-service/requirements.txt
RUN pip install --no-cache-dir -r apps/agent-service/requirements.txt

COPY apps/agent-service/ apps/agent-service/

WORKDIR /app/apps/agent-service

EXPOSE 5000

CMD ["python3", "app.py"]
