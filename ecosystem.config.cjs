module.exports = {
  apps: [
    {
      name: 'scraping-node',
      cwd: './backend',
      script: 'src/index.js',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'development',
      },
    },
    {
      name: 'scraping-python',
      cwd: './',
      script: 'python3',
      args: '-m uvicorn api.main:app --port 8000 --reload --reload-dir api --reload-dir src --reload-dir config',
      interpreter: 'none',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
