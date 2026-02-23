#!/bin/bash
# ===========================================
# IconsAI Scraping - Development Server
# ===========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_header() {
    echo ""
    echo -e "${CYAN}=============================================${NC}"
    echo -e "${CYAN} IconsAI Scraping - Dev Server${NC}"
    echo -e "${CYAN}=============================================${NC}"
    echo ""
}

check_dependencies() {
    echo -e "${YELLOW}[1/4] Verificando dependencias...${NC}"

    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}  ✗ Node.js nao encontrado${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"

    # Check Python (prefer 3.12)
    PYTHON_CMD="/opt/homebrew/bin/python3.12"
    if [ ! -x "$PYTHON_CMD" ]; then
        PYTHON_CMD="python3"
    fi
    if ! command -v $PYTHON_CMD &> /dev/null; then
        echo -e "${RED}  ✗ Python3 nao encontrado${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Python $($PYTHON_CMD --version)${NC}"

    # Check PM2
    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}  ⚠ PM2 nao encontrado. Instalando...${NC}"
        npm install -g pm2
    fi
    echo -e "${GREEN}  ✓ PM2 $(pm2 -v)${NC}"

    # Check serve
    if ! command -v serve &> /dev/null; then
        echo -e "${YELLOW}  ⚠ serve nao encontrado. Instalando...${NC}"
        npm install -g serve
    fi
    echo -e "${GREEN}  ✓ serve instalado${NC}"
}

check_env() {
    echo ""
    echo -e "${YELLOW}[2/4] Verificando .env...${NC}"

    if [ ! -f ".env" ]; then
        echo -e "${RED}  ✗ Arquivo .env nao encontrado${NC}"
        echo -e "${YELLOW}  → Copie .env.example para .env e configure${NC}"
        exit 1
    fi

    # Check critical vars
    source .env

    if [ -z "$JWT_SECRET_KEY" ]; then
        echo -e "${RED}  ✗ JWT_SECRET_KEY vazia${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ JWT_SECRET_KEY configurada${NC}"

    if [ -z "$SUPABASE_URL" ]; then
        echo -e "${RED}  ✗ SUPABASE_URL vazia${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ SUPABASE_URL configurada${NC}"

    if [ -z "$SUPABASE_SERVICE_KEY" ]; then
        echo -e "${RED}  ✗ SUPABASE_SERVICE_KEY vazia${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ SUPABASE_SERVICE_KEY configurada${NC}"
}

install_deps() {
    echo ""
    echo -e "${YELLOW}[3/4] Instalando dependencias...${NC}"

    # Backend Node.js
    if [ -d "backend" ] && [ -f "backend/package.json" ]; then
        echo -e "  → Backend Node.js..."
        (cd backend && npm install --silent)
        echo -e "${GREEN}  ✓ Backend Node.js${NC}"
    fi

    # Frontend Next.js
    if [ -d "apps/web" ] && [ -f "apps/web/package.json" ]; then
        echo -e "  → Frontend Next.js..."
        (cd apps/web && npm install --silent)
        echo -e "${GREEN}  ✓ Frontend Next.js${NC}"
    fi

    # Python
    if [ -f "requirements.txt" ]; then
        echo -e "  → Python dependencies..."
        $PYTHON_CMD -m pip install -q -r requirements.txt 2>/dev/null || echo -e "${YELLOW}  ⚠ Algumas deps Python falharam (nao critico)${NC}"
        echo -e "${GREEN}  ✓ Python dependencies${NC}"
    fi
}

start_servers() {
    echo ""
    echo -e "${YELLOW}[4/4] Iniciando servidores...${NC}"

    # Stop existing
    pm2 delete all 2>/dev/null || true

    # Start with ecosystem
    pm2 start ecosystem.config.js

    echo ""
    pm2 status
}

print_urls() {
    echo ""
    echo -e "${GREEN}=============================================${NC}"
    echo -e "${GREEN} Servidores Iniciados!${NC}"
    echo -e "${GREEN}=============================================${NC}"
    echo ""
    echo -e "  ${CYAN}Frontend Next.js:${NC}    http://localhost:3000"
    echo -e "  ${CYAN}Backend Node.js:${NC}     http://localhost:3001"
    echo -e "  ${CYAN}API Python:${NC}          http://localhost:8000"
    echo -e "  ${CYAN}Dashboard Static:${NC}    http://localhost:8080"
    echo ""
    echo -e "${YELLOW}Comandos uteis:${NC}"
    echo -e "  pm2 logs           # Ver logs em tempo real"
    echo -e "  pm2 status         # Ver status dos servicos"
    echo -e "  pm2 restart all    # Reiniciar todos"
    echo -e "  pm2 stop all       # Parar todos"
    echo ""
}

# Main
case "${1:-start}" in
    start)
        print_header
        check_dependencies
        check_env
        install_deps
        start_servers
        print_urls
        ;;
    stop)
        pm2 stop all
        echo -e "${GREEN}Servidores parados${NC}"
        ;;
    restart)
        pm2 restart all
        echo -e "${GREEN}Servidores reiniciados${NC}"
        ;;
    logs)
        pm2 logs
        ;;
    status)
        pm2 status
        ;;
    *)
        echo "Uso: $0 {start|stop|restart|logs|status}"
        exit 1
        ;;
esac
