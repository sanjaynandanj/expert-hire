export const brand = {
  name: "Northstar",
  legalName: "Northstar Talent OS",
  descriptor: "Talent intelligence, made accountable.",
  description:
    "A connected operating system for evidence-led hiring, career readiness, and campus placements.",
  notice:
    "Northstar is a temporary product name and has not been evaluated or cleared for trademark use.",
  colors: {
    ink: "#10251d",
    pine: "#123f31",
    mint: "#baf4d6",
    cream: "#f5f1e8",
    coral: "#ff725e",
    sky: "#9ed9ff"
  }
} as const;

export type Brand = typeof brand;
