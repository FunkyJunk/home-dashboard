import Anthropic from "@anthropic-ai/sdk";

// Reuses the same ANTHROPIC_API_KEY already configured for receipt-email
// extraction (see receipts.js) - one Claude vision call reads the pasted/
// dragged label image and returns everything the Scratch Pad's shipping-
// label tool needs: which marketplace generated it, who it's addressed to,
// and roughly where the label itself sits within the full image (which may
// contain other content around it, e.g. a screenshot or a packing slip).
//
// Uses Sonnet rather than the Haiku model receipts.js uses - this is a
// precise spatial/visual judgment task (bounding boxes, rotation
// direction), and label prints are low-volume compared to bulk receipt
// scanning, so the accuracy is worth the extra per-call cost. Confirmed
// against two real labels that Haiku-tier spatial judgment wasn't reliable
// enough here: it cut off the barcode/tracking section from the crop box
// on one, and misjudged rotation (flipped an already-upright label 180)
// on another.
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
      // Placed early and required so the model reasons through what it's
      // actually looking at before committing to the numeric fields below -
      // forcing an explicit description first (rather than jumping straight
      // to coordinates/degrees) measurably improves spatial judgment
      // accuracy on this kind of task.
      labelDescription: {
        type: "string",
        description: "Describe what you actually see, in this order: (1) where the label's outer border/cut-line is relative to the rest of the image - does it touch any edge of the image, or is there space around it on any side; (2) the label's own internal layout top-to-bottom - e.g. postage/address block, then barcode, then tracking number text, then any QR code; (3) which direction the text currently reads - normally upright, sideways (rotated 90 either way), or upside down. Base every field below on this description.",
      },
      marketplace: {
        type: ["string", "null"],
        description: "The marketplace/platform whose branding appears on the label - e.g. 'Amazon', 'Etsy', 'eBay', 'Shopify', 'Poshmark'. If no marketplace branding is present and it's just a bare carrier label, use the carrier name instead (e.g. 'USPS', 'UPS', 'FedEx'). Null if it can't be determined at all.",
      },
      recipientName: {
        type: ["string", "null"],
        description: "The name of the person or business the package is addressed to (the 'Ship To' recipient), exactly as printed on the label. Null if not legible.",
      },
      rotationDegrees: {
        type: ["integer", "null"],
        description: "Based on part (3) of labelDescription: the CLOCKWISE rotation in degrees (must be exactly 0, 90, 180, or 270) needed to make the label's text and barcode read normally upright. Default to 0 - only answer 90/180/270 if the description above clearly established the text is sideways or upside down, never guess a rotation from an image that already reads normally. Null if this can't be determined at all.",
      },
      cropBox: {
        type: ["object", "null"],
        description: "Based on parts (1) and (2) of labelDescription: the bounding box of the COMPLETE printable label, from its outer border/cut-line at the top all the way down to its outer border/cut-line at the bottom - as percentages of the FULL image's width/height (each 0-100, xPct/yPct is the top-left corner). This MUST include every part of the label described in part (2): the postage/address block AND the barcode AND the tracking number text AND any QR code - all stacked vertically as ONE continuous printable label, never just the address portion on its own. When at all unsure, make the box LARGER (closer to the full image bounds from part (1)) rather than risk cutting anything off. Measured in the image's ORIGINAL orientation, before any rotation. Null if the label already fills the entire image edge-to-edge.",
        properties: {
          xPct: { type: "number" },
          yPct: { type: "number" },
          widthPct: { type: "number" },
          heightPct: { type: "number" },
        },
      },
    },
    required: ["isLabel", "labelDescription"],
  },
};

export async function analyzeShippingLabel(base64Image, mediaType) {
  if (!anthropic) {
    throw new Error("Shipping label analysis not configured - set ANTHROPIC_API_KEY");
  }
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1536,
    tools: [ANALYZE_TOOL],
    tool_choice: { type: "tool", name: "analyze_shipping_label" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          {
            type: "text",
            text: "This image may contain a shipping label, possibly alongside other content (a screenshot, a packing slip, etc.), and it may be sideways or upside down. Describe what you see first, then identify the marketplace/carrier, the recipient's name, the rotation needed to make it read upright, and the complete crop box.",
          },
        ],
      },
    ],
  });
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured result");
  return toolUse.input;
}
