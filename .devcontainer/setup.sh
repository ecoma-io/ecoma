#!/bin/bash
set -e

# Define temporary directory
TMP_DIR="/tmp/devcontainer-setup"
mkdir -p "$TMP_DIR"



# Update package list
echo "=============================="
echo "🚀 Updating required packages..."
sudo apt-get update -y
echo "✅ system is up-to-date"
echo "Installing packages..."
sudo apt-get install -y curl git jq
echo "✅ common tools installed"


# Install kubectl
echo "=============================="
echo "🚀 Installing kubectl..."
if [ -f /usr/local/bin/kubectl ]; then
    echo "✅ kubectl is already installed"
else   
    KUBECTL_BIN="$TMP_DIR/kubectl"
    curl -Lo "$KUBECTL_BIN" "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
    chmod +x "$KUBECTL_BIN"
    sudo mv "$KUBECTL_BIN" /usr/local/bin/
    echo "✅ kubectl installed"
fi

# Install kubeseal
echo "=============================="
echo "🚀 Installing kubeseal..."
if [ -f /usr/local/bin/kubeseal ]; then
    echo "✅ kubeseal is already installed"
else
    echo "✅ finding the latest kubeseal version..."
    KUBESEAL_VERSION=$(curl -s https://api.github.com/repos/bitnami-labs/sealed-secrets/tags | jq -r '.[0].name' | cut -c 2-)
    if [ -z "$KUBESEAL_VERSION" ]; then
        echo "Failed to fetch the latest KUBESEAL_VERSION"
        exit 1
    fi
    echo "Downloading kubeseal version: $KUBESEAL_VERSION"
    KUBESEAL_TAR="$TMP_DIR/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
    curl -Lo "$KUBESEAL_TAR" "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
    tar -xvzf "$KUBESEAL_TAR" -C "$TMP_DIR" kubeseal

    echo "Installing kubeseal..."
    sudo install -m 755 "$TMP_DIR/kubeseal" /usr/local/bin/kubeseal
    echo "✅ kubeseal installed"
fi

# Install k3d
echo "=============================="
echo "🚀 Installing k3d..."
if [ -f /usr/local/bin/k3d ]; then
    echo "✅ k3d is already installed"
else
    curl -L https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
    echo "✅ k3d installed"
fi


# Install helm
echo "=============================="
echo "🚀 Installing helm..."
if [ -f /usr/local/bin/helm ]; then
    echo "✅ helm is already installed"
else
    curl -fL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
    echo "✅ helm installed"
fi

# Install argocd-autopilot
echo "=============================="
echo "🚀 Installing argocd-autopilot..."
if [ -f /usr/local/bin/argocd-autopilot ]; then
    echo "✅ argocd-autopilot is already installed"
else
    ARGOCD_AUTOPILOT_VERSION=$(curl --silent "https://api.github.com/repos/argoproj-labs/argocd-autopilot/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    ARGOCD_AUTOPILOT_TAR="$TMP_DIR/argocd-autopilot-linux-amd64.tar.gz"
    curl -Lo "$ARGOCD_AUTOPILOT_TAR" https://github.com/argoproj-labs/argocd-autopilot/releases/download/$ARGOCD_AUTOPILOT_VERSION/argocd-autopilot-linux-amd64.tar.gz 
    tar -xvzf "$ARGOCD_AUTOPILOT_TAR" -C "$TMP_DIR" argocd-autopilot-linux-amd64
    sudo sudo mv "$TMP_DIR/argocd-autopilot-linux-amd64" /usr/local/bin/argocd-autopilot
    echo "✅ argocd-autopilot installed"
fi

# Install zsh-autosuggestions
echo "=============================="
echo "🚀 Installing zsh plugins..."
ZSH_AUTOSUGGESTIONS_DIR="$HOME/.oh-my-zsh/custom/plugins/zsh-autosuggestions"
if [ ! -d "$ZSH_AUTOSUGGESTIONS_DIR" ]; then
    echo "Cloning zsh-autosuggestions..."
    git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions.git "$ZSH_AUTOSUGGESTIONS_DIR"
fi
ZSHRC="$HOME/.zshrc"
sed -i "s/plugins=(.*)/plugins=(git git-auto-fetch zsh-autosuggestions)/g" "$ZSHRC"


echo "=============================="
echo "🚀 Installing zsh theme..."
POWERLEVEL10K="$HOME/.oh-my-zsh/custom/themes/powerlevel10k"
if [ ! -d "$POWERLEVEL10K" ]; then
    THEME_VERSION=$(curl --silent "https://api.github.com/repos/romkatv/powerlevel10k/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')
    curl -L https://github.com/romkatv/powerlevel10k/archive/refs/tags/v"${THEME_VERSION}".zip -o /tmp/powerlevel10k.zip
    unzip /tmp/powerlevel10k.zip -d /tmp
    cp -r /tmp/powerlevel10k-"${THEME_VERSION}" "$POWERLEVEL10K"
fi

sed -i 's/ZSH_THEME=".*"/ZSH_THEME="powerlevel10k\/powerlevel10k"/g' "${HOME}/.zshrc"
grep -qxF 'source ~/.oh-my-zsh/custom/themes/powerlevel10k/powerlevel10k.zsh-theme' "${HOME}/.zshrc" || echo 'source ~/.oh-my-zsh/custom/themes/powerlevel10k/powerlevel10k.zsh-theme' >> "${HOME}/.zshrc"
grep -qxF '[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh' "${HOME}/.zshrc" || echo '[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh' >>"${HOME}/.zshrc"
cp ".devcontainer/p10k.zsh" "${HOME}/.p10k.zsh"    


# Add binary paths to bashrc
LINE="export PATH=$(pwd)/scripts:\$PATH"
FILE="$HOME/.zshrc"
grep -qxF "$LINE" "$FILE" || echo "$LINE" >> "$FILE"
sudo chmod +x scripts/*

echo "🎉 Setup completed successfully!"
