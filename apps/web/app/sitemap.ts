import type { MetadataRoute } from "next";

const routes = ["", "/employers", "/staffing", "/universities", "/candidates", "/pricing", "/security", "/developers", "/contact"];
export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({ url: `https://northstar.example${route}`, lastModified: new Date(), changeFrequency: route === "" ? "weekly" : "monthly", priority: route === "" ? 1 : .8 }));
}
