import Anthropic from "@anthropic-ai/sdk";

// Reuses the same ANTHROPIC_API_KEY already configured for receipt-email
// extraction (see receipts.js) - one Claude vision call reads the pasted/
// dragged label image and returns the two things the Scratch Pad's
// shipping-label tool can't get any other way: which marketplace generated
// it, and who it's addressed to.
//
// Rotation and cropping used to be asked of this same call too (a bounding
// box + a rotation direction), but that proved unreliable on real photos in
// several distinct ways - the frontend now derives both deterministically
// from pixel data instead (ink density, printed frame rules), so this call
// is pure text extraction.
//
// Uses Sonnet, not Haiku - a real label showed Haiku confusing the "ship
// from" sender block with the "ship to" recipient block (returned the
// sender's business name instead of the actual recipient). Distinguishing
// which of possibly several address blocks is the recipient - a judgment
// call, not pure OCR - needs the extra reliability, and label volume is low
// enough that the per-call cost difference doesn't matter.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const ANALYZE_TOOL = {
  name: "analyze_shipping_label",
  description: "Identify whether an image contains a shipping label, which marketplace/carrier it's from, and who it's addressed to.",
  input_schema: {
    type: "object",
    properties: {
      isLabel: {
        type: "boolean",
        description: "True if this image contains an actual shipping label (an address + barcode/tracking area meant to be printed and affixed to a package).",
      },
      marketplace: {
        type: ["string", "null"],
        description: "The marketplace/platform whose branding appears on the label - e.g. 'Amazon', 'Etsy', 'eBay', 'Shopify', 'Poshmark'. If no marketplace branding is present and it's just a bare carrier label, use the carrier name instead (e.g. 'USPS', 'UPS', 'FedEx'). Null if it can't be determined at all.",
      },
      recipientName: {
        type: ["string", "null"],
        description: "Every shipping label has (at least) two addresses: a 'Ship From' / 'From' sender address (usually smaller, often a business name and a PO box or warehouse address) and a 'Ship To' / 'To' recipient address (who the package is actually being delivered to - this is the one that matters here). These two addresses can appear anywhere on the label and in either order depending on the carrier/marketplace template, and the label may be sideways or upside down, so don't assume a fixed position - read any 'FROM'/'TO' or 'SHIP FROM'/'SHIP TO' labels printed next to each block if present, and otherwise use judgment (the recipient address is typically paired with its own barcode/QR code distinct from the sender's, and is usually the more visually prominent block). Return the recipient's name exactly as printed - a person's name if there is one, otherwise the recipient business name. Null if not legible or the label only has one address and its role is unclear.",
      },
    },
    required: ["isLabel"],
  },
};

export async function analyzeShippingLabel(base64Image, mediaType) {
  if (!anthropic) {
    throw new Error("Shipping label analysis not configured - set ANTHROPIC_API_KEY");
  }
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 512,
    tools: [ANALYZE_TOOL],
    tool_choice: { type: "tool", name: "analyze_shipping_label" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          {
            type: "text",
            text: "This image may contain a shipping label, possibly alongside other content (a screenshot, a packing slip, etc.), and it may be sideways or upside down. Identify whether it's a label, the marketplace/carrier, and specifically the RECIPIENT's name - not the sender - reading whichever address block is actually the 'Ship To' one for this label's own layout.",
          },
        ],
      },
    ],
  });
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured result");
  return toolUse.input;
}
