#!/bin/bash

# screenshot-memory setup script
# This script sets up everything needed to run screenshot-memory

set -e

# ============================================
# Uninstall mode
# ============================================
if [[ "$1" == "--remove" ]] || [[ "$1" == "--uninstall" ]] || [[ "$1" == "-r" ]]; then
    echo ""
    echo "Uninstalling screenshot-memory..."
    echo ""

    # Remove symlinks
    rm -f ~/.bun/bin/ssm 2>/dev/null && echo "✓ Removed ~/.bun/bin/ssm"
    rm -f ~/.bun/bin/screenshot-memory 2>/dev/null && echo "✓ Removed ~/.bun/bin/screenshot-memory"
    rm -f /usr/local/bin/ssm 2>/dev/null && echo "✓ Removed /usr/local/bin/ssm"
    rm -f ~/.local/bin/ssm 2>/dev/null && echo "✓ Removed ~/.local/bin/ssm"

    # Remove index data
    rm -rf ~/.config/screenshot-memory 2>/dev/null && echo "✓ Removed config"
    rm -rf ~/Library/Application\ Support/screenshot-memory 2>/dev/null && echo "✓ Removed index data"

    echo ""
    echo "Done! screenshot-memory has been uninstalled."
    echo "Note: Ollama and its models were not removed."
    echo ""
    exit 0
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

# Print with color
print_header() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${WHITE}  $1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_step() {
    echo -e "${BLUE}▶${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*)  echo "macos" ;;
        Linux*)   echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *)        echo "unknown" ;;
    esac
}

OS=$(detect_os)

print_header "📸 screenshot-memory Setup"

echo -e "${WHITE}This script will set up screenshot-memory on your system.${NC}"
echo ""
echo "It will:"
echo "  • Check/install Bun (fast JavaScript runtime)"
echo "  • Check/install Ollama (local AI for image captioning)"
echo "  • Download the llava-phi3 vision model (~2.9GB)"
echo "  • Install dependencies and build the project"
echo "  • Create the 'ssm' command globally"
echo ""

# Confirm
read -p "Continue? (Y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Setup cancelled."
    exit 0
fi

# ============================================
# Step 1: Check/Install Bun
# ============================================
print_header "Step 1: JavaScript Runtime"

if command_exists bun; then
    BUN_VERSION=$(bun --version 2>/dev/null)
    print_success "Bun is installed (v$BUN_VERSION)"
else
    print_step "Installing Bun..."

    if [[ "$OS" == "macos" ]] || [[ "$OS" == "linux" ]]; then
        curl -fsSL https://bun.sh/install | bash

        # Source the updated profile
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"

        if command_exists bun; then
            print_success "Bun installed successfully"
        else
            print_warning "Bun installed but not in PATH. Please restart your terminal."
        fi
    else
        print_error "Please install Bun manually: https://bun.sh"
        exit 1
    fi
fi

# ============================================
# Step 2: Check/Install Ollama
# ============================================
print_header "Step 2: Ollama (AI Vision)"

if command_exists ollama; then
    print_success "Ollama is installed"
else
    print_step "Installing Ollama..."

    if [[ "$OS" == "macos" ]]; then
        if command_exists brew; then
            brew install ollama
        else
            print_info "Downloading Ollama installer..."
            curl -fsSL https://ollama.com/install.sh | sh
        fi
    elif [[ "$OS" == "linux" ]]; then
        curl -fsSL https://ollama.com/install.sh | sh
    else
        print_error "Please install Ollama manually: https://ollama.com"
        exit 1
    fi

    if command_exists ollama; then
        print_success "Ollama installed successfully"
    else
        print_error "Failed to install Ollama"
        exit 1
    fi
fi

# ============================================
# Step 3: Start Ollama & Download Model
# ============================================
print_header "Step 3: Vision Model"

# Check if Ollama is running
OLLAMA_RUNNING=false
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    OLLAMA_RUNNING=true
    print_success "Ollama is running"
else
    print_step "Starting Ollama..."

    if [[ "$OS" == "macos" ]]; then
        # On macOS, Ollama runs as an app
        open -a Ollama 2>/dev/null || ollama serve &
    else
        ollama serve &
    fi

    # Wait for Ollama to start
    print_info "Waiting for Ollama to start..."
    for i in {1..30}; do
        if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
            OLLAMA_RUNNING=true
            break
        fi
        sleep 1
    done

    if $OLLAMA_RUNNING; then
        print_success "Ollama started"
    else
        print_warning "Could not start Ollama automatically."
        print_info "Please start Ollama manually and re-run this script."
    fi
fi

