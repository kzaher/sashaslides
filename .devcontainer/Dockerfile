FROM mcr.microsoft.com/devcontainers/base:ubuntu-22.04

# Avoid prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Add deadsnakes PPA for Python 3.11
RUN apt-get update && apt-get install -y software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    python3.11-distutils \
    curl \
    git \
    build-essential \
    protobuf-compiler \
    sqlite3 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Make python3.11 the default python
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1

# Install pip for python3.11
RUN curl -sS https://bootstrap.pypa.io/get-pip.py | python3.11

# Install Bazelisk (provides 'bazel' command, downloads correct Bazel version)
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
    && curl -Lo /usr/local/bin/bazel \
    "https://github.com/bazelbuild/bazelisk/releases/download/v1.19.0/bazelisk-linux-${ARCH}" \
    && chmod +x /usr/local/bin/bazel

# Install Python development tools
RUN pip3 install --no-cache-dir \
    mypy \
    black \
    pytest \
    mypy-protobuf

# Set workspace
WORKDIR /workspace

# requirements.txt is installed at postCreateCommand time
# (workspace is bind-mounted, not COPYed)

ENV PYTHONPATH=/workspace
