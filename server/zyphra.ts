/**
 * Zyphra API Integration for Voice Cloning and Text-to-Speech
 * Supports multiple API keys with automatic rotation
 */

import { db } from "./db";
import { zyphraTokens } from "@shared/schema";
import { eq } from "drizzle-orm";

const ZYPHRA_API_URL = "http://api.zyphra.com/v1/audio/text-to-speech";

export interface ZyphraTextToSpeechRequest {
  text: string;
  speakingRate?: number; // 5-35, default 15
  model?: "zonos-v0.1-transformer" | "zonos-v0.1-hybrid";
  languageIsoCode?: string; // en-us, fr-fr, de, ja, ko, cmn
  mimeType?: "audio/webm" | "audio/mp3" | "audio/wav" | "audio/ogg";
  speakerAudio?: string; // Base64 encoded audio for voice cloning
  emotion?: {
    happiness?: number;
    sadness?: number;
    disgust?: number;
    fear?: number;
    surprise?: number;
    anger?: number;
    other?: number;
    neutral?: number;
  };
  pitchStd?: number; // 0-100, default 45
  speakerNoised?: boolean; // For hybrid model only
  defaultVoiceName?: string; // Use predefined voice
}

export interface ZyphraResponse {
  success: boolean;
  audioData?: Buffer;
  mimeType?: string;
  error?: string;
  tokenId?: string;
  charactersUsed?: number;
}

const MAX_ERROR_COUNT = 10; // Auto-disable tokens with 10+ errors
const DEFAULT_CHARACTERS_LIMIT = 50000; // 50k characters per key

/**
 * Check and auto-disable tokens that exceed limits
 * - Character limit exceeded (50k default)
 * - 3 or more errors
 */
async function checkAndAutoDisableTokens(): Promise<void> {
  try {
    const allActiveTokens = await db
      .select()
      .from(zyphraTokens)
      .where(eq(zyphraTokens.isActive, true));
    
    for (const token of allActiveTokens) {
      const charactersUsed = token.charactersUsed || 0;
      const charactersLimit = token.charactersLimit || DEFAULT_CHARACTERS_LIMIT;
      const errorCount = token.errorCount || 0;
      
      // Check character limit
      if (charactersUsed >= charactersLimit) {
        console.log(`[Zyphra Auto-Disable] Token ${token.id.slice(0, 8)} exceeded character limit (${charactersUsed}/${charactersLimit}). Disabling...`);
        await db
          .update(zyphraTokens)
          .set({ isActive: false })
          .where(eq(zyphraTokens.id, token.id));
        console.log(`[Zyphra Auto-Disable] Token ${token.id.slice(0, 8)} has been disabled (character limit).`);
        continue;
      }
      
      // Check error count
      if (errorCount >= MAX_ERROR_COUNT) {
        console.log(`[Zyphra Auto-Disable] Token ${token.id.slice(0, 8)} has ${errorCount} errors (>= ${MAX_ERROR_COUNT}). Disabling...`);
        await db
          .update(zyphraTokens)
          .set({ isActive: false })
          .where(eq(zyphraTokens.id, token.id));
        console.log(`[Zyphra Auto-Disable] Token ${token.id.slice(0, 8)} has been disabled (too many errors).`);
      }
    }
  } catch (error) {
    console.error("[Zyphra Auto-Disable] Error checking tokens:", error);
  }
}

/**
 * Get an available Zyphra API token (character-based limits only)
 * @param excludeTokenIds - Optional array of token IDs to exclude (for retry logic)
 */
export async function getAvailableZyphraToken(excludeTokenIds: string[] = []): Promise<{ id: string; apiKey: string } | null> {
  try {
    // Get active tokens directly (auto-disable check moved to after usage update for speed)
    const allTokens = await db
      .select()
      .from(zyphraTokens)
      .where(eq(zyphraTokens.isActive, true));
    
    // Filter out excluded tokens
    const availableTokens = allTokens.filter(t => !excludeTokenIds.includes(t.id));

    if (availableTokens.length === 0) {
      // If all tokens are excluded but there are active tokens, allow retry with excluded tokens
      if (allTokens.length > 0 && excludeTokenIds.length > 0) {
        console.log(`[Zyphra] All available tokens were excluded, falling back to excluded tokens`);
        return { id: allTokens[0].id, apiKey: allTokens[0].apiKey };
      }
      return null;
    }
    
    const token = availableTokens[0];
    return { id: token.id, apiKey: token.apiKey };
  } catch (error) {
    console.error("Error getting Zyphra token:", error);
    return null;
  }
}

