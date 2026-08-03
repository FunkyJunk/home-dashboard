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
// against real labels that Haiku-tier spatial judgment wasn't reliable
// enough here, in two distinct ways: it cut off the barcode/tracking
// section from the crop box on one label, and got the rotation direction
// backwards on another (rotated a sideways label the wrong way, leaving
// it upside down instead of upright) - the latter is why rotation is
// determined via labelTopEdge + a fixed lookup table below rather than
// asking the model to compute a rotation angle directly: "which edge is
// the top pointing at" is a concrete perceptual question, "what's the
// clockwise angle to fix this" requires the model to do its own mental
// rotation arithmetic, which is exactly where it went wrong.
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
        description: "Describe what you actually see, in this order: (1) where the label's own bordered 'main shipping info' box is relative to the rest of the image - the printed rectangle enclosing the postage stamp/logo and the ship-from/ship-to addresses; (2) the label's full internal layout top-to-bottom, including whatever sits below that bordered box - typically a barcode, tracking number text, and a QR code; (3) look specifically at the address text inside the ship-to block and determine which way it currently reads - normally upright, sideways (rotated 90 either way), or upside down. Base every field below on this description.",
      },
      marketplace: {
        type: ["string", "null"],
        description: "The marketplace/platform whose branding appears on the label - e.g. 'Amazon', 'Etsy', 'eBay', 'Shopify', 'Poshmark'. If no marketplace branding is present and it's just a bare carrier label, use the carrier name instead (e.g. 'USPS', 'UPS', 'FedEx'). Null if it can't be determined at all.",
      },
      recipientName: {
        type: ["string", "null"],
        description: "The name of the person or business the package is addressed to (the 'Ship To' recipient), exactly as printed on the label. Null if not legible.",
      },
      // Asking for a rotation ANGLE directly requires the model to do
      // mental rotation arithmetic (which way is "clockwise" from this
      // orientation?), and that's proven unreliable in practice - it fixed
      // one real upside-down label but then rotated a different sideways
      // label the wrong way, leaving it upside down instead of upright.
      // Asking which EDGE the label's top is touching is a much more
      // concrete, purely perceptual question with no arithmetic involved;
      // the actual rotation angle is then computed in code from a fixed
      // lookup table, never left to the model's own reasoning.
      labelTopEdge: {
        type: ["string", "null"],
        enum: ["top", "bottom", "left", "right", null],
        description: "A label has a natural top (the postage/address end) and bottom (the barcode/tracking-number end), always at OPPOSITE ends. Looking at the image exactly as given (do not mentally rotate it first): which edge of the IMAGE is the label's TOP end currently pointing toward? Example: if the barcode/tracking end is on the image's left side and the postage/address end is on the image's right side, the top is pointing toward 'right'. If the label already reads normally upright, answer 'top'. Null if this can't be determined.",
      },
      cropBox: {
        type: ["object", "null"],
        description: "Based on part (1) of labelDescription: the bounding box of JUST the bordered 'main shipping info' box - the printed rectangle that has its own solid border/cut-line on all four sides and encloses the postage stamp/logo plus the ship-from/ship-to addresses. Give the box's own top, left, and right edges as tightly as you can read them. Do NOT include the barcode, tracking-number text, or QR code below this box - those sit outside this border and are handled separately in code. As percentages of the FULL image's width/height (each 0-100, xPct/yPct is the top-left corner). heightPct should describe only this bordered box's own height (top border to bottom border), not the space below it. Measured in the image's ORIGINAL orientation, before any rotation. Null if this bordered box can't be distinguished from the rest of the label.",
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
  const startedAt = Date.now();
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
            text: "This image may contain a shipping label, possibly alongside other content (a screenshot, a packing slip, etc.), and it may be sideways or upside down. Describe what you see first, then identify the marketplace/carrier, the recipient's name, which edge of the image the label's top is pointing toward (based on the ship-to address text's reading direction), and the bounding box of just the bordered main shipping info box (excluding the barcode/QR section below it).",
          },
        ],
      },
    ],
  });
  console.log(`[shippingLabels] Anthropic call took ${Date.now() - startedAt}ms (image ~${Math.round(base64Image.length / 1024)}KB base64)`);
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured result");
  const result = toolUse.input;

  // The clockwise rotation needed to bring that edge back to "top" - e.g.
  // if the top is currently pointing right, the whole image was rotated
  // 90 clockwise from upright, so undoing it takes another 270 clockwise.
  const ROTATION_FOR_TOP_EDGE = { top: 0, right: 270, bottom: 180, left: 90 };
  result.rotationDegrees = ROTATION_FOR_TOP_EDGE[result.labelTopEdge] ?? 0;

  return result;
}
