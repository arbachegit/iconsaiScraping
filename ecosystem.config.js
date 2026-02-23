/**
 * PM2 Ecosystem Configuration
 * IconsAI Scraping - Development Server
 *
 * Uso:
 *   npm install -g pm2          # Instalar PM2 globalmente
 *   pm2 start ecosystem.config.js   # Iniciar todos os servicos
 *   pm2 status                  # Ver status
 *   pm2 logs                    # Ver logs em tempo real
 *   pm2 stop all                # Parar todos
 *   pm2 restart all             # Reiniciar todos
 *   pm2 delete all              # Remover todos
 */

module.exports = {
  apps: [
    // =============================================
    // Backend Node.js (porta 3001)
    // =============================================
    {
      name: 'backend',
      cwd: './backend',
      script: 'src/index.js',
      watch: ['src'],
      ignore_watch: ['node_modules', 'logs'],
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
      },
      env_file: '../.env',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // =============================================
    // Backend Python FastAPI (porta 8000)
    // =============================================
    {
      name: 'api-python',
      script: './.venv/bin/uvicorn',
      args: 'api.main:app --host 0.0.0.0 --port 8000 --reload',
      interpreter: 'none',
      watch: false,
      env: {
        ENVIRONMENT: 'development',
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      error_file: './logs/api-python-error.log',
      out_file: './logs/api-python-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // =============================================
    // Frontend Next.js (porta 3000)
    // =============================================
    {
      name: 'web',
      cwd: './apps/web',
      script: 'npm',
      args: 'run dev',
      watch: false, // Next.js tem seu proprio watch
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      error_file: '../../logs/web-error.log',
      out_file: '../../logs/web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // =============================================
    // Static Server para Dashboard (porta 8080)
    // =============================================
    {
      name: 'dashboard',
      script: 'npx',
      args: 'serve static -l 8080 -s',
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 1000,
      error_file: './logs/dashboard-error.log',
      out_file: './logs/dashboard-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
