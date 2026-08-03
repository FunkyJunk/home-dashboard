import Anthropic from "@anthropic-ai/sdk";

// Reuses the same ANTHROPIC_API_KEY already configured for receipt-email
// extraction (see receipts.js) - one Claude vision call reads the pasted/
// dragged label image and returns everything the Scratch Pad's shipping-
// label tool needs: which marketplace generated it, who it's addressed to,
// and roughly where the label itself sits within the full image (which may
// contain other content around it, e.g. a screenshot or a packing slip).
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const ANALYZE_TOOL = {
  name: "analyze_shipping_label",
  description: "Identify the marketplace a shipping label came from, the recipient it's addressed to, and the label's bounding box within the full image.",
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
        description: "The name of the person or business the package is addressed to (the 'Ship To' recipient), exactly as printed on the label. Null if not legible.",
      },
      cropBox: {
        type: ["object", "null"],
        description: "The bounding box of the COMPLETE printable label, from its outer border/cut-line at the top all the way down to its outer border/cut-line at the bottom - as percentages of the FULL image's width/height (each 0-100, xPct/yPct is the top-left corner). This MUST include every part of the label: the postage/address block AND the barcode AND the tracking number text below the barcode AND any QR code - these are usually stacked vertically and are ALL part of one continuous printable label, never just the address portion on its own. When in doubt, err toward a LARGER box that includes more of the surrounding label rather than a tight box that risks cutting off the barcode. Measured in the image's ORIGINAL orientation, before any rotation. Null if the label already appears to fill the entire image edge-to-edge.",
        properties: {
          xPct: { type: "number" },
          yPct: { type: "number" },
          widthPct: { type: "number" },
          heightPct: { type: "number" },
        },
      },
      rotationDegrees: {
        type: ["integer", "null"],
        description: "The CLOCKWISE rotation in degrees (must be 0, 90, 180, or 270) needed to make the label's text and barcode read normally upright (top-to-bottom, left-to-right, not sideways or upside down). 0 if it's already upright. Null if this can't be determined.",
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    tools: [ANALYZE_TOOL],
    tool_choice: { type: "tool", name: "analyze_shipping_label" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          {
            type: "text",
            text: "This image may contain a shipping label, possibly alongside other content (a screenshot, a packing slip, etc.), and it may be sideways or upside down. Identify the marketplace/carrier, the recipient's name, and the clockwise rotation needed to make it read upright. For the cropBox: a shipping label is one continuous printable area that includes the postage/address section AND the barcode AND the tracking number below it - trace the label's own printed border/cut-line all the way around, and make sure the box reaches down to include the barcode and tracking number, not just the address block above it.",
          },
        ],
      },
    ],
  });
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured result");
  return toolUse.input;
}