/**
 * Update token usage after API call (characters only)
 */
async function updateTokenUsage(tokenId: string, charactersUsed: number): Promise<void> {
  try {
    const token = await db.select().from(zyphraTokens).where(eq(zyphraTokens.id, tokenId)).limit(1);
    if (token.length > 0) {
      const newCharactersUsed = (token[0].charactersUsed || 0) + charactersUsed;
      const charactersLimit = token[0].charactersLimit || DEFAULT_CHARACTERS_LIMIT;
      
      await db
        .update(zyphraTokens)
        .set({
          charactersUsed: newCharactersUsed,
          lastUsedAt: new Date().toISOString(),
        })
        .where(eq(zyphraTokens.id, tokenId));
      
      console.log(`[Zyphra] Token ${tokenId.slice(0, 8)} usage: +${charactersUsed} chars (${newCharactersUsed}/${charactersLimit})`);
      
      // Auto-disable if character limit reached
      if (newCharactersUsed >= charactersLimit) {
        console.log(`[Zyphra] Token ${tokenId.slice(0, 8)} reached character limit. Auto-disabling...`);
        await db
          .update(zyphraTokens)
          .set({ isActive: false })
          .where(eq(zyphraTokens.id, tokenId));
      }
    }
  } catch (error) {
    console.error("Error updating token usage:", error);
  }
}

/**
 * Increment error count for a token
 */
async function incrementTokenError(tokenId: string): Promise<void> {
  try {
    const token = await db.select().from(zyphraTokens).where(eq(zyphraTokens.id, tokenId)).limit(1);
    if (token.length > 0) {
      const newErrorCount = (token[0].errorCount || 0) + 1;
      
      await db
        .update(zyphraTokens)
        .set({ errorCount: newErrorCount })
        .where(eq(zyphraTokens.id, tokenId));
      
      console.log(`[Zyphra] Token ${tokenId.slice(0, 8)} error count: ${newErrorCount}/${MAX_ERROR_COUNT}`);
      
      // Auto-disable if error limit reached
      if (newErrorCount >= MAX_ERROR_COUNT) {
        console.log(`[Zyphra] Token ${tokenId.slice(0, 8)} reached error limit. Auto-disabling...`);
        await db
          .update(zyphraTokens)
          .set({ isActive: false })
          .where(eq(zyphraTokens.id, tokenId));
      }
    }
  } catch (error) {
    console.error("Error incrementing token error count:", error);
  }
}

/**
 * Calculate dynamic timeout based on text length
 * < 100 chars: 10 seconds
 * 100-300 chars: 15 seconds
 * 300-1000 chars: 25 seconds
 * 1000-3000 chars: 50 seconds
 * 3000-5000 chars: 100 seconds
 * 5000-10000 chars: 150 seconds
 * > 10000 chars: 150 seconds (max)
 */
function calculateTimeout(textLength: number): number {
  if (textLength < 100) return 10000;
  if (textLength <= 300) return 15000;
  if (textLength <= 1000) return 25000;
  if (textLength <= 3000) return 50000;
  if (textLength <= 5000) return 100000;
  return 150000;
}

/**
 * Generate speech from text using Zyphra API
 * @param request - TTS request parameters
 * @param excludeTokenIds - Optional array of token IDs to exclude (for retry logic)
 */
