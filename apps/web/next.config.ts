import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/alfred',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