# Check for vision model
if $OLLAMA_RUNNING; then
    print_step "Checking for vision model..."

    # Check if llava-phi3 is installed
    MODELS=$(curl -s http://localhost:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4)

    HAS_VISION_MODEL=false
    for model in llava-phi3 llava-phi3:latest llava:7b smolvlm2; do
        if echo "$MODELS" | grep -q "^$model"; then
            HAS_VISION_MODEL=true
            print_success "Vision model found: $model"
            break
        fi
    done

    if ! $HAS_VISION_MODEL; then
        print_step "Downloading llava-phi3 vision model (~2.9GB)..."
        print_info "This may take a few minutes depending on your internet speed."
        echo ""

        ollama pull llava-phi3

        if [ $? -eq 0 ]; then
            print_success "Vision model downloaded"
        else
            print_warning "Failed to download vision model."
            print_info "You can download it later with: ollama pull llava-phi3"
        fi
    fi

    if [[ "$OS" == "linux" || "$OS" == "windows" ]]; then
        print_step "Checking for embedding model..."
        HAS_EMBED_MODEL=false
        for model in nomic-embed-text nomic-embed-text:latest; do
            if echo "$MODELS" | grep -q "^$model"; then
                HAS_EMBED_MODEL=true
                print_success "Embedding model found: $model"
                break
            fi
        done

        if ! $HAS_EMBED_MODEL; then
            print_step "Downloading nomic-embed-text embedding model..."
            print_info "Used only when memvid's local ONNX model is unavailable. No API key."
            echo ""

            ollama pull nomic-embed-text

            if [ $? -eq 0 ]; then
                print_success "Embedding model downloaded"
            else
                print_warning "Failed to download embedding model."
                print_info "You can download it later with: ollama pull nomic-embed-text"
            fi
        fi
    fi
else
    print_warning "Skipping model download (Ollama not running)"
    if [[ "$OS" == "linux" || "$OS" == "windows" ]]; then
        print_info "After starting Ollama, run: ollama pull llava-phi3 && ollama pull nomic-embed-text"
    else
        print_info "After starting Ollama, run: ollama pull llava-phi3"
    fi
fi

# ============================================
# Step 4: Install Dependencies
# ============================================
print_header "Step 4: Project Dependencies"

print_step "Installing dependencies..."
bun install

if [ $? -eq 0 ]; then
    print_success "Dependencies installed"
else
    print_error "Failed to install dependencies"
    exit 1
fi

# ============================================
# Step 5: Build Project
# ============================================
print_header "Step 5: Building"

print_step "Building project..."
bun run build

if [ $? -eq 0 ]; then
    print_success "Build complete"
else
    print_error "Build failed"
    exit 1
fi

# ============================================
# Step 6: Create Global Command
# ============================================
print_header "Step 6: Global Command"

print_step "Creating 'ssm' command..."

# Create symlink in ~/.bun/bin (or /usr/local/bin as fallback)
SSM_SOURCE="$(pwd)/bin/ssm"
SSM_TARGET=""

if [[ -d "$HOME/.bun/bin" ]]; then
    SSM_TARGET="$HOME/.bun/bin/ssm"
elif [[ -d "/usr/local/bin" ]]; then
    SSM_TARGET="/usr/local/bin/ssm"
else
    mkdir -p "$HOME/.local/bin"
    SSM_TARGET="$HOME/.local/bin/ssm"
fi

# Remove old symlink if exists
rm -f "$SSM_TARGET" 2>/dev/null

# Create new symlink
ln -s "$SSM_SOURCE" "$SSM_TARGET"
print_success "Created 'ssm' command at $SSM_TARGET"

# Make sure the bin directory is in PATH
if ! echo "$PATH" | grep -q "$(dirname "$SSM_TARGET")"; then
    SHELL_RC=""
    if [[ "$SHELL" == *"zsh"* ]]; then
        SHELL_RC="$HOME/.zshrc"
    elif [[ "$SHELL" == *"bash"* ]]; then
        SHELL_RC="$HOME/.bashrc"
    fi

    if [[ -n "$SHELL_RC" ]]; then
        echo "" >> "$SHELL_RC"
        echo "# screenshot-memory" >> "$SHELL_RC"
        echo "export PATH=\"$(dirname "$SSM_TARGET"):\$PATH\"" >> "$SHELL_RC"
        print_info "Added $(dirname "$SSM_TARGET") to PATH in $SHELL_RC"
    fi
fi

# ============================================
# Done!
# ============================================
print_header "Setup Complete!"

echo -e "${GREEN}screenshot-memory is ready to use!${NC}"
echo ""
echo -e "${WHITE}Quick Start:${NC}"
echo ""
echo -e "  ${CYAN}1.${NC} Index your screenshots:"
echo -e "     ${WHITE}ssm index ~/Screenshots${NC}"
echo ""
echo -e "  ${CYAN}2.${NC} Search for anything:"
echo -e "     ${WHITE}ssm find \"error message\"${NC}"
echo -e "     ${WHITE}ssm find \"red car\"${NC}"
echo ""
echo -e "  ${CYAN}3.${NC} Auto-index new screenshots:"
echo -e "     ${WHITE}ssm watch${NC}"
echo ""

if [[ -n "$SHELL_RC" ]]; then
    echo -e "${YELLOW}Note:${NC} Run ${WHITE}source $SHELL_RC${NC} or restart your terminal"
    echo "      to use the 'ssm' command."
    echo ""
fi

echo -e "${CYAN}Documentation:${NC} https://github.com/memvid/screenshot-memory"
echo ""
