#!/usr/bin/env bash
set -e

# Configuration
PRE_INSTALLED_PLUGINS=${PREINSTALLEDPLUGINS:-'git,git-auto-fetch'}
CUSTOM_PLUGINS=${CUSTOMPLUGINS:-''}
ACTIVE_PLUGINS=()
DELETE_INACTIVE_PLUGINS=${DELETEACTIVEPLUGINS:-false}
POWERLEVEL10K_VERSION=${POWERLEVEL10KVERSION:-'latest'}
POWERLEVEL10K_CONFIG=${POWERLEVEL10KCONFIG:-''}
DELETE_PREINSTALLED_THEMES=${DELETEPREINSTALLEDTHEMES:-false}
DEBUG=${DEBUG:-false}

# Debug helper
debug() {
  if [[ ${DEBUG} == true ]]; then
    echo "[SHELL-FEATURE] $1" >> /tmp/shell-feature.log
  fi
}

# Determine user home directory
if [[ -n ${_REMOTE_USER_HOME} ]]; then
  USER_HOME="${_REMOTE_USER_HOME}"
elif [[ ${_REMOTE_USER} == "root" ]]; then
  USER_HOME="/root"
elif [[ "/home/${_REMOTE_USER}" != $(getent passwd "${_REMOTE_USER}" | cut -d: -f6) ]]; then
  USER_HOME=$(getent passwd "${_REMOTE_USER}" | cut -d: -f6)
else
  USER_HOME="/home/${_REMOTE_USER}"
fi

debug "========================================"
debug "Shell Feature - Configuration"
debug "========================================"
debug "USER_HOME: ${USER_HOME}"
debug "PRE_INSTALLED_PLUGINS: ${PRE_INSTALLED_PLUGINS}"
debug "CUSTOM_PLUGINS: ${CUSTOM_PLUGINS}"
debug "DELETE_INACTIVE_PLUGINS: ${DELETE_INACTIVE_PLUGINS}"
debug "POWERLEVEL10K_VERSION: ${POWERLEVEL10K_VERSION}"
debug "DELETE_PREINSTALLED_THEMES: ${DELETE_PREINSTALLED_THEMES}"
debug "========================================"

# Step 1: Install Oh My Zsh if not already installed
if [[ ! -d "${USER_HOME}/.oh-my-zsh" ]]; then
  debug "Installing Oh My Zsh..."
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
else
  debug "Oh My Zsh already installed"
fi

