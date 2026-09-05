import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The browser talks to ws-gateway directly (NEXT_PUBLIC_WS_GATEWAY_URL) and to
  // NOTHING else — every other backend call goes through the server-side proxies.
  poweredByHeader: false,
};

export default nextConfig;
