import { extractText, getDocumentProxy } from "unpdf";

export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfParseError";
  }
}

export async function extractPdfText(pdf: Uint8Array): Promise<string> {
  let text: string;
  try {
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const out = await extractText(doc, { mergePages: true });
    text = out.text;
  } catch (e) {
    throw new PdfParseError(`could not parse PDF: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (text.trim() === "") throw new PdfParseError("PDF contains no extractable text");
  return text;
}
