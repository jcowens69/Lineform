import { createFileRoute } from "@tanstack/react-router";
import { Studio } from "@/components/studio";

const schema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Lineform",
  applicationCategory: "DesignApplication",
  operatingSystem: "Web",
  url: "https://vectorlineform.com/",
  image: "https://vectorlineform.com/og.jpg",
  description:
    "Turn a PNG, JPG, or WebP logo into clean SVG paths. Trace in the browser, split colors into layers, and download for Illustrator or Figma.",
  offers: [
    { "@type": "Offer", price: "9.99", priceCurrency: "USD", name: "Monthly" },
    { "@type": "Offer", price: "100", priceCurrency: "USD", name: "Annual" },
  ],
};

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "canonical", href: "https://vectorlineform.com/" }],
    scripts: [{ type: "application/ld+json", children: JSON.stringify(schema) }],
  }),
  component: Home,
});

function Home() {
  return <Studio />;
}
