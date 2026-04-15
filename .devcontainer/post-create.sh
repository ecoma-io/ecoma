#!/bin/bash

sudo apt-get update
sudo apt-get install -y yamllint

# Install gitleaks
GITLEAKS_VERSION=$(curl -s "https://api.github.com/repos/gitleaks/gitleaks/releases/latest" | grep -Po '"tag_name": "v\K[0-9.]+')
TMP_ARCHIVE="/tmp/gitleaks.tar.gz"
wget -qO "$TMP_ARCHIVE" "https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
sudo tar xf "$TMP_ARCHIVE" -C /usr/local/bin gitleaks
rm -f "$TMP_ARCHIVE"

# Install GitHub CLI
(type -p wget > /dev/null || (sudo apt update && sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y

# Install kubectl
KUBECTL_TMP="/tmp/kubectl"
curl -fsSL -o "$KUBECTL_TMP" "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x "$KUBECTL_TMP"
sudo mv "$KUBECTL_TMP" /usr/local/bin/

pnpm install --frozen-lockfile || true
pipx install poetry
