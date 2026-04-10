FROM --platform=linux/amd64 mcr.microsoft.com/devcontainers/typescript-node:22-bookworm

# Install Chrome stable + Xvfb for virtual display
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 \
    libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libxshmfence1 xdg-utils libpango-1.0-0 libcairo2 libxkbcommon0 \
    xvfb dbus-x11 procps x11vnc \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install noVNC + websockify for browser-based VNC access
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC \
    && git clone --depth 1 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify \
    && ln -s /opt/noVNC/vnc_lite.html /opt/noVNC/index.html

# Chrome profile directory
RUN mkdir -p /home/node/chrome-profile && chown node:node /home/node/chrome-profile

RUN npm install -g @anthropic-ai/claude-code @bazel/bazelisk
