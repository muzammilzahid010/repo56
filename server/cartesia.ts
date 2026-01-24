/**
 * Cartesia API Integration for Text-to-Speech V2 and Voice Cloning V2
 * Supports multiple API keys with automatic rotation
 */

import { db } from "./db";
import { cartesiaTokens } from "@shared/schema";
import { eq } from "drizzle-orm";

const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_CLONE_URL = "https://api.cartesia.ai/voices/clone/clip";
const CARTESIA_VOICES_URL = "https://api.cartesia.ai/voices";

export interface CartesiaTTSRequest {
  text: string;
  voiceId: string;
  speed?: "slowest" | "slow" | "normal" | "fast" | "fastest";
  emotion?: string[];
  language?: string;
}

export interface CartesiaResponse {
  success: boolean;
  audioData?: Buffer;
  error?: string;
  tokenId?: string;
  charactersUsed?: number;
}

export interface CartesiaVoiceCloneRequest {
  clip: Buffer;
  name: string;
  description?: string;
  mode?: "similarity" | "stability";
  language?: string;
  enhance?: boolean;
}

export interface CartesiaVoice {
  id: string;
  name: string;
  description?: string;
  language: string;
  is_public: boolean;
}

const MAX_ERROR_COUNT = 10;
const DEFAULT_CHARACTERS_LIMIT = 20000;
const MAX_CHARACTERS_PER_CALL = 20000; // Cartesia API limit per single request

async function checkAndAutoDisableTokens(): Promise<void> {
  try {
    const allActiveTokens = await db
      .select()
      .from(cartesiaTokens)
      .where(eq(cartesiaTokens.isActive, true));
    
    for (const token of allActiveTokens) {
      const charactersUsed = token.charactersUsed || 0;
      const charactersLimit = token.charactersLimit || DEFAULT_CHARACTERS_LIMIT;
      const errorCount = token.errorCount || 0;
      
      if (charactersUsed >= charactersLimit) {
        console.log(`[Cartesia Auto-Disable] Token ${token.id.slice(0, 8)} exceeded character limit. Disabling...`);
        await db
          .update(cartesiaTokens)
          .set({ isActive: false })
          .where(eq(cartesiaTokens.id, token.id));
        continue;
      }
      
      if (errorCount >= MAX_ERROR_COUNT) {
        console.log(`[Cartesia Auto-Disable] Token ${token.id.slice(0, 8)} has ${errorCount} errors. Disabling...`);
        await db
          .update(cartesiaTokens)
          .set({ isActive: false })
          .where(eq(cartesiaTokens.id, token.id));
      }
    }
  } catch (error) {
    console.error("[Cartesia Auto-Disable] Error checking tokens:", error);
  }
}

export async function getAvailableCartesiaToken(
  excludeTokenIds: string[] = [], 
  requiredCharacters: number = 0
): Promise<{ id: string; apiKey: string; remainingCapacity: number } | null> {
  try {
    const allTokens = await db
      .select()
      .from(cartesiaTokens)
      .where(eq(cartesiaTokens.isActive, true));
    
    // Filter out excluded tokens and check remaining capacity
    const availableTokens = allTokens
      .filter(t => !excludeTokenIds.includes(t.id))
      .map(t => ({
        ...t,
        remainingCapacity: (t.charactersLimit || DEFAULT_CHARACTERS_LIMIT) - (t.charactersUsed || 0)
      }))
      .filter(t => t.remainingCapacity > 0); // Only tokens with capacity

    // If required characters specified, filter by capacity
    let suitableTokens = availableTokens;
    if (requiredCharacters > 0) {
      suitableTokens = availableTokens.filter(t => t.remainingCapacity >= requiredCharacters);
    }

    // Sort by remaining capacity (highest first) to use most available token
    suitableTokens.sort((a, b) => b.remainingCapacity - a.remainingCapacity);

    if (suitableTokens.length === 0) {
      // If no tokens with sufficient capacity, try any available token (for small requests)
      if (availableTokens.length > 0 && requiredCharacters <= MAX_CHARACTERS_PER_CALL) {
        const bestAvailable = availableTokens.sort((a, b) => b.remainingCapacity - a.remainingCapacity)[0];
        console.log(`[Cartesia] No token has ${requiredCharacters} chars capacity, using best available with ${bestAvailable.remainingCapacity}`);
        return { id: bestAvailable.id, apiKey: bestAvailable.apiKey, remainingCapacity: bestAvailable.remainingCapacity };
      }
      
      // Check if we excluded all tokens
      if (allTokens.length > 0 && excludeTokenIds.length > 0) {
        const fallbackToken = allTokens[0];
        const remaining = (fallbackToken.charactersLimit || DEFAULT_CHARACTERS_LIMIT) - (fallbackToken.charactersUsed || 0);
        console.log(`[Cartesia] All available tokens excluded, using fallback`);
        return { id: fallbackToken.id, apiKey: fallbackToken.apiKey, remainingCapacity: Math.max(0, remaining) };
      }
      return null;
    }
    
    const token = suitableTokens[0];
    console.log(`[Cartesia] Selected token with ${token.remainingCapacity} remaining capacity for ${requiredCharacters} chars`);
    return { id: token.id, apiKey: token.apiKey, remainingCapacity: token.remainingCapacity };
  } catch (error) {
    console.error("Error getting Cartesia token:", error);
    return null;
  }
}