export async function generateSpeech(request: ZyphraTextToSpeechRequest, excludeTokenIds: string[] = []): Promise<ZyphraResponse> {
  const token = await getAvailableZyphraToken(excludeTokenIds);
  
  if (!token) {
    return {
      success: false,
      error: "Voice generation service unavailable. Please try again later.",
    };
  }

  try {
    const requestBody: Record<string, any> = {
      text: request.text,
      speaking_rate: request.speakingRate || 15,
      model: request.model || "zonos-v0.1-transformer",
    };

    if (request.languageIsoCode) {
      requestBody.language_iso_code = request.languageIsoCode;
    }

    if (request.mimeType) {
      requestBody.mime_type = request.mimeType;
    }

    if (request.speakerAudio) {
      requestBody.speaker_audio = request.speakerAudio;
    }

    if (request.emotion && request.model !== "zonos-v0.1-hybrid") {
      requestBody.emotion = request.emotion;
    }

    if (request.pitchStd !== undefined && request.model !== "zonos-v0.1-hybrid") {
      requestBody.pitchStd = request.pitchStd;
    }

    if (request.speakerNoised !== undefined && request.model === "zonos-v0.1-hybrid") {
      requestBody.speaker_noised = request.speakerNoised;
    }

    if (request.defaultVoiceName) {
      requestBody.default_voice_name = request.defaultVoiceName;
    }

    // Calculate dynamic timeout based on text length
    const timeout = calculateTimeout(request.text.length);
    console.log(`[Zyphra] Generating speech with token ${token.id.slice(0, 8)} (${request.text.length} chars, ${timeout/1000}s timeout)...`);

    // Create AbortController with dynamic timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(ZYPHRA_API_URL, {
        method: "POST",
        headers: {
          "X-API-Key": token.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Zyphra] API Error: ${response.status} - ${errorText}`);
      // Increment error count for this token
      await incrementTokenError(token.id);
      return {
        success: false,
        error: `Voice generation failed. Please try again.`,
        tokenId: token.id,
      };
    }

    const audioBuffer = await response.arrayBuffer();
    const audioData = Buffer.from(audioBuffer);
    const mimeType = request.mimeType || "audio/webm";
    
    // Update token usage with character count only
    const textCharacters = request.text.length;
    await updateTokenUsage(token.id, textCharacters);

    console.log(`[Zyphra] Speech generated successfully (${textCharacters} chars)`);

    return {
      success: true,
      audioData,
      mimeType,
      tokenId: token.id,
      charactersUsed: textCharacters,
    };
  } catch (error: any) {
    // Handle timeout/abort specifically
    if (error.name === 'AbortError') {
      const timeout = calculateTimeout(request.text.length);
      console.error(`[Zyphra] Request timed out after ${timeout/1000} seconds`);
      return {
        success: false,
        error: "Voice generation timed out. Please try again.",
        tokenId: token.id,
      };
    }
    
    console.error("[Zyphra] Error generating speech:", error);
    // Increment error count for this token
    await incrementTokenError(token.id);
    return {
      success: false,
      error: error.message || "Failed to generate speech",
      tokenId: token.id,
    };
  }
}

const MAX_SILENT_RETRIES = 6; // Silent retries before showing error to user

/**
 * Generate speech with silent retry mechanism
 * Retries up to 6 times silently before showing error to user
 * Each retry excludes previously failing tokens to try different API keys
 */
export async function generateSpeechWithRetry(request: ZyphraTextToSpeechRequest): Promise<ZyphraResponse> {
  let lastError: string | undefined;
  const failedTokenIds: string[] = [];
  
  for (let attempt = 1; attempt <= MAX_SILENT_RETRIES; attempt++) {
    console.log(`[Zyphra] TTS attempt ${attempt}/${MAX_SILENT_RETRIES}${failedTokenIds.length > 0 ? ` (excluding ${failedTokenIds.length} previously failed tokens)` : ''}...`);
    
    const result = await generateSpeech(request, failedTokenIds);
    
    if (result.success) {
      if (attempt > 1) {
        console.log(`[Zyphra] TTS succeeded on attempt ${attempt}`);
      }
      return result;
    }
    
    // Track the failed token to try a different one on next attempt
    if (result.tokenId && !failedTokenIds.includes(result.tokenId)) {
      failedTokenIds.push(result.tokenId);
      console.log(`[Zyphra] Token ${result.tokenId.slice(0, 8)} failed, will try different token on next attempt`);
    }
    
    // Store the error for potential display on final failure
    lastError = result.error;
    
    if (attempt < MAX_SILENT_RETRIES) {
      // Silent retry - don't expose error to user yet
      console.log(`[Zyphra] TTS attempt ${attempt} failed silently, retrying... Error: ${result.error}`);
      // Small delay between retries (500ms)
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      // Final attempt failed - now show error to user
      console.error(`[Zyphra] TTS failed after ${MAX_SILENT_RETRIES} attempts. Final error: ${result.error}`);
    }
  }
  
  // All retries exhausted - return the error
  return {
    success: false,
    error: lastError || "Voice generation failed after multiple attempts. Please try again.",
  };
}

/**
 * Voice cloning with silent retry mechanism
 * Retries up to 3 times silently before showing error to user
 */
export async function cloneVoiceWithRetry(
  text: string,
  referenceAudioBase64: string,
  options?: {
    speakingRate?: number;
    languageIsoCode?: string;
    mimeType?: "audio/webm" | "audio/mp3" | "audio/wav" | "audio/ogg";
    model?: "zonos-v0.1-transformer" | "zonos-v0.1-hybrid";
  }
): Promise<ZyphraResponse> {
  return generateSpeechWithRetry({
    text,
    speakerAudio: referenceAudioBase64,
    speakingRate: options?.speakingRate || 15,
    languageIsoCode: options?.languageIsoCode,
    mimeType: options?.mimeType || "audio/mp3",
    model: options?.model || "zonos-v0.1-transformer",
  });
}

/**
 * Voice cloning - generate speech with a cloned voice
 */
export async function cloneVoice(
  text: string,
  referenceAudioBase64: string,
  options?: {
    speakingRate?: number;
    languageIsoCode?: string;
    mimeType?: "audio/webm" | "audio/mp3" | "audio/wav" | "audio/ogg";
    model?: "zonos-v0.1-transformer" | "zonos-v0.1-hybrid";
  }
): Promise<ZyphraResponse> {
  return generateSpeech({
    text,
    speakerAudio: referenceAudioBase64,
    speakingRate: options?.speakingRate || 15,
    languageIsoCode: options?.languageIsoCode,
    mimeType: options?.mimeType || "audio/mp3",
    model: options?.model || "zonos-v0.1-transformer",
  });
}

/**
 * Get all Zyphra tokens with usage stats
 */
export async function getAllZyphraTokens() {
  return db.select().from(zyphraTokens);
}

/**
 * Add a new Zyphra API key
 */
export async function addZyphraToken(apiKey: string, label: string, minutesLimit: number = 100) {
  return db.insert(zyphraTokens).values({
    apiKey,
    label,
    minutesLimit,
  }).returning();
}

/**
 * Delete a Zyphra token
 */
export async function deleteZyphraToken(id: string) {
  return db.delete(zyphraTokens).where(eq(zyphraTokens.id, id));
}

/**
 * Delete all Zyphra tokens
 */
export async function deleteAllZyphraTokens() {
  return db.delete(zyphraTokens);
}

/**
 * Update Zyphra token
 */
export async function updateZyphraToken(id: string, updates: {
  label?: string;
  isActive?: boolean;
  minutesUsed?: number;
  minutesLimit?: number;
  charactersUsed?: number;
  charactersLimit?: number;
  errorCount?: number;
}) {
  return db.update(zyphraTokens).set(updates).where(eq(zyphraTokens.id, id)).returning();
}

/**
 * Reset all token usage (for monthly reset) - includes characters and errors
 */
export async function resetAllTokenUsage() {
  return db.update(zyphraTokens).set({ 
    minutesUsed: 0,
    charactersUsed: 0,
    errorCount: 0,
    isActive: true
  });
}

/**
 * Reset individual token usage - includes characters and errors
 */
export async function resetTokenUsage(id: string) {
  return db.update(zyphraTokens).set({ 
    minutesUsed: 0,
    charactersUsed: 0,
    errorCount: 0,
    isActive: true
  }).where(eq(zyphraTokens.id, id));
}

/**
 * Get Zyphra token stats (active vs disabled counts)
 */
export async function getZyphraTokenStats() {
  const allTokens = await db.select().from(zyphraTokens);
  const activeCount = allTokens.filter(t => t.isActive).length;
  const disabledCount = allTokens.filter(t => !t.isActive).length;
  const totalCharactersUsed = allTokens.reduce((sum, t) => sum + (t.charactersUsed || 0), 0);
  const totalErrors = allTokens.reduce((sum, t) => sum + (t.errorCount || 0), 0);
  
  return {
    total: allTokens.length,
    active: activeCount,
    disabled: disabledCount,
    totalCharactersUsed,
    totalErrors
  };
}

/**
 * Available default voices
 */
export const DEFAULT_VOICES = [
  { name: "american_female", description: "Standard American English female voice" },
  { name: "american_male", description: "Standard American English male voice" },
  { name: "anime_girl", description: "Stylized anime girl character voice" },
  { name: "british_female", description: "British English female voice" },
  { name: "british_male", description: "British English male voice" },
  { name: "energetic_boy", description: "Energetic young male voice" },
  { name: "energetic_girl", description: "Energetic young female voice" },
  { name: "japanese_female", description: "Japanese female voice" },
  { name: "japanese_male", description: "Japanese male voice" },
];

/**
 * Supported languages
 */
export const SUPPORTED_LANGUAGES = [
  { code: "en-us", name: "English (US)" },
  { code: "fr-fr", name: "French" },
  { code: "de", name: "German" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "cmn", name: "Mandarin Chinese" },
];
