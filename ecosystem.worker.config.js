// The background-job worker under PM2 on the worker host (DEPLOY.md section 4).
// Same build as the web API; APP_TYPE=WORKER picks the worker. One process.
// Environment: the .env in the API root (the app loads it itself).
module.exports = {
  apps: [
    {
      name: 'bodhira-worker',
      script: 'dist/main.js',
      cwd: __dirname,
      env: { APP_TYPE: 'WORKER' },
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 120000, // let running jobs finish on stop/restart
    },
  ],
};
