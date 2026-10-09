import { createFileRoute } from "@tanstack/react-router";
import { Studio } from "@/components/studio";

const schema = {
  "@context": "https://schema.org",
  "@graph": [
    {
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
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What files can I convert to SVG?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "PNG, JPG, WebP, GIF, and BMP. Logos and flat illustrations trace cleaner than photos.",
          },
        },
        {
          "@type": "Question",
          name: "Will the SVG open in Illustrator or Figma?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. Colors become layers you can hide, recolor, or move, then download as a clean SVG.",
          },
        },
        {
          "@type": "Question",
          name: "Why is the preview watermarked?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "The preview is stamped so it cannot be copied out. A plan downloads the file without the watermark. Monthly is $9.99 and a year is $100.",
          },
        },
        {
          "@type": "Question",
          name: "Where does the tracing happen?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "In your browser. The artwork is not uploaded to make the SVG.",
          },
        },
      ],
    },
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
