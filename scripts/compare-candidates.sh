#!/usr/bin/env bash
# Runs the model comparison on the six models worth measuring (owner, 2026-11-08), and saves the results where Compare Models reads them, so they appear
# in the tab as soon as the extension that reads them is installed.
#
#   bash scripts/compare-candidates.sh              # research brief, one run each
#   bash scripts/compare-candidates.sh --set full   # every task (slower, better evidence)
#
# It asks for the NEAR API key without echoing it, so the key stays out of the screen, the scrollback and the shell history.
set -euo pipefail

cd "$(dirname "$0")/.."

# The six, chosen for what the first run needs to settle: the current model as the baseline, the abliterated pair that cyber work depends on, the two
# cheap fast candidates, and two stronger models for the deep tier.
MODELS='deepseek-ai/DeepSeek-V4.1-Flash-1017,deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated,Qwen/Qwen3.8-27B-abliterated,z-ai/glm-5.3-flash,Qwen/Qwen3.8-27B,moonshotai/kimi-k2.6'

# The folder Compare Models reads, per platform and per VS Code flavour. The script checks each and uses the first that exists, so Insiders, code-server
# and plain VS Code all work without the person naming a path; NEAR_AI_BENCHMARK_DIR overrides everything.
candidates=(
  "$HOME/.config/Code/User/globalStorage/vitalpoint.near-ai-vscode/evals"
  "$HOME/.config/Code - Insiders/User/globalStorage/vitalpoint.near-ai-vscode/evals"
  "$HOME/.local/share/code-server/User/globalStorage/vitalpoint.near-ai-vscode/evals"
  "$HOME/Library/Application Support/Code/User/globalStorage/vitalpoint.near-ai-vscode/evals"
  "$HOME/Library/Application Support/Code - Insiders/User/globalStorage/vitalpoint.near-ai-vscode/evals"
  "${APPDATA:-$HOME/AppData/Roaming}/Code/User/globalStorage/vitalpoint.near-ai-vscode/evals"
  "${APPDATA:-$HOME/AppData/Roaming}/Code - Insiders/User/globalStorage/vitalpoint.near-ai-vscode/evals"
)
DEFAULT_EVALS=""
for candidate in "${candidates[@]}"; do
  if [ -d "$candidate" ]; then DEFAULT_EVALS="$candidate"; break; fi
done
if [ -z "$DEFAULT_EVALS" ]; then DEFAULT_EVALS="${candidates[0]}"; fi
export NEAR_AI_BENCHMARK_DIR="${NEAR_AI_BENCHMARK_DIR:-$DEFAULT_EVALS}"

if [ -z "${NEAR_AI_API_KEY:-}" ]; then
  read -rsp "NEAR API key (not echoed): " NEAR_AI_API_KEY
  echo
  export NEAR_AI_API_KEY
fi

mkdir -p "$NEAR_AI_BENCHMARK_DIR"
echo "Results will be saved to: $NEAR_AI_BENCHMARK_DIR"
echo "Models: $MODELS"

# dist/ is what the script drives; compile first so the run uses this tree's code.
npm run compile >/dev/null

ARGS=("$@")
[ ${#ARGS[@]} -eq 0 ] && ARGS=(--task research-brief)
npm run compare:models -- "${ARGS[@]}" --models "$MODELS" --runs 1
