import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const latexMap: Record<string, string> = {
  "\\rightarrow": "→",
  "\\leftarrow": "←",
  "\\to": "→",
  //  "\\Rightarrow": "⇒",
//  "\\Leftarrow": "⇐",
//  "\\leftrightarrow": "↔",
//  "\\implies": "⇒",
//  "\\approx": "≈",

//  "\\infty": "∞",
  "\\checkmark": "✓"
};

const sortedSymbols = Object.entries(latexMap).sort((a, b) => b[0].length - a[0].length);

const applyLatexSymbols = (text: string): string => {
  return text.replace(/\$\$(.+?)\$\$|\$(.+?)\$/gs, (match, double, single) => {
    const content = double !== undefined ? double : single;
    let processed = content;
    for (const [symbol, replacement] of sortedSymbols) {
      processed = processed.split(symbol).join(replacement);
    }
    return processed !== content ? processed : match;
  });
};

export default function (pi: ExtensionAPI) {
  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;

    for (const block of event.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = applyLatexSymbols(block.text);
      }
    }
  });
}
