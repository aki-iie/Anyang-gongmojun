#!/usr/bin/env bash
set -euo pipefail

# ── 색상 출력 ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_info()    { echo -e "${GREEN}[INFO]${NC}  $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Node.js 버전 확인 (nvm) ────────────────────────────────
if command -v nvm &>/dev/null; then
  nvm install && nvm use
  log_info "Node.js: $(node -v)"
else
  log_warn "nvm not found. Using system Node.js: $(node -v)"
fi

# ── 의존성 설치 ────────────────────────────────────────────
log_info "Installing dependencies..."
npm install

# ── .env 파일 초기화 ───────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  log_warn ".env created from .env.example — 실제 값을 채워넣어라."
fi

# ── 빌드 ──────────────────────────────────────────────────
log_info "Building..."
npm run build

# ── 실행 ──────────────────────────────────────────────────
log_info "Starting application..."
npm run dev
