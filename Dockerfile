FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/var/data \
    PORT=10000

# OpenCode's coding tools use git, shell and language/build tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git bash python3 python3-pip make g++ gosu passwd \
    && find /usr/bin /usr/sbin -xdev -type f -perm -4000 -exec chmod u-s {} + \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai typescript typescript-language-server pyright bash-language-server vscode-langservers-extracted yaml-language-server \
    && opencode --version \
    && opencode serve --help >/dev/null \
    && command -v typescript-language-server >/dev/null \
    && command -v pyright >/dev/null \
    && command -v bash-language-server >/dev/null \
    && command -v vscode-html-language-server >/dev/null \
    && command -v vscode-css-language-server >/dev/null \
    && command -v vscode-json-language-server >/dev/null \
    && command -v yaml-language-server >/dev/null

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN chmod 444 /app/opencode/system-prompt.txt /app/opencode/opencode.json \
    && mkdir -p /var/data && chmod 755 /var/data

EXPOSE 10000
# Start as root only so the backend can create isolated Unix identities for
# subscribers. OpenCode itself runs under a different, per-subscriber UID.
CMD ["node", "server.js"]
