import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/workspace/", "/practice/"] }, sitemap: "https://northstar.example/sitemap.xml" };
}