# Step 2: Install custom plugins
if [[ -n "${CUSTOM_PLUGINS}" ]]; then
  debug "Installing custom plugins..."
  IFS=',' read -r -a plugins_array <<< "${CUSTOM_PLUGINS}"
  for plugin in "${plugins_array[@]}"; do
    name=$(echo "${plugin}" | cut -d':' -f1 | xargs)
    url=$(echo "${plugin}" | cut -d':' -f2- | xargs)
    debug "  - Installing plugin: ${name} from ${url}"
    plugin_dir="${USER_HOME}/.oh-my-zsh/custom/plugins/${name}"
    mkdir -p "${plugin_dir}"

    if [[ ${url} == *.git ]]; then
      debug "    - Cloning from git repository"
      git clone --depth=1 "${url}" "${plugin_dir}"
    elif [[ ${url} == *.zip ]]; then
      debug "    - Downloading from zip file"
      curl -L "${url}" -o /tmp/plugin.zip
      zip_content=$(unzip -Z1 /tmp/plugin.zip)
      base_dir=$(echo "${zip_content}" | head -n 1)
      unzip -q /tmp/plugin.zip -d /tmp/plugin
      mv /tmp/plugin/"${base_dir}"/* "${plugin_dir}/"
      rm -f /tmp/plugin.zip
      rm -rf /tmp/plugin
    else
      echo "ERROR: Unsupported URL format for plugin ${name}: ${url}"
      exit 1
    fi
    ACTIVE_PLUGINS+=("${name}")
  done
fi

# Step 3: Add pre-installed plugins to active list
debug "Adding pre-installed plugins..."
IFS=',' read -r -a plugins_array <<< "${PRE_INSTALLED_PLUGINS}"
for plugin in "${plugins_array[@]}"; do
  plugin=$(echo "${plugin}" | xargs)
  [[ -n "${plugin}" ]] && ACTIVE_PLUGINS+=("${plugin}")
done

# Step 4: Update .zshrc with active plugins
if [[ ${#ACTIVE_PLUGINS[@]} -gt 0 ]]; then
  debug "Updating .zshrc with ${#ACTIVE_PLUGINS[@]} plugins"
  ACTIVE_PLUGINS_STRING=$(printf " %s" "${ACTIVE_PLUGINS[@]}")
  sed -i "s/plugins=(.*)/plugins=(${ACTIVE_PLUGINS_STRING:1})/g" "${USER_HOME}/.zshrc"
fi

# Step 5: Delete inactive plugins if requested
if [[ ${DELETE_INACTIVE_PLUGINS} == true ]]; then
  debug "Removing inactive plugins..."
  PLUGINS_DIRS=("${USER_HOME}/.oh-my-zsh/custom/plugins" "${USER_HOME}/.oh-my-zsh/plugins")
  for PLUGIN_DIR in "${PLUGINS_DIRS[@]}"; do
    [[ ! -d "${PLUGIN_DIR}" ]] && continue
    debug "  - Checking ${PLUGIN_DIR}"
    for dir in "${PLUGIN_DIR}"/*; do
      [[ ! -d "${dir}" ]] && continue
      dir_name=$(basename "${dir}")
      should_delete=true
      for active_plugin in "${ACTIVE_PLUGINS[@]}"; do
        if [[ ${active_plugin} == "${dir_name}" ]]; then
          should_delete=false
          break
        fi
      done
      if [[ ${should_delete} == true ]]; then
        debug "    - Deleting ${dir_name}"
        rm -rf "${dir}"
      fi
    done
  done
fi

# Step 6: Install Powerlevel10k
debug "Installing Powerlevel10k..."

# Get latest version if needed
if [[ ${POWERLEVEL10K_VERSION} == "latest" ]]; then
  debug "  - Fetching latest Powerlevel10k version..."
  POWERLEVEL10K_VERSION=$(curl -s "https://api.github.com/repos/romkatv/powerlevel10k/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')
  debug "  - Latest version: ${POWERLEVEL10K_VERSION}"
fi

# Delete pre-installed themes if requested
if [[ ${DELETE_PREINSTALLED_THEMES} == true ]]; then
  debug "  - Removing pre-installed themes"
  rm -rf "${USER_HOME}/.oh-my-zsh/themes"/*
fi

# Download and install Powerlevel10k
debug "  - Downloading Powerlevel10k v${POWERLEVEL10K_VERSION}"
curl -sL "https://github.com/romkatv/powerlevel10k/archive/refs/tags/v${POWERLEVEL10K_VERSION}.zip" -o /tmp/powerlevel10k.zip
unzip -q /tmp/powerlevel10k.zip -d /tmp
cp -r /tmp/powerlevel10k-"${POWERLEVEL10K_VERSION}" "${USER_HOME}/.oh-my-zsh/custom/themes/powerlevel10k"
rm -rf /tmp/powerlevel10k.zip /tmp/powerlevel10k-"${POWERLEVEL10K_VERSION}"
debug "  - Powerlevel10k installed"

# Step 7: Configure Powerlevel10k in .zshrc
debug "Configuring Powerlevel10k in .zshrc..."
sed -i 's/ZSH_THEME=".*"/ZSH_THEME="powerlevel10k\/powerlevel10k"/g' "${USER_HOME}/.zshrc"

# Add Powerlevel10k initialization if not already present
if ! grep -q 'source ~/.oh-my-zsh/custom/themes/powerlevel10k/powerlevel10k.zsh-theme' "${USER_HOME}/.zshrc"; then
  echo 'source ~/.oh-my-zsh/custom/themes/powerlevel10k/powerlevel10k.zsh-theme' >> "${USER_HOME}/.zshrc"
fi

if ! grep -q '\[[ ! -f ~/.p10k.zsh ]\] || source ~/.p10k.zsh' "${USER_HOME}/.zshrc"; then
  echo '[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh' >> "${USER_HOME}/.zshrc"
fi

# Step 8: Setup Powerlevel10k configuration
if [[ -n "${POWERLEVEL10K_CONFIG}" ]]; then
  debug "Downloading Powerlevel10k config from ${POWERLEVEL10K_CONFIG}"
  curl -sL "${POWERLEVEL10K_CONFIG}" -o "${USER_HOME}/.p10k.zsh"
  debug "Config file saved to ~/.p10k.zsh"
else
  debug "Creating default Powerlevel10k configuration..."
  cat > "${USER_HOME}/.p10k.zsh" << 'P10K_ZSH'
'builtin' 'local' '-a' 'p10k_config_opts'
[[ ! -o 'aliases'         ]] || p10k_config_opts+=('aliases')
[[ ! -o 'sh_glob'         ]] || p10k_config_opts+=('sh_glob')
[[ ! -o 'no_brace_expand' ]] || p10k_config_opts+=('no_brace_expand')
'builtin' 'setopt' 'no_aliases' 'no_sh_glob' 'brace_expand'

() {
  emulate -L zsh -o extended_glob
  unset -m '(POWERLEVEL9K_*|DEFAULT_USER)~POWERLEVEL9K_GITSTATUS_DIR'
  # Zsh >= 5.1 is required.
  [[ $ZSH_VERSION == (5.<1->*|<6->.*) ]] || return
  typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(dir vcs)
  typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=()
  typeset -g POWERLEVEL9K_SHORTEN_STRATEGY=truncate_to_last
  typeset -g POWERLEVEL9K_DISABLE_HOT_RELOAD=true
  (( ! $+functions[p10k] )) || p10k reload
}
typeset -g POWERLEVEL9K_CONFIG_FILE=${${(%):-%x}:a}
(( ${#p10k_config_opts} )) && setopt ${p10k_config_opts[@]}
'builtin' 'unset' 'p10k_config_opts'
P10K_ZSH
  debug "Default config file created at ~/.p10k.zsh"
fi

debug "========================================"
debug "Shell Feature Installation Complete!"
debug "========================================"

echo "✓ Shell feature installed successfully!"
echo "  - Oh My Zsh configured"
echo "  - Plugins: ${ACTIVE_PLUGINS_STRING:1}"
echo "  - Powerlevel10k v${POWERLEVEL10K_VERSION} installed"
