/** @type {import('next').NextConfig} */
const nextConfig = {
  // Sandstorm uses the statically generated homepage and browser assets from
  // this output. Its small grain server does not load the Next.js runtime.
  output: "standalone",
  experimental: {
    // Optimize barrel file imports for better tree-shaking
    // This transforms imports from lucide-react to direct icon imports
    optimizePackageImports: ["lucide-react"],
    serverComponentsExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  },
};

export default nextConfig;
