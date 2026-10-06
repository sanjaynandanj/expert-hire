import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@northstar/brand"],
  poweredByHeader: false,
  typedRoutes: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" }
        ]
      }
    ];
  }
};

export default nextConfig;
