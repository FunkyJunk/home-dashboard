import Anthropic from "@anthropic-ai/sdk";

// Amazon return QR screenshots always show a small item-description table
// (description + quantity) above the actual QR code block - the QR crop
// itself is cropped deterministically on the frontend (see
// findQrGroupBbox/cropQrGroup in index.html), same "pixels for geometry,
// Claude for text" split as shippingLabels.js. This call only reads the
// table text; it never touches rotation or cropping.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const ANALYZE_TOOL = {
  name: "analyze_return_screenshot",
  description: "Read the item description and quantity from an Amazon return QR screenshot's item table.",
  input_schema: {
    type: "object",
    properties: {
      itemDescription: {
        type: ["string", "null"],
        description: "The exact text from the 'Item Description' column/field of the table at the top of the screenshot. Null if no such table is legible.",
      },
      quantity: {
        type: ["integer", "null"],
        description: "The number from the 'Quantity' column/field of the same table. Null if not legible.",
      },
    },
    required: ["itemDescription", "quantity"],
  },
};

export async function analyzeReturnScreenshot(base64Image, mediaType) {
  if (!anthropic) {
    throw new Error("Return screenshot analysis not configured - set ANTHROPIC_API_KEY");
  }
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 512,
    tools: [ANALYZE_TOOL],
    tool_choice: { type: "tool", name: "analyze_return_screenshot" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
          {
            type: "text",
            text: "This is a screenshot of an Amazon return QR code page. It has a small table near the top with an 'Item Description' and 'Quantity' field, followed by a QR code with unrelated boilerplate text above/below it and an RMA ID. Read only the Item Description and Quantity from the table.",
          },
        ],
      },
    ],
  });
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured result");
  return toolUse.input;
}