async function updateTokenUsage(tokenId: string, charactersUsed: number): Promise<void> {
  try {
    const token = await db.select().from(cartesiaTokens).where(eq(cartesiaTokens.id, tokenId)).limit(1);
    if (token.length > 0) {
      const currentUsage = token[0].charactersUsed || 0;
      await db
        .update(cartesiaTokens)
        .set({ 
          charactersUsed: currentUsage + charactersUsed,
          lastUsedAt: new Date().toISOString()
        })
        .where(eq(cartesiaTokens.id, tokenId));
      
      await checkAndAutoDisableTokens();
    }
  } catch (error) {
    console.error("Error updating Cartesia token usage:", error);
  }
}

async function incrementTokenError(tokenId: string): Promise<void> {
  try {
    const token = await db.select().from(cartesiaTokens).where(eq(cartesiaTokens.id, tokenId)).limit(1);
    if (token.length > 0) {
      const currentErrors = token[0].errorCount || 0;
      await db
        .update(cartesiaTokens)
        .set({ errorCount: currentErrors + 1 })
        .where(eq(cartesiaTokens.id, tokenId));
      
      await checkAndAutoDisableTokens();
    }
  } catch (error) {
    console.error("Error incrementing Cartesia token error:", error);
  }
}

// Split text into chunks at sentence boundaries (preferred) or at max length
function splitTextIntoChunks(text: string, maxChunkSize: number = MAX_CHARACTERS_PER_CALL): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remainingText = text;

  while (remainingText.length > 0) {
    if (remainingText.length <= maxChunkSize) {
      chunks.push(remainingText);
      break;
    }

    // Try to find a good split point (sentence end) within the limit
    let splitIndex = maxChunkSize;
    
    // Look for sentence endings (. ! ?) within the last 20% of the chunk
    const searchStart = Math.floor(maxChunkSize * 0.8);
    const searchArea = remainingText.substring(searchStart, maxChunkSize);
    
    // Find the last sentence ending in the search area
    const sentenceEndMatch = searchArea.match(/[.!?]\s+(?=[A-Z])|[.!?]$/g);
    if (sentenceEndMatch) {
      const lastMatch = sentenceEndMatch[sentenceEndMatch.length - 1];
      const matchIndex = searchArea.lastIndexOf(lastMatch);
      if (matchIndex !== -1) {
        splitIndex = searchStart + matchIndex + lastMatch.length;
      }
    }
    
    // If no sentence end found, try splitting at word boundary
    if (splitIndex === maxChunkSize) {
      const lastSpace = remainingText.substring(0, maxChunkSize).lastIndexOf(' ');
      if (lastSpace > maxChunkSize * 0.7) {
        splitIndex = lastSpace + 1;
      }
    }

    chunks.push(remainingText.substring(0, splitIndex).trim());
    remainingText = remainingText.substring(splitIndex).trim();
  }

  console.log(`[Cartesia] Split ${text.length} chars into ${chunks.length} chunks: ${chunks.map(c => c.length).join(', ')} chars`);
  return chunks;
}

