import type { NextConfig } from 'next';

// API URLs - use container names in Docker, localhost in development
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const NODEJS_API_URL = process.env.NODEJS_API_URL || 'http://localhost:3001';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    return {
      // afterFiles runs AFTER Next.js API routes are checked
      afterFiles: [
        // Auth routes -> Python API (port 8000)
        {
          source: '/api/auth/:path*',
          destination: `${PYTHON_API_URL}/auth/:path*`,
        },
        // Admin routes -> Python API (port 8000)
        {
          source: '/api/admin/:path*',
          destination: `${PYTHON_API_URL}/admin/:path*`,
        },
        // Atlas agent -> Python API
        {
          source: '/api/atlas/:path*',
          destination: `${PYTHON_API_URL}/atlas/:path*`,
        },
        // Stats routes are handled by Next.js API routes (/app/api/stats/*)
        // Other API routes -> Node.js backend (port 3001)
        {
          source: '/api/:path*',
          destination: `${NODEJS_API_URL}/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
