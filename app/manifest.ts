import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Wirral Community Football",
    short_name: "Wirral CF",
    description: "Book in for pickup games, catch match clips, and keep up with the team.",
    start_url: "/",
    display: "standalone",
    background_color: "#0A1A34",
    theme_color: "#0A1A34",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