// Generate speech for a single chunk
async function generateSpeechChunk(
  request: CartesiaTTSRequest,
  token: { id: string; apiKey: string },
  maxRetries: number = 3
): Promise<CartesiaResponse> {
  const speedMap: Record<string, number> = {
    "slowest": -1,
    "slow": -0.5,
    "normal": 0,
    "fast": 0.5,
    "fastest": 1
  };
  
  const body: any = {
    model_id: "sonic-2",
    transcript: request.text,
    voice: {
      mode: "id",
      id: request.voiceId
    },
    output_format: {
      container: "mp3",
      bit_rate: 128000,
      sample_rate: 44100
    },
    language: request.language || "en"
  };
  
  if (request.speed && request.speed !== "normal") {
    body.voice.__experimental_controls = {
      speed: speedMap[request.speed] || 0
    };
  }
  
  if (request.emotion && request.emotion.length > 0) {
    if (!body.voice.__experimental_controls) {
      body.voice.__experimental_controls = {};
    }
    body.voice.__experimental_controls.emotion = request.emotion;
  }
  
  const response = await fetch(CARTESIA_TTS_URL, {
    method: "POST",
    headers: {
      "X-API-Key": token.apiKey,
      "Cartesia-Version": "2024-06-10",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Cartesia TTS Chunk] Error ${response.status}: ${errorText}`);
    
    // Mark as retriable error
    if (response.status === 402 || response.status === 401 || response.status === 403) {
      await incrementTokenError(token.id);
      return { success: false, error: `TOKEN_ERROR:${response.status}` };
    }
    
    return { success: false, error: `API error: ${response.status} - ${errorText}` };
  }
  
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const charactersUsed = request.text.length;
  
  await updateTokenUsage(token.id, charactersUsed);
  
  return {
    success: true,
    audioData: audioBuffer,
    tokenId: token.id,
    charactersUsed
  };
}

export async function generateSpeechWithRetry(request: CartesiaTTSRequest, maxRetries: number = 3): Promise<CartesiaResponse> {
  const totalCharacters = request.text.length;
  
  // Check if text needs chunking
  if (totalCharacters <= MAX_CHARACTERS_PER_CALL) {
    // Single chunk - use original logic with smart token selection
    return await generateSingleSpeech(request, maxRetries);
  }
  
  // Multi-chunk processing
  console.log(`[Cartesia] Text has ${totalCharacters} chars, splitting into chunks (max ${MAX_CHARACTERS_PER_CALL} per call)`);
  const chunks = splitTextIntoChunks(request.text);
  const audioBuffers: Buffer[] = [];
  let totalCharsUsed = 0;
  let lastTokenId: string | undefined;
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[Cartesia] Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);
    
    const chunkRequest: CartesiaTTSRequest = {
      ...request,
      text: chunk
    };
    
    // Get token with enough capacity for this chunk
    const result = await generateSingleSpeech(chunkRequest, maxRetries);
    
    if (!result.success) {
      return { 
        success: false, 
        error: `Failed at chunk ${i + 1}/${chunks.length}: ${result.error}`,
        charactersUsed: totalCharsUsed
      };
    }
    
    if (result.audioData) {
      audioBuffers.push(result.audioData);
    }
    totalCharsUsed += result.charactersUsed || 0;
    lastTokenId = result.tokenId;
  }
  
  // Concatenate all audio buffers (simple concatenation for MP3)
  const combinedAudio = Buffer.concat(audioBuffers);
  console.log(`[Cartesia] Combined ${audioBuffers.length} chunks into ${combinedAudio.length} bytes`);
  
  return {
    success: true,
    audioData: combinedAudio,
    tokenId: lastTokenId,
    charactersUsed: totalCharsUsed
  };
}

// Original single-chunk speech generation with smart token selection
async function generateSingleSpeech(request: CartesiaTTSRequest, maxRetries: number = 3): Promise<CartesiaResponse> {
  const excludedTokens: string[] = [];
  const requiredChars = request.text.length;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const token = await getAvailableCartesiaToken(excludedTokens, requiredChars);
    
    if (!token) {
      return { success: false, error: `No Cartesia token with sufficient capacity (${requiredChars} chars needed). Please add more tokens or reset usage.` };
    }
    
    try {
      const result = await generateSpeechChunk(request, token, 1);
      
      if (result.success) {
        return result;
      }
      
      // Check if it's a token error that should trigger retry with different token
      if (result.error?.startsWith("TOKEN_ERROR:")) {
        excludedTokens.push(token.id);
        continue;
      }
      
      // Non-retriable error
      return result;
      
    } catch (error: any) {
      console.error(`[Cartesia TTS] Attempt ${attempt} failed:`, error.message);
      await incrementTokenError(token.id);
      excludedTokens.push(token.id);
    }
  }
  
  return { success: false, error: "All Cartesia tokens failed. Please check your API keys." };
}

export async function cloneVoiceWithRetry(request: CartesiaVoiceCloneRequest, maxRetries: number = 3): Promise<{ success: boolean; voice?: CartesiaVoice; error?: string }> {
  const excludedTokens: string[] = [];
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const token = await getAvailableCartesiaToken(excludedTokens);
    
    if (!token) {
      return { success: false, error: "No available Cartesia API tokens. Please add tokens in admin panel." };
    }
    
    try {
      const FormData = (await import("form-data")).default;
      const formData = new FormData();
      formData.append("clip", request.clip, {
        filename: "audio.wav",
        contentType: "audio/wav"
      });
      formData.append("name", request.name);
      if (request.description) formData.append("description", request.description);
      formData.append("mode", request.mode || "similarity");
      formData.append("language", request.language || "en");
      if (request.enhance) formData.append("enhance", "true");
      
      const response = await fetch(CARTESIA_CLONE_URL, {
        method: "POST",
        headers: {
          "X-API-Key": token.apiKey,
          "Cartesia-Version": "2024-06-10",
          ...formData.getHeaders()
        },
        body: formData as any
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Cartesia Clone] Error ${response.status}: ${errorText}`);
        
        if (response.status === 402 || response.status === 401 || response.status === 403) {
          await incrementTokenError(token.id);
          excludedTokens.push(token.id);
          continue;
        }
        
        return { success: false, error: `API error: ${response.status} - ${errorText}` };
      }
      
      const voice = await response.json() as CartesiaVoice;
      await updateTokenUsage(token.id, 1000);
      
      return { success: true, voice };
      
    } catch (error: any) {
      console.error(`[Cartesia Clone] Attempt ${attempt} failed:`, error.message);
      await incrementTokenError(token.id);
      excludedTokens.push(token.id);
    }
  }
  
  return { success: false, error: "All Cartesia tokens failed. Please check your API keys." };
}

