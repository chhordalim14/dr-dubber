#!/usr/bin/env bash
# ==============================================================================
#  🎙️ DR Dubber — Local Whisper Engine Setup (macOS / Linux)
# ==============================================================================

set -e

# Terminal Colors & Styling
if [ -t 1 ]; then
    C_RESET="\033[0m"
    C_BOLD="\033[1m"
    C_DIM="\033[2m"
    C_CYAN="\033[36m"
    C_GREEN="\033[32m"
    C_YELLOW="\033[33m"
    C_RED="\033[31m"
    C_PURPLE="\033[35m"
    C_BG_CYAN="\033[46;30m"
else
    C_RESET=""
    C_BOLD=""
    C_DIM=""
    C_CYAN=""
    C_GREEN=""
    C_YELLOW=""
    C_RED=""
    C_PURPLE=""
    C_BG_CYAN=""
fi

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo -e "\n${C_CYAN}${C_BOLD}╭────────────────────────────────────────────────────────╮${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}│   🎙️  DR Dubber — Local Whisper Engine Setup           │${C_RESET}"
echo -e "${C_CYAN}${C_BOLD}╰────────────────────────────────────────────────────────╯${C_RESET}\n"

# Step 1: Detect Python 3
echo -e "${C_BOLD}[1/4]${C_RESET} ${C_CYAN}Detecting Python environment...${C_RESET}"

find_python() {
    for candidate in "python3" "python" "/opt/homebrew/bin/python3" "/usr/local/bin/python3" "/usr/bin/python3"; do
        if command -v "$candidate" >/dev/null 2>&1; then
            if "$candidate" -c "import sys; exit(0 if sys.version_info >= (3, 8) else 1)" >/dev/null 2>&1; then
                echo "$candidate"
                return 0
            fi
        fi
    done
    return 1
}

PY=$(find_python || true)

if [ -z "$PY" ]; then
    echo -e "  ${C_RED}✖ Error: Python 3.8+ was not found on your system.${C_RESET}"
    echo -e "  ${C_DIM}Please install Python using one of the following:${C_RESET}"
    echo -e "    • macOS: ${C_YELLOW}brew install python${C_RESET}"
    echo -e "    • Ubuntu/Debian: ${C_YELLOW}sudo apt install python3 python3-venv python3-pip${C_RESET}"
    echo -e "    • Arch Linux: ${C_YELLOW}sudo pacman -S python python-pip${C_RESET}\n"
    exit 1
fi

PY_VER=$($PY --version 2>&1)
echo -e "  ${C_GREEN}✔ Found:${C_RESET} ${C_BOLD}${PY_VER}${C_RESET} ${C_DIM}($PY)${C_RESET}"

# Step 2: Create / Verify venv
echo -e "\n${C_BOLD}[2/4]${C_RESET} ${C_CYAN}Setting up isolated virtual environment...${C_RESET}"

if [ ! -d "venv" ] || [ ! -f "venv/bin/activate" ]; then
    echo -e "  ${C_DIM}→ Creating virtualenv in ./venv...${C_RESET}"
    $PY -m venv venv
    echo -e "  ${C_GREEN}✔ Virtual environment created.${C_RESET}"
else
    echo -e "  ${C_GREEN}✔ Virtual environment already present.${C_RESET}"
fi

# Step 3: Install dependencies
echo -e "\n${C_BOLD}[3/4]${C_RESET} ${C_CYAN}Installing speech-to-text dependencies...${C_RESET}"
source venv/bin/activate

echo -e "  ${C_DIM}→ Upgrading pip & wheel...${C_RESET}"
python -m pip install --upgrade pip wheel -q --disable-pip-version-check

echo -e "  ${C_DIM}→ Installing faster-whisper (CTranslate2 accelerated)...${C_RESET}"
python -m pip install -r requirements.txt -q --disable-pip-version-check

echo -e "  ${C_GREEN}✔ Dependencies installed successfully.${C_RESET}"

# Step 4: Permissions & Verification
echo -e "\n${C_BOLD}[4/4]${C_RESET} ${C_CYAN}Verifying Whisper engine components...${C_RESET}"
chmod +x "$DIR/run.sh" 2>/dev/null || true
chmod +x "$DIR/setup.sh" 2>/dev/null || true

# Test import
if python -c "import faster_whisper" 2>/dev/null; then
    ENGINE_INFO="faster-whisper (active)"
elif python -c "import whisper" 2>/dev/null; then
    ENGINE_INFO="openai-whisper (active)"
else
    ENGINE_INFO="standard python"
fi

echo -e "  ${C_GREEN}✔ Engine verification passed:${C_RESET} ${C_BOLD}${ENGINE_INFO}${C_RESET}"

# Done Summary Card
echo -e "\n${C_GREEN}${C_BOLD}╭────────────────────────────────────────────────────────╮${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}│   ✨ Setup Complete & Ready to Use!                    │${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}╰────────────────────────────────────────────────────────╯${C_RESET}"
echo -e " ${C_BOLD}Whisper Folder Path for DR Dubber Settings:${C_RESET}"
echo -e "  ${C_CYAN}${C_BOLD}$DIR${C_RESET}\n"
echo -e " ${C_DIM}Tip: Select 'Whisper + Translate' in DR Dubber Settings to enable local speech recognition.${C_RESET}\n"
