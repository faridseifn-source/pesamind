const env = require("../../lib/env");
const { MockOcrProvider } = require("./MockOcrProvider");

let instance;

function getOcrProvider() {
  if (instance) return instance;

  switch (env.providers.ocr) {
    case "openai_vision": {
      const { OpenAiVisionOcrProvider } = require("./OpenAiVisionOcrProvider");
      if (!env.ocr.openaiApiKey) throw new Error("OCR_PROVIDER=openai_vision requires OPENAI_API_KEY to be set");
      instance = new OpenAiVisionOcrProvider({ apiKey: env.ocr.openaiApiKey });
      break;
    }
    case "mock":
    default:
      instance = new MockOcrProvider();
  }
  return instance;
}

module.exports = { getOcrProvider };