export async function deleteVoice(voiceId: string): Promise<{ success: boolean; error?: string }> {
  const token = await getAvailableCartesiaToken();
  
  if (!token) {
    return { success: false, error: "No available Cartesia API tokens." };
  }
  
  try {
    const response = await fetch(`${CARTESIA_VOICES_URL}/${voiceId}`, {
      method: "DELETE",
      headers: {
        "X-API-Key": token.apiKey,
        "Cartesia-Version": "2024-06-10"
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to delete voice: ${errorText}` };
    }
    
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function listVoices(): Promise<{ success: boolean; voices?: CartesiaVoice[]; error?: string }> {
  const token = await getAvailableCartesiaToken();
  
  if (!token) {
    return { success: false, error: "No available Cartesia API tokens." };
  }
  
  try {
    const response = await fetch(CARTESIA_VOICES_URL, {
      method: "GET",
      headers: {
        "X-API-Key": token.apiKey,
        "Cartesia-Version": "2024-06-10"
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to list voices: ${errorText}` };
    }
    
    const voices = await response.json() as CartesiaVoice[];
    return { success: true, voices };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getAllCartesiaTokens() {
  return await db.select().from(cartesiaTokens);
}

export async function addCartesiaToken(apiKey: string, label: string, charactersLimit: number = 20000) {
  const [token] = await db
    .insert(cartesiaTokens)
    .values({ apiKey, label, charactersLimit })
    .returning();
  return token;
}

export async function updateCartesiaToken(id: string, updates: Partial<{ label: string; isActive: boolean; charactersUsed: number; charactersLimit: number; errorCount: number }>) {
  const [token] = await db
    .update(cartesiaTokens)
    .set(updates)
    .where(eq(cartesiaTokens.id, id))
    .returning();
  return token;
}

export async function deleteCartesiaToken(id: string) {
  await db.delete(cartesiaTokens).where(eq(cartesiaTokens.id, id));
}

export async function deleteAllCartesiaTokens() {
  await db.delete(cartesiaTokens);
}

export async function resetAllTokenUsage() {
  await db.update(cartesiaTokens).set({ charactersUsed: 0, errorCount: 0 });
}

export async function resetTokenUsage(id: string) {
  await db
    .update(cartesiaTokens)
    .set({ charactersUsed: 0, errorCount: 0 })
    .where(eq(cartesiaTokens.id, id));
}

export async function getCartesiaTokenStats() {
  const tokens = await db.select().from(cartesiaTokens);
  const active = tokens.filter(t => t.isActive).length;
  const disabled = tokens.filter(t => !t.isActive).length;
  const totalCharactersUsed = tokens.reduce((sum, t) => sum + (t.charactersUsed || 0), 0);
  return { active, disabled, total: tokens.length, totalCharactersUsed };
}

export const CARTESIA_VOICES = [
  { id: "a0e99841-438c-4a64-b679-ae501e7d6091", name: "Barbershop Man", language: "en" },
  { id: "156fb8d2-335b-4950-9cb3-a2d33f2c6f29", name: "British Lady", language: "en" },
  { id: "248be419-c632-4f23-adf1-5324ed7dbf1d", name: "Professional Woman", language: "en" },
  { id: "79a125e8-cd45-4c13-8a67-188112f4dd22", name: "British Reading Lady", language: "en" },
  { id: "87748186-23bb-4158-a1eb-332911b0b708", name: "Californian Girl", language: "en" },
  { id: "71a7ad14-091c-4e8e-a314-022ece01c121", name: "Child", language: "en" },
  { id: "5619d38c-cf51-4d8e-9575-48f61a280413", name: "Commercial Lady", language: "en" },
  { id: "ee7ea9f8-c0c1-498c-9f62-dc2627e1c6c0", name: "Friendly Australian Man", language: "en" },
  { id: "c45bc5ec-dc68-4feb-8829-6e6b2748095d", name: "Friendly Reading Man", language: "en" },
  { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", name: "Hindi Narrator", language: "hi" },
  { id: "69267136-1bdc-412f-ad78-0caad210fb40", name: "Indian Lady", language: "en" },
  { id: "638efaaa-4d0c-442e-b701-3fae16aad012", name: "Maria", language: "es" },
  { id: "63ff761f-c1e8-414b-b969-d1833d1c870c", name: "Middle Eastern Woman", language: "ar" },
  { id: "e3827ec5-697a-4b7c-9704-1a23041bbc51", name: "Newsman", language: "en" },
  { id: "a3520a8f-226a-428d-9fcd-b0a4711a6b87", name: "Nonfiction Man", language: "en" },
  { id: "5c42302c-194b-4d0c-ba1a-8cb485c84ab9", name: "Reflective Woman", language: "en" },
  { id: "421b3369-f63f-4b03-8980-37a44df1d4e8", name: "Sarah", language: "en" },
  { id: "f114a467-c40a-4db8-964d-aaba89cd08fa", name: "Sportsman", language: "en" },
  { id: "820a3788-2b37-4d21-847a-b65d8a68c99a", name: "Teacher Lady", language: "en" },
  { id: "c8605446-247c-4f69-a798-929bdbdc03e4", name: "The Merchant", language: "en" },
  { id: "41534e16-2966-4c6b-9670-111411def906", name: "Youtube Narrator", language: "en" }
];

export const CARTESIA_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "ja", name: "Japanese" },
  { code: "pt", name: "Portuguese" },
  { code: "zh", name: "Chinese" },
  { code: "hi", name: "Hindi" },
  { code: "it", name: "Italian" },
  { code: "ko", name: "Korean" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "ru", name: "Russian" },
  { code: "sv", name: "Swedish" },
  { code: "tr", name: "Turkish" }
];
