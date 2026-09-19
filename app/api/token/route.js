import { GoogleGenAI } from "@google/genai";

export async function GET() {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(
        Date.now() + 60 * 1000
      ).toISOString(),
    },
  });

  return Response.json({ token: token.name });
}