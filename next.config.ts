import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'better-sqlite3',
    '@prisma/adapter-better-sqlite3',
    // pdfkit ships .afm font files alongside its source. Bundling rewrites
    // those paths and breaks runtime font lookup; mark it external so Node
    // resolves it from node_modules at runtime instead.
    'pdfkit',
  ],
};

export default nextConfig;
