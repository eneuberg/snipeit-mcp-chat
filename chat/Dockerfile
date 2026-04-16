FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Node + Claude Code CLI — required for subscription-mode auth (claude-agent-sdk
# talks to the local `claude` binary which holds the OAuth session). Harmless
# and dormant in API-key mode.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install .

COPY app.py chainlit.md ./
COPY .chainlit ./.chainlit

# Pin UID 1000 so a bind-mounted host ~/.claude owned by a UID-1000 host user
# (the common case for a single-user Linux workstation) is readable.
RUN useradd --create-home --uid 1000 --shell /bin/bash appuser \
    && mkdir -p /data /home/appuser/.claude \
    && chown -R appuser:appuser /app /data /home/appuser/.claude
USER appuser

EXPOSE 8000

CMD ["chainlit", "run", "app.py", "--host", "0.0.0.0", "--port", "8000", "--headless"]
