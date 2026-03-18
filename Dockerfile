# Production/docker-compose Dockerfile for SashaSlides services.
#
# This builds a lightweight image with proto compilation and all
# Python dependencies. Used by docker-compose.yml.

FROM python:3.11-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Compile protobufs (for non-Bazel execution)
RUN protoc --python_out=. --pyi_out=. proto/sashaslides.proto

ENV PYTHONPATH=/app

# Default: run the composer server
CMD ["python", "-m", "sashaslides.composer.server"]
