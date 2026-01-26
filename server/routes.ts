import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import sharp from "sharp";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { storage } from "./storage";
import { db } from "./db";
import { 
  loginSchema, 
  insertUserSchema, 
  updateUserPlanSchema, 
  updateUserApiTokenSchema, 
  insertApiTokenSchema,
  bulkReplaceTokensSchema,
  updateTokenSettingsSchema,
  videoHistory,
  users,
  type VideoHistory
} from "@shared/schema";
import { generateScript } from "./openai-script";
import { checkVideoStatus, waitForVideoCompletion, waitForVideoCompletionWithUpdates } from "./veo3";
import { startBackgroundVideoGeneration, getJobStatus, getVideoBuffer } from "./backgroundVideoGen";
import { getVideoBufferFromBulk, getGlobalStats, getUploadQueueStats, addToFlowQueue } from "./bulkQueueFlow";
// Cloudinary imports for video upload
import { uploadBase64VideoWithFallback } from "./cloudinary";
import { mergeVideosWithFalAI } from "./falai";
import { z } from "zod";
import { desc, asc, sql, eq, and, or, inArray } from "drizzle-orm";
import path from "path";
import { existsSync, createReadStream } from "fs";
import { rm } from "fs/promises";
import archiver from "archiver";
import https from "https";
import http from "http";
import { 
  canGenerateVideo, 
  canBulkGenerate, 
  canAccessTool, 
  getBatchConfig,
  canUseVoiceCharacters,
  getVoiceCharacterUsage,
  getPerRequestCharLimit,
  isPlanExpired,
} from "./planEnforcement";
import { stopAllProcessing } from "./bulkQueue";

// Keep-alive agents for faster parallel downloads (reuse TCP connections)
const httpAgent = new http.Agent({ 
  keepAlive: true, 
  maxSockets: 50, // Increased for 100 users
  keepAliveMsecs: 30000
});
const httpsAgent = new https.Agent({ 
  keepAlive: true, 
  maxSockets: 50, // Increased for 100 users
  keepAliveMsecs: 30000
});

// Global concurrency control for ZIP downloads (prevents server overload)
let activeZipDownloads = 0;
const MAX_CONCURRENT_ZIP_DOWNLOADS = 3; // REDUCED: Max 3 simultaneous ZIP downloads to save bandwidth

// Temporary audio cache for Zyphra TTS (auto-expires after 5 minutes)
// Includes userId for ownership validation
const audioCache = new Map<string, { buffer: Buffer; mimeType: string; timestamp: number; userId: string }>();
const AUDIO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cleanup expired audio cache entries
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(audioCache.entries());
  for (const [id, entry] of entries) {
    if (now - entry.timestamp > AUDIO_CACHE_TTL) {
      audioCache.delete(id);
    }
  }
}, 60000); // Every minute

// Cloudinary is now only used for merge operations (not video generation)

// ==================== SECURITY MIDDLEWARE ====================

// User cache to reduce DB calls on every request (30 second TTL)
const userCache = new Map<string, { user: any; timestamp: number }>();
const USER_CACHE_TTL = 30000; // 30 seconds

// Clear stale user cache entries periodically
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(userCache.entries());
  for (const [userId, entry] of entries) {
    if (now - entry.timestamp > USER_CACHE_TTL * 2) {
      userCache.delete(userId);
    }
  }
}, 60000); // Every minute

// Helper to get user with caching
async function getCachedUser(userId: string): Promise<any> {
  const cached = userCache.get(userId);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < USER_CACHE_TTL) {
    return cached.user;
  }
  
  const user = await storage.getUser(userId);
  if (user) {
    userCache.set(userId, { user, timestamp: now });
  }
  return user;
}

// Invalidate user cache (call after user updates)
export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

// Authentication middleware - validates session exists and user is real
const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  // Security: Check if session exists
  if (!req.session || !req.session.userId) {
    console.log(`[Security] Unauthorized access attempt to ${req.path} - no session`);
    return res.status(401).json({ error: "Authentication required" });
  }
  
  // Security: Validate user still exists and is active in database (with cache)
  const user = await getCachedUser(req.session.userId);
  if (!user) {
    console.log(`[Security] Invalid session - user not found: ${req.session.userId}`);
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Session expired" });
  }
  
  if (!user.isAccountActive) {
    console.log(`[Security] Blocked inactive user: ${user.username}`);
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Account deactivated" });
  }
  
  next();
};

// Admin middleware - STRICT server-side admin validation (cannot be bypassed via dev tools)
const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  // Security: Check session first
  if (!req.session || !req.session.userId) {
    console.log(`[Security] Admin access denied - no session: ${req.path}`);
    return res.status(401).json({ error: "Authentication required" });
  }

  // Security: Verify admin status from DATABASE (with cache for performance)
  const user = await getCachedUser(req.session.userId);
  
  // User must exist
  if (!user) {
    console.log(`[Security] Admin access denied - invalid user: ${req.session.userId}`);
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Session expired" });
  }
  
  // User must be active
  if (!user.isAccountActive) {
    console.log(`[Security] Admin access denied - inactive account: ${user.username}`);
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Account deactivated" });
  }
  
  // User must have admin flag in database (THIS CANNOT BE FAKED VIA DEV TOOLS)
  if (!user.isAdmin) {
    // Log potential hacking attempt
    console.warn(`[SECURITY ALERT] Non-admin user attempted admin access: ${user.username} at ${req.path}`);
    return res.status(403).json({ error: "Access denied" });
  }
  
  // Log admin actions for audit trail
  console.log(`[Admin] ${user.username} accessed: ${req.method} ${req.path}`);
  
  next();
};

// ==================== END SECURITY MIDDLEWARE ====================

// Helper function to check if error is an authentication error
function isAuthenticationError(error: any): boolean {
  const errorMessage = error?.message || error?.toString() || '';
  const authErrorPatterns = [
    'invalid authentication',
    'authentication credentials',
    'OAuth 2 access token',
    'authentication credential',
    'invalid credentials',
    'unauthorized',
    '401',
    'authentication failed'
  ];
  
  return authErrorPatterns.some(pattern => 
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

// Helper function to handle token errors and auto-disable on auth errors
async function handleTokenError(tokenId: string | undefined, error: any): Promise<void> {
  if (!tokenId) return;
  
  // Check if this is an authentication error
  if (isAuthenticationError(error)) {
    console.log(`[Auto-Disable] Authentication error detected for token ${tokenId}. Disabling token permanently.`);
    
    // Disable the token permanently
    await storage.toggleApiTokenStatus(tokenId, false);
    
    console.log(`[Auto-Disable] Token ${tokenId} has been disabled due to authentication error: ${error.message || error}`);
  } else {
    // For non-auth errors, just record the error (existing behavior)
    storage.recordTokenError(tokenId);
  }
}

// Helper function to get next token excluding specific IDs
async function getNextTokenExcluding(excludeIds: Set<string>): Promise<Awaited<ReturnType<typeof storage.getNextRotationToken>>> {
  const allTokens = await storage.getActiveApiTokens();
  const availableTokens = allTokens
    .filter(t => !excludeIds.has(t.id) && !storage.isTokenInCooldown(t.id))
    .sort((a, b) => {
      const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return aTime - bTime;
    });
  
  return availableTokens[0];
}

// Helper function to retry VEO video generation with automatic token rotation
async function retryVeoGeneration(
  payload: any,
  maxRetries: number = 20,
  initialToken?: Awaited<ReturnType<typeof storage.getNextRotationToken>>
): Promise<{ success: true; data: any; token: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined } | { success: false; error: string }> {
  let attemptNumber = 0;
  let rotationToken = initialToken;
  let lastError: string = '';
  const disabledTokenIds = new Set<string>(); // Track disabled tokens in this retry session
  
  while (attemptNumber < maxRetries) {
    attemptNumber++;
    
    try {
      console.log(`[VEO Retry] Attempt ${attemptNumber}/${maxRetries}`);
      
      // Get API key - use initial token for first attempt, then rotate
      let apiKey: string | undefined;
      
      // First attempt: use initialToken if provided and not disabled
      if (attemptNumber === 1 && initialToken && !disabledTokenIds.has(initialToken.id)) {
        rotationToken = initialToken;
        apiKey = rotationToken.token;
        console.log(`[VEO Retry] Using INITIAL token: ${rotationToken.label} (ID: ${rotationToken.id}) for attempt ${attemptNumber}`);
        // No need to update usage as it was already updated by the caller
      } else {
        // Subsequent attempts: get next available token, excluding disabled ones
        rotationToken = await getNextTokenExcluding(disabledTokenIds);
        
        if (!rotationToken) {
          // No tokens available after exclusion - abort immediately
          lastError = `No active API tokens available after excluding ${disabledTokenIds.size} disabled tokens. All tokens exhausted.`;
          console.error(`[VEO Retry] ${lastError}`);
          return { success: false, error: lastError };
        }
        
        apiKey = rotationToken.token;
        console.log(`[VEO Retry] Using NEXT token: ${rotationToken.label} (ID: ${rotationToken.id}) for attempt ${attemptNumber}${disabledTokenIds.size > 0 ? ` (excluding ${disabledTokenIds.size} disabled)` : ''}`);
        await storage.updateTokenUsage(rotationToken.id);
      }
      
      // Make the API request with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180000); // 3 minute timeout
      
      const response = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      // Parse JSON response (handle HTML error pages)
      let data;
      try {
        data = await response.json();
      } catch (jsonError) {
        const textResponse = await response.text();
        lastError = `Invalid JSON response from VEO API (got HTML): ${textResponse.substring(0, 200)}`;
        console.error(`[VEO Retry] Attempt ${attemptNumber}:`, lastError);
        
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        if (isAuthenticationError(new Error(lastError))) {
          console.log(`[VEO Retry] Auth error - token ${rotationToken?.id} auto-disabled`);
          if (rotationToken) {
            disabledTokenIds.add(rotationToken.id);
          }
        }
        
        if (attemptNumber < maxRetries) {
          console.log(`[VEO Retry] Retrying in 500ms with different token...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }
      
      // Check for errors
      if (!response.ok) {
        lastError = data.error?.message || `API error (${response.status})`;
        console.error(`[VEO Retry] Attempt ${attemptNumber} failed:`, lastError);
        
        // Handle token error
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        // If authentication error, token was auto-disabled, track it and retry with different token
        if (isAuthenticationError(new Error(lastError))) {
          console.log(`[VEO Retry] Authentication error detected - token ${rotationToken?.id} auto-disabled, retrying with different token...`);
          if (rotationToken) {
            disabledTokenIds.add(rotationToken.id);
            console.log(`[VEO Retry] Added token ${rotationToken.id} to exclusion list. Total excluded: ${disabledTokenIds.size}`);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        // Retry with different token after short delay
        if (attemptNumber < maxRetries) {
          console.log(`[VEO Retry] Retrying in 500ms with different token...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }
      
      // Check if we got operation name
      const operationName = data.operations?.[0]?.operation?.name;
      if (!operationName) {
        lastError = 'No operation name returned from VEO API';
        console.error(`[VEO Retry] Attempt ${attemptNumber} failed:`, lastError);
        
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        // Check if this might be an auth issue
        if (isAuthenticationError(new Error(lastError))) {
          if (rotationToken) {
            disabledTokenIds.add(rotationToken.id);
            console.log(`[VEO Retry] Added token ${rotationToken.id} to exclusion list. Total excluded: ${disabledTokenIds.size}`);
          }
        }
        
        if (attemptNumber < maxRetries) {
          console.log(`[VEO Retry] Retrying in 500ms with different token...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }
      
      // SUCCESS!
      console.log(`[VEO Retry] ✅ SUCCESS on attempt ${attemptNumber}`);
      return { success: true, data, token: rotationToken };
      
    } catch (error: any) {
      lastError = error.message || String(error);
      console.error(`[VEO Retry] Attempt ${attemptNumber} error:`, error);
      
      // Handle token error
      await handleTokenError(rotationToken?.id, error);
      
      // If authentication error, track disabled token
      if (isAuthenticationError(error)) {
        if (rotationToken) {
          disabledTokenIds.add(rotationToken.id);
          console.log(`[VEO Retry] Added token ${rotationToken.id} to exclusion list. Total excluded: ${disabledTokenIds.size}`);
        }
      }
      
      // Retry with different token after short delay
      if (attemptNumber < maxRetries) {
        console.log(`[VEO Retry] Retrying in 500ms with different token...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      
      // Check if we've exhausted all tokens
      if (!rotationToken && !process.env.VEO3_API_KEY) {
        return { success: false, error: `No active API tokens available - all tokens may be disabled (Failed after ${maxRetries} attempts)` };
      }
      
      return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
    }
  }
  
  // Final check if we've exhausted all attempts
  if (!rotationToken && !process.env.VEO3_API_KEY) {
    return { success: false, error: `No active API tokens available - all tokens may be disabled (Failed after ${maxRetries} attempts)` };
  }
  
  return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
}

// ==================== MEDIA FLOW HELPER (Image → Video) - SAME AS CHARACTER/BULK ====================
// This uses Imagen to generate image first, then converts to video - WORKS reliably
const MEDIA_API_URL_GLOBAL = 'https://aisandbox-pa.googleapis.com/v1';

async function retryMediaVeoGeneration(
  prompt: string,
  aspectRatio: string,
  maxRetries: number = 20,
  initialToken?: Awaited<ReturnType<typeof storage.getNextRotationToken>>
): Promise<{ success: true; operationName: string; sceneId: string; token: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined } | { success: false; error: string }> {
  let attemptNumber = 0;
  let rotationToken = initialToken;
  let lastError: string = '';
  const disabledTokenIds = new Set<string>();
  const seed = Math.floor(Math.random() * 100000);
  const sceneId = `single-media-${Date.now()}`;
  
  while (attemptNumber < maxRetries) {
    attemptNumber++;
    
    try {
      console.log(`[MediaGen VEO] Attempt ${attemptNumber}/${maxRetries}`);
      
      // Get API key - use initial token for first attempt, then rotate
      let apiKey: string | undefined;
      
      if (attemptNumber === 1 && initialToken && !disabledTokenIds.has(initialToken.id)) {
        rotationToken = initialToken;
        apiKey = rotationToken.token;
        console.log(`[MediaGen VEO] Using INITIAL token: ${rotationToken.label}`);
      } else {
        rotationToken = await getNextTokenExcluding(disabledTokenIds);
        
        if (!rotationToken) {
          lastError = `No active API tokens available after excluding ${disabledTokenIds.size} disabled tokens.`;
          console.error(`[MediaGen VEO] ${lastError}`);
          return { success: false, error: lastError };
        }
        
        apiKey = rotationToken.token;
        console.log(`[MediaGen VEO] Using NEXT token: ${rotationToken.label}`);
        await storage.updateTokenUsage(rotationToken.id);
      }
      
      // STEP 1: Generate image using Media API (Imagen 3.5)
      console.log(`[MediaGen VEO] Step 1: Generating image...`);
      const workflowId = crypto.randomUUID();
      const sessionId = `;${Date.now()}`;
      
      const imageAspectRatio = aspectRatio === 'portrait' || aspectRatio === '9:16'
        ? 'IMAGE_ASPECT_RATIO_PORTRAIT' 
        : 'IMAGE_ASPECT_RATIO_LANDSCAPE';

      const imageRequestBody = {
        clientContext: {
          workflowId: workflowId,
          tool: "BACKBONE",
          sessionId: sessionId
        },
        imageModelSettings: {
          imageModel: "IMAGEN_3_5",
          aspectRatio: imageAspectRatio
        },
        seed: seed + attemptNumber - 1,
        prompt: prompt,
        mediaCategory: "MEDIA_CATEGORY_BOARD"
      };

      const imageResponse = await fetch(`${MEDIA_API_URL_GLOBAL}/whisk:generateImage`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(imageRequestBody),
      });

      if (!imageResponse.ok) {
        const errorText = await imageResponse.text();
        lastError = `Video generation failed: ${imageResponse.status} - ${errorText.substring(0, 200)}`;
        console.error(`[MediaGen VEO] ${lastError}`);
        
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        if (isAuthenticationError(new Error(lastError))) {
          if (rotationToken) disabledTokenIds.add(rotationToken.id);
        }
        
        if (attemptNumber < maxRetries) {
          console.log(`[MediaGen VEO] Retrying in 500ms with different token...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }

      const imageData = await imageResponse.json();
      
      if (!imageData.imagePanels || imageData.imagePanels.length === 0 || 
          !imageData.imagePanels[0].generatedImages || imageData.imagePanels[0].generatedImages.length === 0) {
        lastError = 'No image generated from Media API';
        console.error(`[MediaGen VEO] ${lastError}`);
        if (attemptNumber < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        return { success: false, error: lastError };
      }

      const generatedImage = imageData.imagePanels[0].generatedImages[0];
      const encodedImage = generatedImage.encodedImage;
      const mediaGenerationId = generatedImage.mediaGenerationId;
      const finalWorkflowId = imageData.workflowId || workflowId;
      
      console.log(`[MediaGen VEO] Image generated successfully. Starting video...`);
      
      // STEP 2: Generate video from image using Media API
      const videoSessionId = `;${Date.now()}`;
      const videoRequestBody = {
        clientContext: {
          sessionId: videoSessionId,
          tool: "BACKBONE",
          workflowId: finalWorkflowId
        },
        promptImageInput: {
          prompt: prompt,
          rawBytes: encodedImage,
          mediaGenerationId: mediaGenerationId
        },
        modelNameType: "VEO_3_1_I2V_12STEP",
        modelKey: "",
        userInstructions: prompt,
        loopVideo: false
      };

      const videoResponse = await fetch(`${MEDIA_API_URL_GLOBAL}/whisk:generateVideo`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(videoRequestBody),
      });

      if (!videoResponse.ok) {
        const errorText = await videoResponse.text();
        lastError = `Video generation start failed: ${videoResponse.status} - ${errorText.substring(0, 200)}`;
        console.error(`[MediaGen VEO] ${lastError}`);
        
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        if (isAuthenticationError(new Error(lastError))) {
          if (rotationToken) disabledTokenIds.add(rotationToken.id);
        }
        
        if (attemptNumber < maxRetries) {
          console.log(`[MediaGen VEO] Retrying in 500ms with different token...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }

      const videoData = await videoResponse.json();
      
      if (!videoData.operation?.operation?.name) {
        lastError = 'No operation name returned from video generation';
        console.error(`[MediaGen VEO] ${lastError}`);
        if (attemptNumber < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        return { success: false, error: lastError };
      }

      const operationName = videoData.operation.operation.name;
      console.log(`[MediaGen VEO] ✅ SUCCESS on attempt ${attemptNumber}. Operation: ${operationName}`);
      return { success: true, operationName, sceneId, token: rotationToken };
      
    } catch (error: any) {
      lastError = error.message || String(error);
      console.error(`[MediaGen VEO] Attempt ${attemptNumber} error:`, lastError);
      
      await handleTokenError(rotationToken?.id, error);
      
      if (isAuthenticationError(error)) {
        if (rotationToken) disabledTokenIds.add(rotationToken.id);
      }
      
      if (attemptNumber < maxRetries) {
        console.log(`[MediaGen VEO] Retrying in 500ms with different token...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      
      return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
    }
  }
  
  return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
}

// Helper function to retry Image-to-Video generation with automatic token rotation
async function retryImageToVideoGeneration(
  imageBase64: string,
  mimeType: string,
  videoPayload: any,
  maxRetries: number = 20,
  initialToken?: Awaited<ReturnType<typeof storage.getNextRotationToken>>
): Promise<{ success: true; data: any; mediaGenId: string; token: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined } | { success: false; error: string }> {
  let attemptNumber = 0;
  let rotationToken = initialToken;
  let lastError: string = '';
  const disabledTokenIds = new Set<string>();
  
  while (attemptNumber < maxRetries) {
    attemptNumber++;
    
    try {
      console.log(`[Image-to-Video Retry] Attempt ${attemptNumber}/${maxRetries}`);
      
      // Get API key - use initial token for first attempt, then rotate
      let apiKey: string | undefined;
      
      if (attemptNumber === 1 && initialToken && !disabledTokenIds.has(initialToken.id)) {
        rotationToken = initialToken;
        apiKey = rotationToken.token;
        console.log(`[Image-to-Video Retry] Using INITIAL token: ${rotationToken.label} (ID: ${rotationToken.id})`);
      } else {
        rotationToken = await getNextTokenExcluding(disabledTokenIds);
        
        if (!rotationToken) {
          lastError = `No active API tokens available after excluding ${disabledTokenIds.size} disabled tokens.`;
          console.error(`[Image-to-Video Retry] ${lastError}`);
          return { success: false, error: lastError };
        }
        
        apiKey = rotationToken.token;
        console.log(`[Image-to-Video Retry] Using NEXT token: ${rotationToken.label} (ID: ${rotationToken.id})${disabledTokenIds.size > 0 ? ` (excluding ${disabledTokenIds.size} disabled)` : ''}`);
        await storage.updateTokenUsage(rotationToken.id);
      }
      
      // Simple flow - NO UPLOAD - direct whisk:generateVideo with rawBytes (same as retryMediaVeoGeneration)
      console.log(`[Image-to-Video Retry] Generating video via whisk:generateVideo (no upload, direct rawBytes)...`);
      
      // Use the same pattern as retryMediaVeoGeneration - promptImageInput with rawBytes
      const prompt = videoPayload.requests?.[0]?.textInput?.prompt || videoPayload.prompt || "";
      const workflowId = crypto.randomUUID();
      const videoSessionId = `;${Date.now()}`;
      
      // Direct video generation with image as rawBytes (exactly like bulk flow)
      // API expects RAW base64 without data: prefix
      const rawBytes = imageBase64.startsWith('data:') 
        ? imageBase64.split(',')[1] 
        : imageBase64;
      
      const whiskVideoPayload = {
        clientContext: {
          sessionId: videoSessionId,
          tool: "BACKBONE",
          workflowId: workflowId
        },
        promptImageInput: {
          prompt: prompt,
          rawBytes: rawBytes
        },
        modelNameType: "VEO_3_1_I2V_12STEP",
        modelKey: "",
        userInstructions: prompt,
        loopVideo: false
      };
      
      console.log(`[Image-to-Video Retry] rawBytes format: raw base64 (${rawBytes.length} chars)`);
      
      console.log(`[Image-to-Video Retry] Prompt: "${prompt.substring(0, 100)}..."`);
      console.log(`[Image-to-Video Retry] Image size: ${imageBase64.length} chars`);
      
      const videoController = new AbortController();
      const videoTimeout = setTimeout(() => videoController.abort(), 180000); // 3 minute timeout
      
      const videoResponse = await fetch('https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(whiskVideoPayload),
        signal: videoController.signal,
      });
      
      clearTimeout(videoTimeout);
      
      // Parse JSON response (handle HTML error pages)
      let videoData;
      const videoResponseText = await videoResponse.text();
      try {
        videoData = JSON.parse(videoResponseText);
      } catch (jsonError) {
        // Check if response is HTML (rate limit or error page)
        const isHtmlError = videoResponseText.trim().startsWith('<') || videoResponseText.includes('<html');
        lastError = isHtmlError 
          ? `API returned HTML error page during video generation. Token may be rate limited.`
          : `Invalid JSON response from video API: ${videoResponseText.substring(0, 200)}`;
        console.error(`[Image-to-Video Retry] Attempt ${attemptNumber}:`, lastError);
        console.error(`[Image-to-Video Retry] Raw response:`, videoResponseText.substring(0, 500));
        
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        // For HTML errors, always try a different token
        if (isHtmlError && rotationToken) {
          console.log(`[Image-to-Video Retry] HTML error - disabling token ${rotationToken.label} and trying another`);
          disabledTokenIds.add(rotationToken.id);
        }
        
        if (attemptNumber < maxRetries) {
          console.log(`[Image-to-Video Retry] Retrying in 1s with different token...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }
      
      if (!videoResponse.ok) {
        lastError = videoData.error?.message || `Video generation failed (${videoResponse.status})`;
        console.error(`[Image-to-Video Retry] Attempt ${attemptNumber}:`, lastError);
        
        await handleTokenError(rotationToken?.id, new Error(lastError));
        
        if (isAuthenticationError(new Error(lastError))) {
          if (rotationToken) {
            disabledTokenIds.add(rotationToken.id);
          }
        }
        
        if (attemptNumber < maxRetries) {
          console.log(`[Image-to-Video Retry] Retrying in 500ms with different token...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }
      
      // Whisk response format: { operation: { operation: { name: "..." }, sceneId: "" } }
      const operationName = videoData.operation?.operation?.name || videoData.operations?.[0]?.operation?.name;
      const sceneId = videoData.operation?.sceneId || videoData.operations?.[0]?.sceneId || workflowId;
      
      if (!operationName) {
        lastError = 'No operation name returned from Whisk API';
        console.error(`[Image-to-Video Retry] Attempt ${attemptNumber}:`, lastError);
        console.log(`[Image-to-Video Retry] Response structure:`, JSON.stringify(videoData).substring(0, 500));
        
        if (attemptNumber < maxRetries) {
          console.log(`[Image-to-Video Retry] Retrying in 500ms...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
      }
      
      // SUCCESS! Add sceneId to the response
      console.log(`[Image-to-Video Retry] ✅ SUCCESS on attempt ${attemptNumber}. Operation: ${operationName}, SceneId: ${sceneId}`);
      return { success: true, data: { ...videoData, operationName, sceneId, operations: [{ operation: { name: operationName }, sceneId }] }, mediaGenId: workflowId, token: rotationToken };
      
    } catch (error: any) {
      lastError = error.message || String(error);
      console.error(`[Image-to-Video Retry] Attempt ${attemptNumber} error:`, error);
      
      await handleTokenError(rotationToken?.id, error);
      
      if (isAuthenticationError(error)) {
        if (rotationToken) {
          disabledTokenIds.add(rotationToken.id);
        }
      }
      
      if (attemptNumber < maxRetries) {
        console.log(`[Image-to-Video Retry] Retrying in 500ms with different token...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      
      // Check if we've exhausted all tokens
      if (!rotationToken && !process.env.VEO3_API_KEY) {
        return { success: false, error: `No active API tokens available - all tokens may be disabled (Failed after ${maxRetries} attempts)` };
      }
      
      return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
    }
  }
  
  // Final check if we've exhausted all attempts
  if (!rotationToken && !process.env.VEO3_API_KEY) {
    return { success: false, error: `No active API tokens available - all tokens may be disabled (Failed after ${maxRetries} attempts)` };
  }
  
  return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
}

// Helper function to retry Text-to-Image generation with automatic token rotation
// Silent retries - only logs final result or error
async function retryTextToImageGeneration(
  prompt: string,
  aspectRatio: string,
  previousScenePrompt: string | undefined,
  model: "imagen" | "nanoBana" | "nanoBanaPro" | "imagen4",
  generateWithMediaGen: (apiKey: string, prompt: string, aspectRatio: string, previousScenePrompt?: string, referenceMediaIds?: string[]) => Promise<string>,
  generateWithGemPix: (apiKey: string, prompt: string, aspectRatio: string, previousScenePrompt?: string, referenceMediaIds?: string[]) => Promise<string>,
  generateWithGemPixPro: (apiKey: string, prompt: string, aspectRatio: string, previousScenePrompt?: string, referenceMediaIds?: string[]) => Promise<string>,
  generateWithFalAI: (apiKey: string, prompt: string, aspectRatio: string, previousScenePrompt?: string, referenceMediaIds?: string[]) => Promise<string>,
  maxRetries: number = 20,
  initialToken?: Awaited<ReturnType<typeof storage.getNextRotationToken>>,
  referenceMediaIds?: string[],
  silentMode: boolean = false // When true, no logging until final result
): Promise<{ success: true; base64Image: string; token: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined } | { success: false; error: string }> {
  let attemptNumber = 0;
  let rotationToken = initialToken;
  let lastError: string = '';
  const disabledTokenIds = new Set<string>();
  
  while (attemptNumber < maxRetries) {
    attemptNumber++;
    
    try {
      if (!silentMode) {
        console.log(`[Text-to-Image Retry] Attempt ${attemptNumber}/${maxRetries}`);
      }
      
      // Get API key - use initial token for first attempt, then rotate
      // CRITICAL: If referenceMediaIds is provided, we MUST use the same token for ALL attempts
      // because media IDs only work with the token that created them!
      let apiKey: string | undefined;
      
      if (referenceMediaIds && referenceMediaIds.length > 0 && initialToken) {
        // MUST use same token for all attempts when referenceMediaIds is provided
        // because media IDs only work with the token that created them!
        // Limit to 3 retries with same token - if fails, frontend should generate new mediaIds with new token
        if (attemptNumber > 3) {
          if (!silentMode) console.log(`[Text-to-Image Retry] referenceMediaIds requires same token - returning to frontend after 3 attempts`);
          return { success: false, error: `Failed after 3 attempts with same token (referenceMediaIds requires matching token). Frontend should retry with new mediaIds.` };
        }
        rotationToken = initialToken;
        apiKey = rotationToken.token;
        if (!silentMode) console.log(`[Text-to-Image Retry] Using SAME token (required for ${referenceMediaIds.length} referenceMediaIds): ${rotationToken.label} (ID: ${rotationToken.id}) - attempt ${attemptNumber}/3`);
      } else if (attemptNumber === 1 && initialToken && !disabledTokenIds.has(initialToken.id)) {
        rotationToken = initialToken;
        apiKey = rotationToken.token;
        if (!silentMode) console.log(`[Text-to-Image Retry] Using INITIAL token: ${rotationToken.label} (ID: ${rotationToken.id})`);
      } else {
        rotationToken = await getNextTokenExcluding(disabledTokenIds);
        
        if (!rotationToken) {
          // Try fallback to environment variable
          apiKey = process.env.GOOGLE_AI_API_KEY;
          if (!apiKey) {
            lastError = `No active API tokens available after excluding ${disabledTokenIds.size} disabled tokens.`;
            if (!silentMode) console.error(`[Text-to-Image Retry] ${lastError}`);
            return { success: false, error: lastError };
          }
          if (!silentMode) console.log('[Text-to-Image Retry] Using environment variable GOOGLE_AI_API_KEY');
        } else {
          apiKey = rotationToken.token;
          if (!silentMode) console.log(`[Text-to-Image Retry] Using NEXT token: ${rotationToken.label} (ID: ${rotationToken.id})${disabledTokenIds.size > 0 ? ` (excluding ${disabledTokenIds.size} disabled)` : ''}`);
          await storage.updateTokenUsage(rotationToken.id);
        }
      }
      
      // Generate image using the appropriate model
      let base64Image: string;
      
      if (model === "nanoBana") {
        base64Image = await generateWithGemPix(apiKey, prompt, aspectRatio, previousScenePrompt, referenceMediaIds);
      } else if (model === "nanoBanaPro") {
        base64Image = await generateWithGemPixPro(apiKey, prompt, aspectRatio, previousScenePrompt, referenceMediaIds);
      } else if (model === "imagen4") {
        base64Image = await generateWithFalAI(apiKey, prompt, aspectRatio, previousScenePrompt, referenceMediaIds);
      } else {
        base64Image = await generateWithMediaGen(apiKey, prompt, aspectRatio, previousScenePrompt, referenceMediaIds);
      }
      
      if (!silentMode) console.log(`[Text-to-Image Retry] Image generated successfully on attempt ${attemptNumber}`);
      return { success: true, base64Image, token: rotationToken };
      
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Only log individual attempt errors if not in silent mode
      if (!silentMode) console.error(`[Text-to-Image Retry] Attempt ${attemptNumber}:`, lastError);
      
      // Handle token errors
      await handleTokenError(rotationToken?.id, error);
      
      // If authentication error, disable this token
      if (isAuthenticationError(error)) {
        if (!silentMode) console.log(`[Text-to-Image Retry] Auth error - token ${rotationToken?.id} auto-disabled`);
        if (rotationToken) {
          disabledTokenIds.add(rotationToken.id);
        }
      }
      
      // Retry with different token after short delay
      if (attemptNumber < maxRetries) {
        if (!silentMode) console.log(`[Text-to-Image Retry] Retrying in 500ms with different token...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      
      // Check if we've exhausted all tokens
      if (!rotationToken && !process.env.GOOGLE_AI_API_KEY) {
        return { success: false, error: `No active API tokens available - all tokens may be disabled (Failed after ${maxRetries} attempts)` };
      }
      
      return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
    }
  }
  
  // Final check if we've exhausted all attempts
  if (!rotationToken && !process.env.GOOGLE_AI_API_KEY) {
    return { success: false, error: `No active API tokens available - all tokens may be disabled (Failed after ${maxRetries} attempts)` };
  }
  
  return { success: false, error: `${lastError} (Failed after ${maxRetries} attempts)` };
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Loader.io verification endpoint
  app.get("/loaderio-34c6b917514b779ecc940b8a20a020fd.txt", (_req, res) => {
    res.type('text/plain');
    res.send('loaderio-34c6b917514b779ecc940b8a20a020fd');
  });

  app.get("/loaderio-34c6b917514b779ecc940b8a20a020fd.html", (_req, res) => {
    res.type('text/html');
    res.send('loaderio-34c6b917514b779ecc940b8a20a020fd');
  });

  app.get("/loaderio-34c6b917514b779ecc940b8a20a020fd/", (_req, res) => {
    res.type('text/plain');
    res.send('loaderio-34c6b917514b779ecc940b8a20a020fd');
  });

  // Helper function to get and normalize client IP
  function getClientIp(req: any): string {
    let ip = '';
    
    // Try to get IP from X-Forwarded-For header (for proxies/load balancers)
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor) {
      // X-Forwarded-For can be a comma-separated list, take the first one
      const ips = xForwardedFor.split(',');
      ip = ips[0].trim();
    } else {
      // Try X-Real-IP header
      const xRealIp = req.headers['x-real-ip'];
      if (xRealIp) {
        ip = xRealIp;
      } else {
        // Fallback to req.ip or remote address
        ip = req.ip || req.connection?.remoteAddress || 'unknown';
      }
    }
    
    // Normalize IP: remove IPv6 brackets and port numbers
    // Examples: [::1]:12345 -> ::1, 127.0.0.1:8080 -> 127.0.0.1
    ip = ip.replace(/^\[/, '').replace(/\]:\d+$/, '').replace(/:\d+$/, '');
    
    // Handle IPv6 mapped IPv4 (::ffff:192.168.1.1 -> 192.168.1.1)
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    
    return ip.trim();
  }

  // Login endpoint
  app.post("/api/login", async (req, res) => {
    try {
      // Security: Add intentional delay to prevent timing attacks
      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
      
      const validationResult = loginSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { username, password } = validationResult.data;
      
      // Security: Sanitize username input (keep original case for matching)
      const sanitizedUsername = username.trim().substring(0, 50);

      const user = await storage.getUserByUsername(sanitizedUsername);
      
      // Debug logging for demo accounts
      if (sanitizedUsername.startsWith('DEMO_')) {
        console.log(`[Demo Login] Attempting login for: ${sanitizedUsername}`);
        console.log(`[Demo Login] User found: ${!!user}`);
        if (user) {
          console.log(`[Demo Login] Password hash starts with: ${user.password.substring(0, 20)}...`);
          console.log(`[Demo Login] isAccountActive: ${user.isAccountActive}`);
        }
      }
      
      // Security: Use same response for user not found vs wrong password (prevents enumeration)
      if (!user) {
        console.log(`[Security] Failed login attempt for non-existent user: ${sanitizedUsername}`);
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const isPasswordValid = await storage.verifyPassword(user, password);
      
      // Debug for demo accounts
      if (sanitizedUsername.startsWith('DEMO_')) {
        console.log(`[Demo Login] Password valid: ${isPasswordValid}`);
        console.log(`[Demo Login] Password provided length: ${password.length}`);
      }
      
      if (!isPasswordValid) {
        console.log(`[Security] Failed login attempt for user: ${sanitizedUsername} - incorrect password`);
        return res.status(401).json({ error: "Invalid username or password" });
      }

      // Check if account is active
      if (!user.isAccountActive) {
        console.log(`[Security] Login blocked - account deactivated: ${sanitizedUsername}`);
        return res.status(403).json({ 
          error: "Account deactivated. Please contact admin." 
        });
      }

      // Get client IP for audit logging
      const clientIp = getClientIp(req);
      
      // Check 2FA for admin users
      if (user.isAdmin) {
        const twoFactorCode = req.body.twoFactorCode;
        
        // If 2FA is enabled, require verification
        if (user.twoFactorEnabled && user.twoFactorSecret) {
          if (!twoFactorCode) {
            console.log(`[Security] 2FA code required for admin: ${sanitizedUsername}`);
            return res.status(200).json({
              requires2FA: true,
              message: "Please enter your 2FA code"
            });
          }
          
          // Verify 2FA code
          const isValid2FA = authenticator.check(twoFactorCode, user.twoFactorSecret);
          if (!isValid2FA) {
            console.log(`[Security] Invalid 2FA code for admin: ${sanitizedUsername}`);
            return res.status(401).json({ error: "Invalid 2FA code" });
          }
          
          console.log(`[Security] 2FA verified for admin: ${sanitizedUsername}`);
        } else {
          // 2FA not set up yet - require setup
          console.log(`[Security] Admin ${sanitizedUsername} needs to setup 2FA`);
          
          // Generate a temporary secret for setup
          const tempSecret = authenticator.generateSecret();
          
          // Store temporarily in session for setup
          req.session.pending2FASetup = {
            userId: user.id,
            secret: tempSecret
          };
          
          await new Promise<void>((resolve, reject) => {
            req.session.save((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          
          // Generate QR code
          const otpauthUrl = authenticator.keyuri(user.username, 'VeoVideoGenerator', tempSecret);
          const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
          
          return res.status(200).json({
            requires2FASetup: true,
            secret: tempSecret,
            qrCode: qrCodeDataUrl,
            message: "Please scan the QR code with your authenticator app and enter the code to complete setup"
          });
        }
      }
      
      console.log(`[Security] Successful login: ${sanitizedUsername} from IP: ${clientIp}`);

      // Security: Regenerate session ID after successful login (prevents session fixation)
      req.session.regenerate((err) => {
        if (err) {
          console.error('[Security] Session regeneration failed:', err);
          return res.status(500).json({ error: "Login failed" });
        }
        
        req.session.userId = user.id;
        
        // Save the session before responding
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error('[Security] Session save failed:', saveErr);
            return res.status(500).json({ error: "Login failed" });
          }
          
          res.json({ 
            success: true,
            user: { 
              id: user.id, 
              username: user.username, 
              isAdmin: user.isAdmin 
            } 
          });
        });
      });
    } catch (error) {
      console.error("Error in /api/login:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Public Registration endpoint - create user with free plan
  app.post("/api/register", async (req, res) => {
    try {
      const { username, password, firstName, lastName, referralCode } = req.body;
      
      // Validate input
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }
      
      if (username.length < 3) {
        return res.status(400).json({ error: "Username must be at least 3 characters" });
      }
      
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }
      
      // Check if username already exists
      const existingUser = await storage.getUserByUsername(username.trim());
      if (existingUser) {
        return res.status(409).json({ error: "Username already exists" });
      }
      
      // Validate referral code if provided
      let referredBy: string | undefined;
      if (referralCode) {
        const referrer = await storage.getUserByUid(referralCode.trim().toUpperCase());
        if (referrer) {
          referredBy = referralCode.trim().toUpperCase();
          console.log(`[Affiliate] New user referred by: ${referrer.username} (${referredBy})`);
        } else {
          console.log(`[Affiliate] Invalid referral code provided: ${referralCode}`);
        }
      }
      
      // Create user with free plan (no access to tools)
      const newUser = await storage.createUser({
        username: username.trim(),
        password,
        isAdmin: false,
        planType: "free",
      });
      
      // Assign a unique UID to the new user
      const uid = await storage.assignUidToUser(newUser.id);
      
      // If referred, save the referral info
      if (referredBy) {
        await db.update(users).set({ referredBy }).where(eq(users.id, newUser.id));
      }
      
      console.log(`[Register] New user created: ${newUser.username} with UID: ${uid}`);
      
      res.json({
        success: true,
        user: {
          id: newUser.id,
          username: newUser.username,
          planType: newUser.planType,
          uid,
        }
      });
    } catch (error) {
      console.error("Error in /api/register:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // ==================== AFFILIATE SYSTEM ENDPOINTS ====================
  
  // Get affiliate settings (public - needed for referral info display)
  app.get("/api/affiliate/settings", async (req, res) => {
    try {
      await storage.initializeAffiliateSettings();
      const settings = await storage.getAffiliateSettings();
      res.json({ settings });
    } catch (error) {
      console.error("Error in GET /api/affiliate/settings:", error);
      res.status(500).json({ error: "Failed to fetch affiliate settings" });
    }
  });
  
  // Update affiliate settings (admin only)
  app.put("/api/affiliate/settings", requireAdmin, async (req, res) => {
    try {
      const { updateAffiliateSettingsSchema } = await import("@shared/schema");
      const validationResult = updateAffiliateSettingsSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Invalid input",
          details: validationResult.error.errors
        });
      }
      
      const updated = await storage.updateAffiliateSettings(validationResult.data);
      res.json({ success: true, settings: updated });
    } catch (error) {
      console.error("Error in PUT /api/affiliate/settings:", error);
      res.status(500).json({ error: "Failed to update affiliate settings" });
    }
  });
  
  // Get current user's affiliate info
  app.get("/api/affiliate/my-info", requireAuth, async (req, res) => {
    try {
      console.log('[Affiliate] Fetching info for user:', req.session.userId);
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        console.log('[Affiliate] User not found:', req.session.userId);
        return res.status(404).json({ error: "User not found" });
      }
      
      // Ensure user has a UID
      let uid = user.uid;
      console.log('[Affiliate] User UID from DB:', uid);
      if (!uid) {
        console.log('[Affiliate] Assigning new UID to user:', user.id);
        uid = await storage.assignUidToUser(user.id);
        console.log('[Affiliate] New UID assigned:', uid);
      }
      
      // Get earnings history
      const earnings = await storage.getUserAffiliateEarnings(user.id);
      
      // Get referred users by plan type
      const referredUsers = await storage.getReferredUsersByPlanType(uid);
      
      console.log('[Affiliate] Returning data - UID:', uid, 'Referrals:', user.totalReferrals, 'Balance:', user.affiliateBalance);
      res.json({
        uid,
        affiliateBalance: user.affiliateBalance,
        totalReferrals: user.totalReferrals,
        earnings,
        referredUsers,
      });
    } catch (error) {
      console.error("Error in GET /api/affiliate/my-info:", error);
      res.status(500).json({ error: "Failed to fetch affiliate info" });
    }
  });
  
  // Admin: Activate user subscription by UID
  app.post("/api/admin/activate-by-uid", requireAdmin, async (req, res) => {
    try {
      const { activateByUidSchema } = await import("@shared/schema");
      const validationResult = activateByUidSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Invalid input",
          details: validationResult.error.errors
        });
      }
      
      const { uid, planType, expiryDays } = validationResult.data;
      
      // Find user by UID
      const user = await storage.getUserByUid(uid.trim().toUpperCase());
      if (!user) {
        return res.status(404).json({ error: "User not found with this UID" });
      }
      
      // Calculate plan dates
      const planStartDate = new Date().toISOString();
      const planExpiry = new Date();
      planExpiry.setDate(planExpiry.getDate() + (expiryDays || (planType === "enterprise" ? 30 : 10)));
      
      // Update user plan
      const updatedUser = await storage.updateUserPlan(user.id, {
        planType,
        planStatus: "active",
        planExpiry: planExpiry.toISOString(),
      });
      
      // Process referral reward if user was referred
      if (user.referredBy && user.planType === "free") {
        await storage.processReferralReward(user.id, planType);
      }
      
      // Invalidate user cache
      invalidateUserCache(user.id);
      
      console.log(`[Admin] Activated ${planType} plan for user: ${user.username} (UID: ${uid})`);
      
      res.json({
        success: true,
        user: {
          id: updatedUser?.id,
          username: updatedUser?.username,
          uid: updatedUser?.uid,
          planType: updatedUser?.planType,
          planExpiry: updatedUser?.planExpiry,
        }
      });
    } catch (error) {
      console.error("Error in POST /api/admin/activate-by-uid:", error);
      res.status(500).json({ error: "Failed to activate subscription" });
    }
  });
  
  // Admin: Get all affiliate earnings for all users
  app.get("/api/admin/affiliate-earnings", requireAdmin, async (req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      
      // Get detailed referral stats for each user
      const usersWithAffiliates = await Promise.all(
        allUsers
          .filter(u => u.totalReferrals > 0 || u.affiliateBalance > 0 || u.uid)
          .map(async (u) => {
            // Get all users referred by this user
            const referredUsers = allUsers.filter(referred => referred.referredBy === u.uid);
            
            // Count how many referrals have paid plans
            const paidReferrals = referredUsers.filter(
              ref => ref.planType === 'scale' || ref.planType === 'empire'
            ).length;
            
            // Get referral details with more information including reward status
            const referralDetails = await Promise.all(referredUsers.map(async (ref) => {
              // Check if reward was already credited for this referred user
              const existingEarnings = await storage.getUserAffiliateEarnings(u.id);
              const rewardCredited = existingEarnings.some(e => e.referredUserId === ref.id);
              
              return {
                id: ref.id,
                username: ref.username,
                uid: ref.uid,
                planType: ref.planType,
                planStatus: ref.planStatus,
                planExpiry: ref.planExpiry,
                hasPaidPlan: ref.planType === 'scale' || ref.planType === 'empire',
                planStartDate: ref.planStartDate,
                rewardCredited: rewardCredited,
              };
            }));
            
            return {
              id: u.id,
              username: u.username,
              uid: u.uid,
              affiliateBalance: u.affiliateBalance,
              totalReferrals: referredUsers.length,
              paidReferrals: paidReferrals,
              freeReferrals: referredUsers.length - paidReferrals,
              referralDetails: referralDetails,
            };
          })
      );
      
      // Filter to only show users with referrals or balance
      const filtered = usersWithAffiliates.filter(
        u => u.totalReferrals > 0 || u.affiliateBalance > 0
      );
      
      res.json({ users: filtered });
    } catch (error) {
      console.error("Error in GET /api/admin/affiliate-earnings:", error);
      res.status(500).json({ error: "Failed to fetch affiliate earnings" });
    }
  });
  
  // Admin: Manually credit a referral (for missed referrals)
  app.post("/api/admin/affiliate/manual-credit", requireAdmin, async (req, res) => {
    try {
      const { referredUserId } = req.body;
      
      if (!referredUserId) {
        return res.status(400).json({ error: "Referred user ID is required" });
      }
      
      // Get the referred user
      const referredUser = await storage.getUser(referredUserId);
      if (!referredUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      if (!referredUser.referredBy) {
        return res.status(400).json({ error: "This user was not referred by anyone" });
      }
      
      if (referredUser.planType !== 'scale' && referredUser.planType !== 'empire') {
        return res.status(400).json({ error: "User must have a paid plan (Scale or Empire) to credit referral" });
      }
      
      // Get referrer first
      const referrer = await storage.getUserByUid(referredUser.referredBy);
      if (!referrer) {
        return res.status(404).json({ error: "Referrer not found" });
      }
      
      // Check if already credited using referrer's ID
      const existingEarnings = await storage.getUserAffiliateEarnings(referrer.id);
      const alreadyCredited = existingEarnings?.some(e => e.referredUserId === referredUserId);
      if (alreadyCredited) {
        return res.status(400).json({ error: "Referral reward already credited for this user" });
      }
      
      // Process the referral reward
      await storage.processReferralReward(referredUserId, referredUser.planType);
      
      // Get updated referrer balance
      const updatedReferrer = await storage.getUser(referrer.id);
      
      console.log(`[Admin] Manually credited referral for ${referredUser.username} to referrer ${referrer.username}`);
      
      res.json({ 
        success: true, 
        message: `Referral reward credited to ${referrer.username}`,
        referrer: {
          username: referrer.username,
          uid: referrer.uid,
          newBalance: updatedReferrer?.affiliateBalance || referrer.affiliateBalance
        }
      });
    } catch (error) {
      console.error("Error in POST /api/admin/affiliate/manual-credit:", error);
      res.status(500).json({ error: "Failed to credit referral" });
    }
  });

  // User: Get my withdrawal history
  app.get("/api/affiliate/withdrawals", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const withdrawals = await storage.getUserWithdrawals(userId);
      res.json({ withdrawals });
    } catch (error) {
      console.error("Error in GET /api/affiliate/withdrawals:", error);
      res.status(500).json({ error: "Failed to fetch withdrawals" });
    }
  });

  // User: Request a withdrawal
  app.post("/api/affiliate/withdrawals", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check minimum balance (1000 PKR)
      const MIN_WITHDRAWAL = 1000;
      if (user.affiliateBalance < MIN_WITHDRAWAL) {
        return res.status(400).json({ 
          error: `Minimum balance of PKR ${MIN_WITHDRAWAL.toLocaleString()} required for withdrawal. Your current balance is PKR ${user.affiliateBalance.toLocaleString()}` 
        });
      }

      // Check for existing pending withdrawal
      const hasPending = await storage.hasPendingWithdrawal(userId);
      if (hasPending) {
        return res.status(400).json({ error: "You already have a pending withdrawal request" });
      }

      const schema = z.object({
        bankName: z.string().min(2, "Bank name is required"),
        accountNumber: z.string().min(5, "Account number is required"),
        accountHolderName: z.string().min(3, "Account holder name is required"),
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      // Create withdrawal request for full balance
      const withdrawal = await storage.createWithdrawalRequest(
        userId, 
        validationResult.data, 
        user.affiliateBalance
      );

      console.log(`[Withdrawal] New request from ${user.username}: PKR ${user.affiliateBalance}`);

      res.json({ 
        success: true, 
        withdrawal,
        message: `Withdrawal request of PKR ${user.affiliateBalance.toLocaleString()} submitted successfully`
      });
    } catch (error) {
      console.error("Error in POST /api/affiliate/withdrawals:", error);
      res.status(500).json({ error: "Failed to create withdrawal request" });
    }
  });

  // Admin: Get all withdrawal requests with user details (alias for /api/admin/affiliate/withdrawals)
  app.get("/api/admin/affiliate/withdrawals", requireAdmin, async (req, res) => {
    try {
      const withdrawals = await storage.getAllWithdrawals();
      const allUsers = await storage.getAllUsers();
      
      // Enrich withdrawals with user details
      const enrichedWithdrawals = withdrawals.map(w => {
        const user = allUsers.find(u => u.id === w.userId);
        const referredUsers = allUsers.filter(u => u.referredBy === user?.uid);
        
        return {
          ...w,
          username: user?.username || 'Unknown',
          uid: user?.uid || null,
          user: user ? {
            username: user.username,
            uid: user.uid,
            planType: user.planType,
            planStatus: user.planStatus,
            planStartDate: user.planStartDate,
            totalReferrals: referredUsers.length,
            paidReferrals: referredUsers.filter(r => r.planType === 'scale' || r.planType === 'empire').length,
            currentBalance: user.affiliateBalance,
          } : null,
        };
      });

      res.json({ withdrawals: enrichedWithdrawals });
    } catch (error) {
      console.error("Error in GET /api/admin/affiliate/withdrawals:", error);
      res.status(500).json({ error: "Failed to fetch withdrawals" });
    }
  });

  // Admin: Process (approve/reject) a withdrawal request via affiliate route
  app.put("/api/admin/affiliate/withdrawals/:id", requireAdmin, async (req, res) => {
    try {
      const adminId = req.session.userId;
      if (!adminId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { action, remarks } = req.body;
      
      if (!action || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: "Invalid action. Must be 'approve' or 'reject'" });
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      const updated = await storage.processWithdrawal(id, adminId, { status, remarks });
      
      if (!updated) {
        return res.status(404).json({ error: "Withdrawal not found or already processed" });
      }

      console.log(`[Admin] Withdrawal ${id} ${status} by admin ${adminId}`);

      res.json({ 
        success: true, 
        withdrawal: updated,
        message: `Withdrawal ${status} successfully`
      });
    } catch (error) {
      console.error("Error in PUT /api/admin/affiliate/withdrawals/:id:", error);
      res.status(500).json({ error: "Failed to process withdrawal" });
    }
  });

  // Admin: Get all withdrawal requests with user details
  app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
    try {
      const withdrawals = await storage.getAllWithdrawals();
      const allUsers = await storage.getAllUsers();
      
      // Enrich withdrawals with user details
      const enrichedWithdrawals = withdrawals.map(w => {
        const user = allUsers.find(u => u.id === w.userId);
        const referredUsers = allUsers.filter(u => u.referredBy === user?.uid);
        
        return {
          ...w,
          user: user ? {
            username: user.username,
            uid: user.uid,
            planType: user.planType,
            planStatus: user.planStatus,
            planStartDate: user.planStartDate,
            totalReferrals: referredUsers.length,
            paidReferrals: referredUsers.filter(r => r.planType === 'scale' || r.planType === 'empire').length,
            currentBalance: user.affiliateBalance,
          } : null,
        };
      });

      res.json({ withdrawals: enrichedWithdrawals });
    } catch (error) {
      console.error("Error in GET /api/admin/withdrawals:", error);
      res.status(500).json({ error: "Failed to fetch withdrawals" });
    }
  });

  // Admin: Process (approve/reject) a withdrawal request
  app.patch("/api/admin/withdrawals/:id", requireAdmin, async (req, res) => {
    try {
      const adminId = req.session.userId;
      if (!adminId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const schema = z.object({
        status: z.enum(["approved", "rejected"]),
        remarks: z.string().optional(),
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updated = await storage.processWithdrawal(id, adminId, validationResult.data);
      if (!updated) {
        return res.status(404).json({ error: "Withdrawal not found or already processed" });
      }

      console.log(`[Admin] Withdrawal ${id} ${validationResult.data.status} by admin ${adminId}`);

      res.json({ 
        success: true, 
        withdrawal: updated,
        message: `Withdrawal ${validationResult.data.status} successfully`
      });
    } catch (error) {
      console.error("Error in PATCH /api/admin/withdrawals/:id:", error);
      res.status(500).json({ error: "Failed to process withdrawal" });
    }
  });

  // ==================== END AFFILIATE SYSTEM ENDPOINTS ====================
  
  // 2FA Setup Verification - Complete setup by verifying code
  app.post("/api/2fa/verify-setup", async (req, res) => {
    try {
      const { code, username, password } = req.body;
      
      if (!code || !username || !password) {
        return res.status(400).json({ error: "Code, username and password are required" });
      }
      
      // Verify credentials again
      const user = await storage.getUserByUsername(username.trim());
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      const isPasswordValid = await storage.verifyPassword(user, password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      // Get the pending secret from session
      const pending2FA = req.session.pending2FASetup;
      if (!pending2FA || pending2FA.userId !== user.id) {
        return res.status(400).json({ error: "No pending 2FA setup found. Please start login again." });
      }
      
      // Verify the code with the pending secret
      const isValid = authenticator.check(code, pending2FA.secret);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid verification code" });
      }
      
      // Save the 2FA secret and enable it
      await db.execute(sql`
        UPDATE users 
        SET two_factor_secret = ${pending2FA.secret}, 
            two_factor_enabled = true 
        WHERE id = ${user.id}
      `);
      
      // Clear the pending setup
      delete req.session.pending2FASetup;
      
      console.log(`[Security] 2FA enabled for admin: ${user.username}`);
      
      // Now complete the login
      req.session.regenerate((err) => {
        if (err) {
          return res.status(500).json({ error: "Login failed" });
        }
        
        req.session.userId = user.id;
        
        req.session.save((saveErr) => {
          if (saveErr) {
            return res.status(500).json({ error: "Login failed" });
          }
          
          res.json({
            success: true,
            message: "2FA enabled successfully",
            user: {
              id: user.id,
              username: user.username,
              isAdmin: user.isAdmin
            }
          });
        });
      });
    } catch (error) {
      console.error("Error in /api/2fa/verify-setup:", error);
      res.status(500).json({ error: "2FA setup failed" });
    }
  });
  
  // Disable 2FA for admin (requires current 2FA code)
  app.post("/api/2fa/disable", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { code } = req.body;
      const user = await storage.getUser(req.session.userId!);
      
      if (!user || !user.twoFactorSecret) {
        return res.status(400).json({ error: "2FA is not enabled" });
      }
      
      // Verify current 2FA code
      const isValid = authenticator.check(code, user.twoFactorSecret);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid 2FA code" });
      }
      
      // Disable 2FA
      await db.execute(sql`
        UPDATE users 
        SET two_factor_secret = NULL, 
            two_factor_enabled = false 
        WHERE id = ${user.id}
      `);
      
      console.log(`[Security] 2FA disabled for admin: ${user.username}`);
      
      res.json({ success: true, message: "2FA disabled" });
    } catch (error) {
      console.error("Error disabling 2FA:", error);
      res.status(500).json({ error: "Failed to disable 2FA" });
    }
  });

  // Logout endpoint
  app.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
    });
  });

  // Check session endpoint
  app.get("/api/session", async (req, res) => {
    if (!req.session.userId) {
      return res.json({ authenticated: false });
    }

    const user = await storage.getUser(req.session.userId);
    
    if (!user) {
      req.session.userId = undefined;
      return res.json({ authenticated: false });
    }

    res.json({ 
      authenticated: true,
      user: { 
        id: user.id, 
        username: user.username, 
        isAdmin: user.isAdmin,
        planType: user.planType,
        planStatus: user.planStatus,
        planExpiry: user.planExpiry,
        dailyVideoCount: user.dailyVideoCount,
        isPlanExpired: isPlanExpired(user),
      } 
    });
  });

  // Get current user details endpoint (requires auth)
  app.get("/api/user/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        id: user.id,
        username: user.username,
        isAdmin: user.isAdmin,
        planType: user.planType,
        planStatus: user.planStatus,
        planExpiry: user.planExpiry,
        planStartDate: user.planStartDate,
        dailyVideoCount: user.dailyVideoCount,
        dailyResetDate: user.dailyResetDate,
      });
    } catch (error) {
      console.error("Error in GET /api/user/me:", error);
      res.status(500).json({ error: "Failed to fetch user details" });
    }
  });

  // Get voice character usage for current user
  app.get("/api/user/voice-usage", requireAuth, async (req, res) => {
    try {
      // Check and reset if needed, then get fresh user data
      const user = await storage.checkAndResetVoiceCharacters(req.session.userId!);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const usage = getVoiceCharacterUsage(user);
      
      res.json({
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        resetDate: usage.resetDate,
        resetDays: usage.resetDays,
        planType: user.planType,
        isAdmin: user.isAdmin,
      });
    } catch (error) {
      console.error("Error in GET /api/user/voice-usage:", error);
      res.status(500).json({ error: "Failed to fetch voice usage" });
    }
  });

  // Get all users endpoint (admin only)
  app.get("/api/users", requireAdmin, async (req, res) => {
    try {
      // Fetch users and video stats in parallel using efficient SQL aggregation
      const [users, videoStatsMap] = await Promise.all([
        storage.getAllUsers(),
        storage.getAllUsersVideoStats()
      ]);
      
      // Map video stats to each user
      const usersWithStats = users.map(user => {
        const videoStats = videoStatsMap.get(user.id) || {
          completed: 0,
          failed: 0,
          pending: 0,
          total: 0,
        };
        
        // Don't send password hashes to frontend
        return {
          id: user.id,
          username: user.username,
          uid: user.uid,
          isAdmin: user.isAdmin,
          planType: user.planType,
          planStatus: user.planStatus,
          planExpiry: user.planExpiry,
          apiToken: user.apiToken,
          allowedIp1: user.allowedIp1,
          allowedIp2: user.allowedIp2,
          isAccountActive: user.isAccountActive,
          dailyVideoLimit: user.dailyVideoLimit,
          bulkMaxBatch: user.bulkMaxBatch,
          bulkDelaySeconds: user.bulkDelaySeconds,
          bulkMaxPrompts: user.bulkMaxPrompts,
          videoStats,
        };
      });
      
      // Sort by total videos generated (highest first)
      usersWithStats.sort((a, b) => b.videoStats.total - a.videoStats.total);
      
      res.json({ users: usersWithStats });
    } catch (error) {
      console.error("Error in GET /api/users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Create user endpoint (admin only)
  app.post("/api/users", requireAdmin, async (req, res) => {
    try {
      const validationResult = insertUserSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { username, password, isAdmin, planType, dailyVideoLimit, expiryDays, bulkMaxBatch, bulkDelaySeconds, bulkMaxPrompts } = validationResult.data;

      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(409).json({ error: "Username already exists" });
      }

      const newUser = await storage.createUser({ 
        username, 
        password, 
        isAdmin, 
        planType,
        dailyVideoLimit,
        expiryDays,
        bulkMaxBatch,
        bulkDelaySeconds,
        bulkMaxPrompts
      });
      
      res.json({ 
        success: true,
        user: { 
          id: newUser.id, 
          username: newUser.username, 
          isAdmin: newUser.isAdmin,
          planType: newUser.planType,
          planStatus: newUser.planStatus,
          planExpiry: newUser.planExpiry
        } 
      });
    } catch (error) {
      console.error("Error in /api/users:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Update user plan endpoint (admin only)
  app.patch("/api/users/:id/plan", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const validationResult = updateUserPlanSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      // Get user BEFORE update to check if they're on free plan
      const userBeforeUpdate = await storage.getUser(id);
      if (!userBeforeUpdate) {
        return res.status(404).json({ error: "User not found" });
      }
      
      const updatedUser = await storage.updateUserPlan(id, validationResult.data);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Process referral reward if user had referrer AND was on free plan AND is now on paid plan
      const newPlanType = validationResult.data.planType;
      if (userBeforeUpdate.referredBy && 
          userBeforeUpdate.planType === "free" && 
          (newPlanType === "scale" || newPlanType === "empire")) {
        await storage.processReferralReward(id, newPlanType);
        console.log(`[Affiliate] Processed referral reward for user ${updatedUser.username} upgrading to ${newPlanType}`);
      }

      res.json({ 
        success: true,
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          isAdmin: updatedUser.isAdmin,
          planType: updatedUser.planType,
          planStatus: updatedUser.planStatus,
          planExpiry: updatedUser.planExpiry,
          apiToken: updatedUser.apiToken,
        }
      });
    } catch (error) {
      console.error("Error in PATCH /api/users/:id/plan:", error);
      res.status(500).json({ error: "Failed to update user plan" });
    }
  });

  // Renew user plan endpoint (admin only)
  app.post("/api/users/:id/renew", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { days, planType } = req.body;
      
      if (!days || typeof days !== 'number' || days < 1) {
        return res.status(400).json({ error: "Invalid days value" });
      }
      
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      if (user.planType === "free" && !planType) {
        return res.status(400).json({ error: "Cannot renew free plan without specifying new plan type" });
      }
      
      // Validate plan type if provided
      const validPlanTypes = ["scale", "empire", "enterprise"];
      if (planType && !validPlanTypes.includes(planType)) {
        return res.status(400).json({ error: "Invalid plan type" });
      }
      
      // Determine the final plan type
      const newPlanType = planType || user.planType;
      const planChanged = planType && planType !== user.planType;
      
      // Calculate new expiry date
      let newExpiry: Date;
      if (user.planExpiry && !planChanged) {
        const currentExpiry = new Date(user.planExpiry);
        // If current expiry is in the past, start from today
        if (currentExpiry < new Date()) {
          newExpiry = new Date();
        } else {
          newExpiry = currentExpiry;
        }
      } else {
        // If plan changed, start fresh from today
        newExpiry = new Date();
      }
      newExpiry.setDate(newExpiry.getDate() + days);
      
      // Update the user plan
      const updateData: any = {
        planStatus: "active",
        planExpiry: newExpiry.toISOString(),
      };
      
      if (planChanged) {
        updateData.planType = newPlanType;
        updateData.planStartDate = new Date().toISOString();
      }
      
      const updatedUser = await storage.updateUserPlan(id, updateData);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Process affiliate reward
      if (user.referredBy) {
        await storage.processReferralReward(id, newPlanType);
        console.log(`[Affiliate] Processed ${planChanged ? 'upgrade' : 'renewal'} reward for user ${user.username} (${newPlanType})`);
      }
      
      console.log(`[Admin] ${planChanged ? `Changed ${user.username}'s plan from ${user.planType} to ${newPlanType} and ` : `Renewed ${user.username}'s ${newPlanType} plan `}extended by ${days} days. New expiry: ${newExpiry.toISOString()}`);
      
      res.json({ 
        success: true,
        planExpiry: updatedUser.planExpiry,
        planChanged,
        newPlanType,
        message: `Plan ${planChanged ? `changed to ${newPlanType} and ` : ''}renewed for ${days} days`
      });
    } catch (error) {
      console.error("Error in POST /api/users/:id/renew:", error);
      res.status(500).json({ error: "Failed to renew user plan" });
    }
  });

  // Update user API token endpoint (admin only)
  app.patch("/api/users/:id/token", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const validationResult = updateUserApiTokenSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updatedUser = await storage.updateUserApiToken(id, validationResult.data);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ 
        success: true,
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          isAdmin: updatedUser.isAdmin,
          planType: updatedUser.planType,
          planStatus: updatedUser.planStatus,
          planExpiry: updatedUser.planExpiry,
          apiToken: updatedUser.apiToken,
        }
      });
    } catch (error) {
      console.error("Error in PATCH /api/users/:id/token:", error);
      res.status(500).json({ error: "Failed to update user API token" });
    }
  });

  // Delete user endpoint (admin only)
  app.delete("/api/users/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Prevent admin from deleting themselves
      if (id === req.session.userId) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }
      
      await storage.deleteUser(id);
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error in DELETE /api/users/:id:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Reactivate user account endpoint (admin only)
  app.post("/api/users/:id/reactivate", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      const updatedUser = await storage.reactivateUserAccount(id);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ 
        success: true,
        message: "User account reactivated and IP restrictions reset",
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          isAccountActive: updatedUser.isAccountActive,
          allowedIp1: updatedUser.allowedIp1,
          allowedIp2: updatedUser.allowedIp2,
        }
      });
    } catch (error) {
      console.error("Error in POST /api/users/:id/reactivate:", error);
      res.status(500).json({ error: "Failed to reactivate user account" });
    }
  });

  // Extend or reduce all users' expiry by specified days (admin only)
  app.post("/api/admin/extend-all-expiry", requireAdmin, async (req, res) => {
    try {
      const { days } = req.body;
      
      if (days === undefined || days === null || typeof days !== 'number' || days === 0) {
        return res.status(400).json({ error: "Days must be a non-zero number" });
      }

      const action = days > 0 ? "Extended" : "Reduced";
      const dayCount = Math.abs(days);
      console.log(`[Admin] ${action} all users' expiry by ${dayCount} day(s)`);
      const updatedCount = await storage.extendAllUsersExpiry(days);
      
      res.json({ 
        success: true,
        message: `${action} expiry for ${updatedCount} users by ${dayCount} day(s)`,
        updatedCount
      });
    } catch (error) {
      console.error("Error in POST /api/admin/extend-all-expiry:", error);
      res.status(500).json({ error: "Failed to update users' expiry" });
    }
  });

  // Reset daily video count endpoint (admin only)
  app.post("/api/users/:id/reset-video-count", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Verify user exists
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      await storage.resetDailyVideoCount(id);
      
      res.json({ 
        success: true,
        message: "Daily video count has been reset to 0"
      });
    } catch (error) {
      console.error("Error in POST /api/users/:id/reset-video-count:", error);
      res.status(500).json({ error: "Failed to reset daily video count" });
    }
  });

  // Clear user data endpoint (admin only) - Delete all non-completed videos
  app.post("/api/admin/clear-user-data/:userId", requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Verify user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      console.log(`[Admin] Clearing data for user ${user.username} (${userId})`);

      // Get all videos for this user
      const allVideos = await storage.getUserVideoHistory(userId);
      
      // Filter videos that are NOT completed
      const videosToDelete = allVideos.filter(video => video.status !== 'completed');
      
      console.log(`[Admin] Found ${videosToDelete.length} non-completed videos to delete for ${user.username}`);

      // Delete each non-completed video
      let deletedCount = 0;
      for (const video of videosToDelete) {
        try {
          await storage.deleteVideoHistoryById(video.id);
          deletedCount++;
        } catch (err) {
          console.error(`[Admin] Failed to delete video ${video.id}:`, err);
        }
      }

      // Reset daily video count but keep expiry date
      await storage.resetDailyVideoCount(userId);
      
      console.log(`[Admin] Successfully deleted ${deletedCount} videos for ${user.username}`);
      
      res.json({ 
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} non-completed videos. Completed videos preserved.`
      });
    } catch (error) {
      console.error("Error in POST /api/admin/clear-user-data:", error);
      res.status(500).json({ error: "Failed to clear user data" });
    }
  });

  // Clear ONLY pending videos for a user (admin only)
  app.post("/api/admin/clear-pending-videos/:userId", requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Verify user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      console.log(`[Admin] Clearing PENDING videos for user ${user.username} (${userId})`);

      // FIRST: Stop any active bulk queue for this user (before deleting)
      try {
        stopAllProcessing(userId);
        console.log(`[Admin] Stopped bulk queue for user ${user.username}`);
      } catch (err) {
        console.error(`[Admin] Failed to stop bulk queue:`, err);
      }

      // Get all videos for this user with non-terminal pending statuses
      // Include: pending, generating, queued, retrying, initializing (all non-completed/non-failed states)
      const allVideos = await db
        .select()
        .from(videoHistory)
        .where(
          and(
            eq(videoHistory.userId, userId),
            or(
              eq(videoHistory.status, 'pending'),
              eq(videoHistory.status, 'generating'),
              eq(videoHistory.status, 'queued'),
              eq(videoHistory.status, 'retrying'),
              eq(videoHistory.status, 'initializing')
            )
          )
        );
      
      console.log(`[Admin] Found ${allVideos.length} pending/in-progress videos to delete for ${user.username}`);

      // Delete each pending video
      let deletedCount = 0;
      for (const video of allVideos) {
        try {
          await storage.deleteVideoHistoryById(video.id);
          deletedCount++;
        } catch (err) {
          console.error(`[Admin] Failed to delete pending video ${video.id}:`, err);
        }
      }
      
      console.log(`[Admin] Successfully deleted ${deletedCount} pending videos for ${user.username}`);
      
      res.json({ 
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} pending/in-progress videos for ${user.username}.`
      });
    } catch (error) {
      console.error("Error in POST /api/admin/clear-pending-videos:", error);
      res.status(500).json({ error: "Failed to clear pending videos" });
    }
  });

  // Force reset bulk queue for a user (admin only) - fixes stuck "already in progress" error
  app.post("/api/admin/force-reset-queue/:userId", requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Verify user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      console.log(`[Admin] Force resetting bulk queue for user ${user.username} (${userId})`);

      // Import and call forceResetQueue
      const { forceResetQueue } = await import('./bulkQueue');
      const result = forceResetQueue(userId);
      
      console.log(`[Admin] Force reset complete for ${user.username}:`, result);
      
      res.json({ 
        success: true,
        ...result,
        username: user.username
      });
    } catch (error) {
      console.error("Error in POST /api/admin/force-reset-queue:", error);
      res.status(500).json({ error: "Failed to force reset queue" });
    }
  });

  // Remove user plan endpoint (admin only)
  app.delete("/api/users/:id/plan", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      const updatedUser = await storage.removePlan(id);
      
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ 
        success: true,
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          isAdmin: updatedUser.isAdmin,
          planType: updatedUser.planType,
          planStatus: updatedUser.planStatus,
          planExpiry: updatedUser.planExpiry,
          apiToken: updatedUser.apiToken,
        }
      });
    } catch (error) {
      console.error("Error in DELETE /api/users/:id/plan:", error);
      res.status(500).json({ error: "Failed to remove user plan" });
    }
  });

  // Reset user password (admin only)
  app.post("/api/users/:id/reset-password", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Generate a random password
      const newPassword = crypto.randomBytes(8).toString('hex');
      
      // Hash the new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      
      // Update user password
      await storage.updateUserPassword(parseInt(id), hashedPassword);

      res.json({ 
        success: true,
        newPassword: newPassword,
        message: "Password has been reset successfully"
      });
    } catch (error) {
      console.error("Error in POST /api/users/:id/reset-password:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // Create demo account (1 hour validity, Empire plan)
  app.post("/api/users/create-demo", requireAdmin, async (req, res) => {
    try {
      // Generate unique demo username
      const timestamp = Date.now().toString(36).toUpperCase();
      const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
      const username = `DEMO_${timestamp}${randomSuffix}`;
      
      // Generate random password and hash it
      const password = crypto.randomBytes(6).toString('hex');
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // 1 hour expiry
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      
      // Direct database insert for demo account with correct expiry
      const [newUser] = await db
        .insert(users)
        .values({
          username,
          password: hashedPassword,
          isAdmin: false,
          planType: "empire",
          planStatus: "active",
          planStartDate: new Date().toISOString(),
          planExpiry: expiresAt.toISOString(),
          dailyVideoLimit: 20,
          videosGeneratedToday: 0,
          isAccountActive: true,
          dailyResetDate: new Date().toISOString(),
        })
        .returning();
      
      console.log(`[Demo] Created: ${username}, expires: ${expiresAt.toISOString()}`);

      res.json({
        success: true,
        username,
        password,
        expiresAt: expiresAt.toISOString(),
        message: "Demo account created"
      });
    } catch (error) {
      console.error("Error creating demo:", error);
      res.status(500).json({ error: "Failed to create demo account" });
    }
  });

  // Cleanup expired demo accounts (runs on each API call or can be scheduled)
  const cleanupExpiredDemoAccounts = async () => {
    try {
      const allUsers = await storage.getAllUsers();
      const now = new Date();
      
      for (const user of allUsers) {
        // Check if it's a demo account (username starts with DEMO_)
        if (user.username.startsWith('DEMO_') && user.planExpiry) {
          const expiry = new Date(user.planExpiry);
          if (expiry < now) {
            // Delete expired demo account
            await storage.deleteUser(user.id);
            console.log(`Deleted expired demo account: ${user.username}`);
          }
        }
      }
    } catch (error) {
      console.error("Error cleaning up demo accounts:", error);
    }
  };

  // Run cleanup every 5 minutes
  setInterval(cleanupExpiredDemoAccounts, 5 * 60 * 1000);

  // Auto-update expired plans status
  const updateExpiredPlansStatus = async () => {
    try {
      const allUsers = await storage.getAllUsers();
      const now = new Date();
      
      for (const user of allUsers) {
        // Check if plan has expired but status is still 'active'
        if (user.planStatus === 'active' && user.planExpiry) {
          const expiry = new Date(user.planExpiry);
          if (expiry < now) {
            // Update plan status to expired
            await storage.updateUserPlan(user.id, {
              planStatus: 'expired'
            });
            console.log(`[Plan Expiry] Updated ${user.username} status to expired`);
          }
        }
      }
    } catch (error) {
      console.error("Error updating expired plans:", error);
    }
  };

  // Run expiry check every 10 minutes
  setInterval(updateExpiredPlansStatus, 10 * 60 * 1000);
  // Run once at startup
  updateExpiredPlansStatus();

  // API Token Management Endpoints (admin only)
  app.get("/api/tokens", requireAdmin, async (req, res) => {
    try {
      const tokens = await storage.getAllApiTokens();
      res.json({ tokens });
    } catch (error) {
      console.error("Error in GET /api/tokens:", error);
      res.status(500).json({ error: "Failed to fetch API tokens" });
    }
  });

  app.post("/api/tokens", requireAdmin, async (req, res) => {
    try {
      const validationResult = insertApiTokenSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const newToken = await storage.addApiToken(validationResult.data);
      res.json({ success: true, token: newToken });
    } catch (error) {
      console.error("Error in POST /api/tokens:", error);
      res.status(500).json({ error: "Failed to add API token" });
    }
  });

  app.delete("/api/tokens/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteApiToken(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error in DELETE /api/tokens/:id:", error);
      res.status(500).json({ error: "Failed to delete API token" });
    }
  });

  app.patch("/api/tokens/:id/toggle", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      
      const updatedToken = await storage.toggleApiTokenStatus(id, isActive);
      
      if (!updatedToken) {
        return res.status(404).json({ error: "Token not found" });
      }

      res.json({ success: true, token: updatedToken });
    } catch (error) {
      console.error("Error in PATCH /api/tokens/:id/toggle:", error);
      res.status(500).json({ error: "Failed to update token status" });
    }
  });

  // Token Rotation Settings Endpoints (admin only)
  app.get("/api/token-settings", requireAdmin, async (req, res) => {
    try {
      const settings = await storage.getTokenSettings();
      res.json({ settings });
    } catch (error) {
      console.error("Error in GET /api/token-settings:", error);
      res.status(500).json({ error: "Failed to fetch token settings" });
    }
  });

  app.put("/api/token-settings", requireAdmin, async (req, res) => {
    try {
      const validationResult = updateTokenSettingsSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updatedSettings = await storage.updateTokenSettings(validationResult.data);
      res.json({ success: true, settings: updatedSettings });
    } catch (error) {
      console.error("Error in PUT /api/token-settings:", error);
      res.status(500).json({ error: "Failed to update token settings" });
    }
  });

  // Plan Availability Settings Endpoints
  app.get("/api/plan-availability", async (req, res) => {
    try {
      // Prevent caching to ensure pricing page always shows current availability
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      const availability = await storage.getPlanAvailability();
      res.json({ availability });
    } catch (error) {
      console.error("Error in GET /api/plan-availability:", error);
      res.status(500).json({ error: "Failed to fetch plan availability" });
    }
  });

  app.put("/api/plan-availability", requireAdmin, async (req, res) => {
    try {
      const { updatePlanAvailabilitySchema } = await import("@shared/schema");
      const validationResult = updatePlanAvailabilitySchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updatedAvailability = await storage.updatePlanAvailability(validationResult.data);
      res.json({ success: true, availability: updatedAvailability });
    } catch (error) {
      console.error("Error in PUT /api/plan-availability:", error);
      res.status(500).json({ error: "Failed to update plan availability" });
    }
  });

  // Pricing Plans Endpoints
  // Public endpoint - get active pricing plans for pricing page
  app.get("/api/pricing-plans", async (req, res) => {
    try {
      const plans = await storage.getActivePricingPlans();
      res.json({ plans });
    } catch (error) {
      console.error("Error in GET /api/pricing-plans:", error);
      res.status(500).json({ error: "Failed to fetch pricing plans" });
    }
  });

  // Admin endpoints for pricing plan management
  app.get("/api/admin/pricing-plans", requireAuth, requireAdmin, async (req, res) => {
    try {
      const plans = await storage.getAllPricingPlans();
      res.json({ plans });
    } catch (error) {
      console.error("Error in GET /api/admin/pricing-plans:", error);
      res.status(500).json({ error: "Failed to fetch pricing plans" });
    }
  });

  app.post("/api/admin/pricing-plans", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { insertPricingPlanSchema } = await import("@shared/schema");
      const validationResult = insertPricingPlanSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const newPlan = await storage.createPricingPlan(validationResult.data);
      res.json({ success: true, plan: newPlan });
    } catch (error) {
      console.error("Error in POST /api/admin/pricing-plans:", error);
      res.status(500).json({ error: "Failed to create pricing plan" });
    }
  });

  app.patch("/api/admin/pricing-plans/:planId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { planId } = req.params;
      const { updatePricingPlanSchema } = await import("@shared/schema");
      const validationResult = updatePricingPlanSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updatedPlan = await storage.updatePricingPlan(planId, validationResult.data);
      if (!updatedPlan) {
        return res.status(404).json({ error: "Plan not found" });
      }
      res.json({ success: true, plan: updatedPlan });
    } catch (error) {
      console.error("Error in PATCH /api/admin/pricing-plans:", error);
      res.status(500).json({ error: "Failed to update pricing plan" });
    }
  });

  app.delete("/api/admin/pricing-plans/:planId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { planId } = req.params;
      await storage.deletePricingPlan(planId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error in DELETE /api/admin/pricing-plans:", error);
      res.status(500).json({ error: "Failed to delete pricing plan" });
    }
  });

  app.post("/api/admin/pricing-plans/reorder", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { planIds } = req.body;
      if (!Array.isArray(planIds)) {
        return res.status(400).json({ error: "planIds must be an array" });
      }
      await storage.reorderPricingPlans(planIds);
      res.json({ success: true });
    } catch (error) {
      console.error("Error in POST /api/admin/pricing-plans/reorder:", error);
      res.status(500).json({ error: "Failed to reorder pricing plans" });
    }
  });

  // App Settings Endpoints
  // Public endpoint - only returns non-sensitive settings for frontend
  app.get("/api/app-settings", async (req, res) => {
    try {
      const settings = await storage.getAppSettings();
      if (!settings) {
        return res.status(404).json({ error: "Settings not found" });
      }
      // Only return public, non-sensitive settings
      const publicSettings = {
        id: settings.id,
        whatsappUrl: settings.whatsappUrl,
        enableVideoMerge: settings.enableVideoMerge,
        logoUrl: settings.logoUrl,
        updatedAt: settings.updatedAt,
      };
      res.json({ settings: publicSettings });
    } catch (error) {
      console.error("Error in GET /api/app-settings:", error);
      res.status(500).json({ error: "Failed to fetch app settings" });
    }
  });

  // Public endpoint for logo only (for Login/Signup pages)
  app.get("/api/logo", async (req, res) => {
    try {
      const settings = await storage.getAppSettings();
      const logoUrl = settings?.logoUrl || "/veo3-logo.png";
      res.json({ logoUrl });
    } catch (error) {
      console.error("Error in GET /api/logo:", error);
      res.json({ logoUrl: "/veo3-logo.png" }); // Fallback to default
    }
  });

  // Stream video from memory buffer (no file storage, no database)
  app.get("/api/video-preview/:videoId", async (req, res) => {
    try {
      const { videoId } = req.params;
      
      // Check both caches (background gen and bulk queue)
      let buffer = getVideoBuffer(videoId);
      if (!buffer) {
        buffer = getVideoBufferFromBulk(videoId);
      }
      
      // Also check direct video cache (for direct_to_user mode)
      if (!buffer) {
        const { getDirectVideo } = await import('./bulkQueueFlow');
        const base64 = await getDirectVideo(videoId);
        if (base64) {
          buffer = Buffer.from(base64, 'base64');
        }
      }
      
      if (!buffer) {
        return res.status(404).json({ error: "Video not found or expired" });
      }
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'public, max-age=10800'); // 3 hours cache
      res.setHeader('CDN-Cache-Control', 'max-age=10800'); // Cloudflare specific
      
      // CORS headers for embedded video playback
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Accept-Ranges', 'bytes');
      
      res.send(buffer);
    } catch (error) {
      console.error("Error streaming video:", error);
      res.status(500).json({ error: "Failed to stream video" });
    }
  });

  // LOCAL DISK VIDEO ENDPOINT REMOVED - Videos now served from Google Storage URLs directly
  // This saves VPS bandwidth as videos are served from Google's CDN
  app.get("/api/local-video/:videoId", async (req, res) => {
    // Return 410 Gone - endpoint permanently removed
    res.status(410).json({ 
      error: "Local video storage disabled. Videos are now served directly from cloud storage.",
      message: "Please refresh the page to get updated video URLs."
    });
  });

  // Demo video endpoint REMOVED - was consuming 50GB+ bandwidth
  // Homepage no longer has demo video
  app.get("/api/demo-video", (req, res) => {
    res.status(410).json({ error: "Demo video removed" });
  });

  // Get local disk storage statistics (admin only)
  app.get("/api/admin/local-storage-stats", requireAdmin, async (req, res) => {
    try {
      const { getStorageStats, listAllVideos } = await import('./localDiskStorage');
      const stats = await getStorageStats();
      const videos = listAllVideos();
      
      res.json({ 
        stats,
        recentVideos: videos.slice(0, 20).map(v => ({
          id: v.id,
          createdAt: new Date(v.createdAt).toISOString(),
          expiresAt: new Date(v.expiresAt).toISOString(),
          sizeMB: Math.round(v.sizeBytes / 1024 / 1024 * 10) / 10,
          userId: v.userId
        }))
      });
    } catch (error) {
      console.error("Error getting local storage stats:", error);
      res.status(500).json({ error: "Failed to get storage stats" });
    }
  });

  // Manually trigger local disk cleanup (admin only)
  app.post("/api/admin/local-storage-cleanup", requireAdmin, async (req, res) => {
    try {
      const { cleanupExpiredVideos } = await import('./localDiskStorage');
      const deletedCount = await cleanupExpiredVideos();
      res.json({ success: true, deletedCount });
    } catch (error) {
      console.error("Error during local storage cleanup:", error);
      res.status(500).json({ error: "Cleanup failed" });
    }
  });

  // Delete ALL temporary videos from local storage (admin only)
  app.post("/api/admin/local-storage-delete-all", requireAdmin, async (req, res) => {
    try {
      const { deleteAllVideos } = await import('./localDiskStorage');
      const result = await deleteAllVideos();
      res.json({ success: true, deleted: result.deleted, freedMB: result.freedMB });
    } catch (error) {
      console.error("Error deleting all local videos:", error);
      res.status(500).json({ error: "Delete all failed" });
    }
  });

  // Get real-time bandwidth statistics (admin only)
  app.get("/api/admin/bandwidth-stats", requireAdmin, async (req, res) => {
    try {
      const { getBandwidthStats } = await import('./index');
      const stats = getBandwidthStats();
      
      // Enrich with usernames from database
      for (const user of stats.currentHour.topUsers) {
        if (user.userId) {
          const dbUser = await storage.getUser(user.userId);
          if (dbUser) {
            user.username = dbUser.username;
          }
        }
      }
      
      res.json(stats);
    } catch (error) {
      console.error("Error getting bandwidth stats:", error);
      res.status(500).json({ error: "Failed to get bandwidth stats" });
    }
  });

  // Public endpoint for stats (for landing page)
  app.get("/api/stats", async (req, res) => {
    try {
      const totalVideos = await storage.getTotalVideosGenerated();
      res.json({ totalVideosGenerated: totalVideos });
    } catch (error) {
      console.error("Error in GET /api/stats:", error);
      res.json({ totalVideosGenerated: 0 }); // Fallback to 0
    }
  });

  // Admin-only endpoint - returns all settings including sensitive data
  app.get("/api/admin/app-settings", requireAdmin, async (req, res) => {
    try {
      const settings = await storage.getAppSettings();
      res.json({ settings });
    } catch (error) {
      console.error("Error in GET /api/admin/app-settings:", error);
      res.status(500).json({ error: "Failed to fetch app settings" });
    }
  });

  app.put("/api/app-settings", requireAdmin, async (req, res) => {
    try {
      const { updateAppSettingsSchema } = await import("@shared/schema");
      const validationResult = updateAppSettingsSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updatedSettings = await storage.updateAppSettings(validationResult.data);
      
      // Browser pool settings no longer used - using Media API
      
      res.json({ success: true, settings: updatedSettings });
    } catch (error) {
      console.error("Error in PUT /api/app-settings:", error);
      res.status(500).json({ error: "Failed to update app settings" });
    }
  });

  app.put("/api/app-settings/google-labs-cookie", requireAdmin, async (req, res) => {
    try {
      const { googleLabsCookie } = req.body;
      if (typeof googleLabsCookie !== "string") {
        return res.status(400).json({ error: "googleLabsCookie must be a string" });
      }
      const updatedSettings = await storage.updateAppSettings({ googleLabsCookie });
      res.json({ success: true, settings: updatedSettings });
    } catch (error) {
      console.error("Error in PUT /api/app-settings/google-labs-cookie:", error);
      res.status(500).json({ error: "Failed to update Google Labs cookie" });
    }
  });
  
  // Browser Pool Settings removed - now using Media API for video generation

  // Tool Maintenance Endpoints
  app.get("/api/tool-maintenance", async (req, res) => {
    try {
      const maintenance = await storage.getToolMaintenance();
      res.json({ maintenance });
    } catch (error) {
      console.error("Error in GET /api/tool-maintenance:", error);
      res.status(500).json({ error: "Failed to fetch tool maintenance status" });
    }
  });

  app.put("/api/tool-maintenance", requireAdmin, async (req, res) => {
    try {
      const { updateToolMaintenanceSchema } = await import("@shared/schema");
      const validationResult = updateToolMaintenanceSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const updatedMaintenance = await storage.updateToolMaintenance(validationResult.data);
      res.json({ success: true, maintenance: updatedMaintenance });
    } catch (error) {
      console.error("Error in PUT /api/tool-maintenance:", error);
      res.status(500).json({ error: "Failed to update tool maintenance status" });
    }
  });

  // System Metrics (polling fallback)
  app.get("/api/admin/system-metrics", requireAdmin, async (req, res) => {
    try {
      const { getSystemMetrics } = await import('./systemMetrics.js');
      const metrics = await getSystemMetrics();
      res.json(metrics);
    } catch (error) {
      console.error("Error fetching system metrics:", error);
      res.status(500).json({ error: "Failed to fetch system metrics" });
    }
  });

  // System Metrics Streaming (SSE)
  app.get("/api/admin/system-metrics/stream", requireAdmin, async (req, res) => {
    try {
      const { getSystemMetrics } = await import('./systemMetrics.js');
      
      // Set headers for Server-Sent Events
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      
      // Flush headers immediately to establish connection
      res.flushHeaders();
      
      // Send initial data immediately
      try {
        const initialMetrics = await getSystemMetrics();
        res.write(`data: ${JSON.stringify(initialMetrics)}\n\n`);
      } catch (error) {
        console.error('Error sending initial metrics:', error);
      }
      
      // Send metrics every 3 seconds
      const interval = setInterval(async () => {
        try {
          const metrics = await getSystemMetrics();
          res.write(`data: ${JSON.stringify(metrics)}\n\n`);
        } catch (error) {
          console.error('Error streaming metrics:', error);
          clearInterval(interval);
          res.end();
        }
      }, 3000);
      
      // Keep-alive ping every 15 seconds to prevent proxy timeouts
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15000);
      
      // Cleanup on client disconnect
      req.on('close', () => {
        clearInterval(interval);
        clearInterval(keepAlive);
        console.log('SSE client disconnected from system metrics stream');
      });
      
    } catch (error) {
      console.error("Error in system metrics stream:", error);
      res.status(500).json({ error: "Failed to stream system metrics" });
    }
  });

  // Bulk replace all tokens (admin only)
  app.post("/api/tokens/bulk-replace", requireAdmin, async (req, res) => {
    try {
      console.log('[Bulk Replace] Request body:', req.body);
      const validationResult = bulkReplaceTokensSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        console.error('[Bulk Replace] Validation failed:', validationResult.error.errors);
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      // Parse tokens from textarea (one per line)
      const tokensText = validationResult.data.tokens.trim();
      const tokenLines = tokensText.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          // Remove "Bearer " prefix if present
          return line.replace(/^Bearer\s+/i, '');
        });

      console.log('[Bulk Replace] Parsed token lines:', tokenLines.length);

      if (tokenLines.length === 0) {
        console.error('[Bulk Replace] No valid tokens found');
        return res.status(400).json({ 
          error: "No valid tokens found",
          details: ["Please enter at least one token"] 
        });
      }

      console.log('[Bulk Replace] Calling storage.replaceAllTokens...');
      const newTokens = await storage.replaceAllTokens(tokenLines);
      console.log('[Bulk Replace] Successfully replaced tokens:', newTokens.length);
      res.json({ success: true, tokens: newTokens, count: newTokens.length });
    } catch (error) {
      console.error("[Bulk Replace] Error details:", error);
      console.error("[Bulk Replace] Error stack:", error instanceof Error ? error.stack : 'No stack trace');
      res.status(500).json({ 
        error: "Failed to replace tokens",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Admin Credits Monitoring endpoint
  app.get("/api/admin/credits", requireAdmin, async (req, res) => {
    try {
      // Get all tokens to show total count
      const allTokens = await storage.getAllApiTokens();
      const activeTokens = allTokens.filter((t: { isActive: boolean }) => t.isActive);
      
      // Get latest snapshots per token to calculate total
      const perTokenSnapshots = await storage.getLatestCreditsSnapshotsPerToken();
      
      // Calculate total credits across all tokens (filter out null/undefined values)
      const totalCredits = perTokenSnapshots.reduce((sum, snapshot) => {
        const credits = snapshot.remainingCredits;
        return sum + (credits !== null && credits !== undefined ? credits : 0);
      }, 0);
      
      // Optionally perform a fresh check if requested
      const doFreshCheck = req.query.refresh === 'true';
      
      let checkedToken = null;
      let latestSnapshot = null;
      
      if (doFreshCheck) {
        try {
          // Get next rotation token for testing
          const token = await storage.getNextRotationToken();
          if (token) {
            checkedToken = token;
            // Perform a lightweight status check to get credits
            const pingResult = await checkVideoStatus('test-ping', 'test-scene', token.token);
            
            if (pingResult.remainingCredits !== undefined) {
              // Save snapshot with tokenId
              latestSnapshot = await storage.addCreditsSnapshot(
                pingResult.remainingCredits, 
                'manual_check',
                token.id
              );
            }
          }
        } catch (error) {
          console.error('[Admin Credits] Fresh check failed:', error);
        }
      }
      
      // Re-fetch per-token snapshots after potential new snapshot
      const updatedPerTokenSnapshots = await storage.getLatestCreditsSnapshotsPerToken();
      const updatedTotalCredits = updatedPerTokenSnapshots.reduce((sum, snapshot) => {
        const credits = snapshot.remainingCredits;
        return sum + (credits !== null && credits !== undefined ? credits : 0);
      }, 0);
      
      // Get recent history (last 20 snapshots)
      const recentSnapshots = await storage.getRecentCreditsSnapshots(20);
      
      // Get latest overall snapshot for timestamp
      const overallLatestSnapshot = await storage.getLatestCreditsSnapshot();
      
      // Count how many tokens have credit details available
      const tokensWithDetails = updatedPerTokenSnapshots.length;
      
      res.json({
        totalCredits: updatedTotalCredits || totalCredits || 0,
        perTokenSnapshots: updatedPerTokenSnapshots,
        lastUpdated: latestSnapshot?.recordedAt || overallLatestSnapshot?.recordedAt || null,
        history: recentSnapshots,
        tokenInfo: {
          totalTokens: allTokens.length,
          activeTokens: activeTokens.length,
          tokensWithDetails: tokensWithDetails,
          checkedTokenName: checkedToken?.label || null,
        },
      });
    } catch (error) {
      console.error("Error fetching credits:", error);
      res.status(500).json({ 
        error: "Failed to fetch credits",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Admin Dashboard Stats endpoint - lightweight SQL aggregation for dashboard
  app.get("/api/admin/dashboard-stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Get today's date in Pakistan timezone (UTC+5) - YYYY-MM-DD format
      // Database stores timestamps in UTC, but we want stats for Pakistan day
      const nowPk = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Karachi' }); // 'en-CA' gives YYYY-MM-DD format
      const todayPrefix = nowPk.split(',')[0]; // e.g., "2025-01-12"
      
      // Use SQL aggregation for today's stats - no memory overhead
      // Convert database UTC timestamps to Pakistan timezone, then compare dates
      const todayStatsQuery = await db
        .select({
          status: videoHistory.status,
          count: sql<number>`count(*)::int`,
        })
        .from(videoHistory)
        .where(sql`DATE(${videoHistory.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi') = ${todayPrefix}::date`)
        .groupBy(videoHistory.status);
      
      // Build today's stats from aggregation
      const todayStats = {
        total: 0,
        completed: 0,
        failed: 0,
        pending: 0,
      };
      
      todayStatsQuery.forEach(row => {
        todayStats.total += row.count;
        if (row.status === 'completed') todayStats.completed = row.count;
        if (row.status === 'failed') todayStats.failed = row.count;
        if (row.status === 'pending') todayStats.pending = row.count;
      });
      
      // Use SQL aggregation for per-token stats - no memory overhead
      const tokenStatsQuery = await db
        .select({
          tokenUsed: videoHistory.tokenUsed,
          status: videoHistory.status,
          count: sql<number>`count(*)::int`,
        })
        .from(videoHistory)
        .where(sql`${videoHistory.tokenUsed} IS NOT NULL`)
        .groupBy(videoHistory.tokenUsed, videoHistory.status);
      
      // Get all tokens for labels
      const allTokens = await storage.getAllApiTokens();
      const tokenMap = new Map(allTokens.map(t => [t.id, t.label]));
      
      // Build per-token statistics from aggregation
      const tokenStatsMap = new Map<string, { tokenId: string; label: string; total: number; completed: number; failed: number }>();
      
      tokenStatsQuery.forEach(row => {
        if (!row.tokenUsed) return;
        
        if (!tokenStatsMap.has(row.tokenUsed)) {
          tokenStatsMap.set(row.tokenUsed, {
            tokenId: row.tokenUsed,
            label: tokenMap.get(row.tokenUsed) || row.tokenUsed,
            total: 0,
            completed: 0,
            failed: 0,
          });
        }
        
        const stats = tokenStatsMap.get(row.tokenUsed)!;
        stats.total += row.count;
        if (row.status === 'completed') stats.completed = row.count;
        if (row.status === 'failed') stats.failed = row.count;
      });
      
      const tokenStats = Array.from(tokenStatsMap.values())
        .sort((a, b) => b.total - a.total);
      
      res.json({ 
        todayStats,
        tokenStats
      });
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res.status(500).json({ 
        error: "Failed to fetch dashboard stats",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Admin Messages endpoints
  
  // Get all admin messages (admin only)
  app.get("/api/admin/messages", requireAuth, requireAdmin, async (req, res) => {
    try {
      const messages = await storage.getAllAdminMessages();
      res.json({ messages });
    } catch (error) {
      console.error("Error fetching admin messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Create new admin message (admin only)
  app.post("/api/admin/messages", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { title, message } = req.body;
      if (!title || !message) {
        return res.status(400).json({ error: "Title and message are required" });
      }
      const newMessage = await storage.createAdminMessage(title, message);
      res.json({ message: newMessage });
    } catch (error) {
      console.error("Error creating admin message:", error);
      res.status(500).json({ error: "Failed to create message" });
    }
  });

  // Update admin message (admin only)
  app.put("/api/admin/messages/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { title, message, isActive } = req.body;
      if (!title || !message) {
        return res.status(400).json({ error: "Title and message are required" });
      }
      const updatedMessage = await storage.updateAdminMessage(id, title, message, isActive ?? true);
      if (!updatedMessage) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.json({ message: updatedMessage });
    } catch (error) {
      console.error("Error updating admin message:", error);
      res.status(500).json({ error: "Failed to update message" });
    }
  });

  // Toggle message active status (admin only)
  app.patch("/api/admin/messages/:id/toggle", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      const updatedMessage = await storage.toggleAdminMessageStatus(id, isActive);
      if (!updatedMessage) {
        return res.status(404).json({ error: "Message not found" });
      }
      res.json({ message: updatedMessage });
    } catch (error) {
      console.error("Error toggling message status:", error);
      res.status(500).json({ error: "Failed to toggle message status" });
    }
  });

  // Delete admin message (admin only)
  app.delete("/api/admin/messages/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteAdminMessage(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting admin message:", error);
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  // User endpoints for messages
  
  // Get active messages with read status for current user
  app.get("/api/messages", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const messages = await storage.getActiveAdminMessages();
      const readMessageIds = await storage.getUserReadMessageIds(userId);
      const messagesWithReadStatus = messages.map(msg => ({
        ...msg,
        isRead: readMessageIds.includes(msg.id)
      }));
      res.json({ messages: messagesWithReadStatus });
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Get unread messages count for current user
  app.get("/api/messages/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const count = await storage.getUnreadMessagesCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error fetching unread count:", error);
      res.status(500).json({ error: "Failed to fetch unread count" });
    }
  });

  // Mark a message as read
  app.post("/api/messages/:id/read", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const { id } = req.params;
      await storage.markMessageAsRead(userId, id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking message as read:", error);
      res.status(500).json({ error: "Failed to mark message as read" });
    }
  });

  // Mark all messages as read
  app.post("/api/messages/mark-all-read", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      await storage.markAllMessagesAsRead(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking all messages as read:", error);
      res.status(500).json({ error: "Failed to mark all messages as read" });
    }
  });

  // ==================== RESELLER MANAGEMENT (Admin Only) ====================

  // Get all resellers (admin only)
  app.get("/api/admin/resellers", requireAuth, requireAdmin, async (req, res) => {
    try {
      const allResellers = await storage.getAllResellers();
      res.json({ resellers: allResellers });
    } catch (error) {
      console.error("Error fetching resellers:", error);
      res.status(500).json({ error: "Failed to fetch resellers" });
    }
  });

  // Get single reseller details (admin only)
  app.get("/api/admin/resellers/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const reseller = await storage.getResellerById(id);
      if (!reseller) {
        return res.status(404).json({ error: "Reseller not found" });
      }
      res.json({ reseller });
    } catch (error) {
      console.error("Error fetching reseller:", error);
      res.status(500).json({ error: "Failed to fetch reseller" });
    }
  });

  // Create new reseller (admin only)
  app.post("/api/admin/resellers", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { username, password, creditBalance } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      // Check if username already exists in resellers
      const existingReseller = await storage.getResellerByUsername(username);
      if (existingReseller) {
        return res.status(400).json({ error: "Reseller username already exists" });
      }

      // Check if username exists in regular users
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already exists as a regular user" });
      }

      const reseller = await storage.createReseller({
        username,
        password,
        creditBalance: creditBalance || 0,
      });
      
      res.json({ reseller });
    } catch (error) {
      console.error("Error creating reseller:", error);
      res.status(500).json({ error: "Failed to create reseller" });
    }
  });

  // Add credits to reseller (admin only)
  app.post("/api/admin/resellers/:id/add-credits", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, reason } = req.body;
      
      if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Valid positive credit amount is required" });
      }

      const updatedReseller = await storage.updateResellerCredits(
        id, 
        amount, 
        reason || `Admin added ${amount} credits`
      );
      
      if (!updatedReseller) {
        return res.status(404).json({ error: "Reseller not found" });
      }
      
      res.json({ reseller: updatedReseller });
    } catch (error) {
      console.error("Error adding credits to reseller:", error);
      res.status(500).json({ error: "Failed to add credits" });
    }
  });

  // Remove credits from reseller (admin only)
  app.post("/api/admin/resellers/:id/remove-credits", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, reason } = req.body;
      
      if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Valid positive credit amount is required" });
      }

      const updatedReseller = await storage.updateResellerCredits(
        id, 
        -amount, 
        reason || `Admin removed ${amount} credits`
      );
      
      if (!updatedReseller) {
        return res.status(404).json({ error: "Reseller not found" });
      }
      
      res.json({ reseller: updatedReseller });
    } catch (error: any) {
      console.error("Error removing credits from reseller:", error);
      if (error.message === "Insufficient credits") {
        return res.status(400).json({ error: "Insufficient credits to remove" });
      }
      res.status(500).json({ error: "Failed to remove credits" });
    }
  });

  // Toggle reseller active status (admin only)
  app.patch("/api/admin/resellers/:id/toggle", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      
      const updatedReseller = await storage.toggleResellerStatus(id, isActive);
      if (!updatedReseller) {
        return res.status(404).json({ error: "Reseller not found" });
      }
      
      res.json({ reseller: updatedReseller });
    } catch (error) {
      console.error("Error toggling reseller status:", error);
      res.status(500).json({ error: "Failed to toggle reseller status" });
    }
  });

  // Delete reseller (admin only)
  app.delete("/api/admin/resellers/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteReseller(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting reseller:", error);
      res.status(500).json({ error: "Failed to delete reseller" });
    }
  });

  // Get reseller credit ledger (admin only)
  app.get("/api/admin/resellers/:id/ledger", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const ledger = await storage.getResellerCreditLedger(id);
      res.json({ ledger });
    } catch (error) {
      console.error("Error fetching reseller ledger:", error);
      res.status(500).json({ error: "Failed to fetch credit ledger" });
    }
  });

  // Get users created by reseller (admin only)
  app.get("/api/admin/resellers/:id/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const users = await storage.getResellerUsers(id);
      res.json({ users });
    } catch (error) {
      console.error("Error fetching reseller users:", error);
      res.status(500).json({ error: "Failed to fetch reseller users" });
    }
  });

  // ==================== FLOW COOKIES MANAGEMENT ====================

  // Get all flow cookies (admin only)
  app.get("/api/admin/flow-cookies", requireAuth, requireAdmin, async (req, res) => {
    try {
      const cookies = await storage.getAllFlowCookies();
      res.json({ cookies });
    } catch (error) {
      console.error("Error fetching flow cookies:", error);
      res.status(500).json({ error: "Failed to fetch flow cookies" });
    }
  });

  // Add single flow cookie (admin only)
  app.post("/api/admin/flow-cookies", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { label, cookieData } = req.body;
      if (!label || !cookieData) {
        return res.status(400).json({ error: "Label and cookie data are required" });
      }
      const cookie = await storage.addFlowCookie(label, cookieData);
      res.json({ cookie });
    } catch (error) {
      console.error("Error adding flow cookie:", error);
      res.status(500).json({ error: "Failed to add flow cookie" });
    }
  });

  // Bulk add flow cookies (admin only)
  app.post("/api/admin/flow-cookies/bulk", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { cookies } = req.body;
      if (!cookies) {
        return res.status(400).json({ error: "Cookies data is required" });
      }
      const addedCookies = await storage.bulkAddFlowCookies(cookies);
      res.json({ cookies: addedCookies, count: addedCookies.length });
    } catch (error) {
      console.error("Error bulk adding flow cookies:", error);
      res.status(500).json({ error: "Failed to bulk add flow cookies" });
    }
  });

  // Update flow cookie (admin only)
  app.patch("/api/admin/flow-cookies/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const cookie = await storage.updateFlowCookie(id, updates);
      if (!cookie) {
        return res.status(404).json({ error: "Flow cookie not found" });
      }
      res.json({ cookie });
    } catch (error) {
      console.error("Error updating flow cookie:", error);
      res.status(500).json({ error: "Failed to update flow cookie" });
    }
  });

  // Toggle flow cookie status (admin only)
  app.patch("/api/admin/flow-cookies/:id/toggle", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      const cookie = await storage.toggleFlowCookieStatus(id, isActive);
      if (!cookie) {
        return res.status(404).json({ error: "Flow cookie not found" });
      }
      res.json({ cookie });
    } catch (error) {
      console.error("Error toggling flow cookie status:", error);
      res.status(500).json({ error: "Failed to toggle flow cookie status" });
    }
  });

  // Delete flow cookie (admin only)
  app.delete("/api/admin/flow-cookies/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteFlowCookie(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting flow cookie:", error);
      res.status(500).json({ error: "Failed to delete flow cookie" });
    }
  });

  // Delete all flow cookies (admin only)
  app.delete("/api/admin/flow-cookies", requireAuth, requireAdmin, async (req, res) => {
    try {
      const count = await storage.deleteAllFlowCookies();
      res.json({ success: true, deletedCount: count });
    } catch (error) {
      console.error("Error deleting all flow cookies:", error);
      res.status(500).json({ error: "Failed to delete all flow cookies" });
    }
  });

  // Flow cookie validation endpoint removed - now using API tokens with Media API

  // ==================== ZYPHRA API ENDPOINTS (Admin Only) ====================
  
  // Get all Zyphra tokens
  app.get("/api/admin/zyphra-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const tokens = await import("./zyphra").then(m => m.getAllZyphraTokens());
      res.json({ tokens });
    } catch (error) {
      console.error("Error fetching Zyphra tokens:", error);
      res.status(500).json({ error: "Failed to fetch Zyphra tokens" });
    }
  });

  // Add single Zyphra token
  app.post("/api/admin/zyphra-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { apiKey, label, minutesLimit } = req.body;
      if (!apiKey || !label) {
        return res.status(400).json({ error: "API key and label are required" });
      }
      const zyphra = await import("./zyphra");
      const token = await zyphra.addZyphraToken(apiKey, label, minutesLimit || 100);
      res.json({ token: token[0] });
    } catch (error: any) {
      console.error("Error adding Zyphra token:", error);
      if (error.message?.includes("duplicate")) {
        return res.status(400).json({ error: "API key already exists" });
      }
      res.status(500).json({ error: "Failed to add Zyphra token" });
    }
  });

  // Bulk add Zyphra tokens
  app.post("/api/admin/zyphra-tokens/bulk", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { tokens: tokensInput } = req.body;
      if (!tokensInput) {
        return res.status(400).json({ error: "Tokens are required" });
      }
      
      const zyphra = await import("./zyphra");
      const lines = tokensInput.split("\n").filter((line: string) => line.trim());
      const added: any[] = [];
      const errors: string[] = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const parts = line.split(",").map((p: string) => p.trim());
        const apiKey = parts[0];
        const label = parts[1] || `Zyphra Key ${i + 1}`;
        const minutesLimit = parseInt(parts[2]) || 100;
        
        try {
          const token = await zyphra.addZyphraToken(apiKey, label, minutesLimit);
          added.push(token[0]);
        } catch (err: any) {
          errors.push(`Line ${i + 1}: ${err.message?.includes("duplicate") ? "Duplicate key" : "Failed to add"}`);
        }
      }
      
      res.json({ added, errors, totalAdded: added.length, totalErrors: errors.length });
    } catch (error) {
      console.error("Error bulk adding Zyphra tokens:", error);
      res.status(500).json({ error: "Failed to bulk add Zyphra tokens" });
    }
  });

  // Update Zyphra token
  app.patch("/api/admin/zyphra-tokens/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const zyphra = await import("./zyphra");
      const token = await zyphra.updateZyphraToken(id, updates);
      if (token.length === 0) {
        return res.status(404).json({ error: "Token not found" });
      }
      res.json({ token: token[0] });
    } catch (error) {
      console.error("Error updating Zyphra token:", error);
      res.status(500).json({ error: "Failed to update Zyphra token" });
    }
  });

  // Delete Zyphra token
  app.delete("/api/admin/zyphra-tokens/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const zyphra = await import("./zyphra");
      await zyphra.deleteZyphraToken(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting Zyphra token:", error);
      res.status(500).json({ error: "Failed to delete Zyphra token" });
    }
  });

  // Delete all Zyphra tokens
  app.delete("/api/admin/zyphra-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const zyphra = await import("./zyphra");
      await zyphra.deleteAllZyphraTokens();
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting all Zyphra tokens:", error);
      res.status(500).json({ error: "Failed to delete all Zyphra tokens" });
    }
  });

  // Reset all token usage
  app.post("/api/admin/zyphra-tokens/reset-usage", requireAuth, requireAdmin, async (req, res) => {
    try {
      const zyphra = await import("./zyphra");
      await zyphra.resetAllTokenUsage();
      res.json({ success: true });
    } catch (error) {
      console.error("Error resetting Zyphra token usage:", error);
      res.status(500).json({ error: "Failed to reset token usage" });
    }
  });

  // Reset individual token usage
  app.post("/api/admin/zyphra-tokens/:id/reset", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const zyphra = await import("./zyphra");
      await zyphra.resetTokenUsage(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error resetting Zyphra token usage:", error);
      res.status(500).json({ error: "Failed to reset token usage" });
    }
  });

  // Get Zyphra token stats (active/disabled counts)
  app.get("/api/admin/zyphra-tokens/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const zyphra = await import("./zyphra");
      const stats = await zyphra.getZyphraTokenStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting Zyphra token stats:", error);
      res.status(500).json({ error: "Failed to get token stats" });
    }
  });

  // Generate speech (Text-to-Speech) - Admin only
  app.post("/api/admin/zyphra/tts", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { text, speakingRate, model, languageIsoCode, mimeType, emotion, pitchStd, defaultVoiceName } = req.body;
      
      if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      if (text.length > 10000) {
        return res.status(400).json({ error: "Text exceeds 10,000 character limit" });
      }
      
      const zyphra = await import("./zyphra");
      const result = await zyphra.generateSpeechWithRetry({
        text,
        speakingRate,
        model,
        languageIsoCode,
        mimeType: mimeType || "audio/wav",
        emotion,
        pitchStd,
        defaultVoiceName,
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      
      // Store audio in cache and return an ID for streaming
      const audioId = crypto.randomUUID();
      audioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: result.mimeType || "audio/wav",
        timestamp: Date.now(),
        userId: req.session.userId!, // Admin-generated audio
      });
      
      // Get token remaining minutes
      let tokenRemaining = 0;
      let tokenLabel = "";
      if (result.tokenId) {
        const tokens = await zyphra.getAllZyphraTokens();
        const usedToken = tokens.find(t => t.id === result.tokenId);
        if (usedToken) {
          tokenRemaining = Math.max(0, usedToken.minutesLimit - usedToken.minutesUsed);
          tokenLabel = usedToken.label;
        }
      }
      
      res.json({ 
        success: true, 
        audioId,
        mimeType: result.mimeType,
        charactersUsed: result.charactersUsed || 0,
        tokenRemaining,
        tokenLabel
      });
    } catch (error) {
      console.error("Error generating speech:", error);
      res.status(500).json({ error: "Failed to generate speech" });
    }
  });

  // Stream audio by ID - Admin only
  app.get("/api/admin/zyphra/audio/:audioId", requireAuth, requireAdmin, (req, res) => {
    const { audioId } = req.params;
    const cached = audioCache.get(audioId);
    
    if (!cached) {
      return res.status(404).json({ error: "Audio not found or expired" });
    }
    
    res.setHeader("Content-Type", cached.mimeType);
    res.setHeader("Content-Length", cached.buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    res.send(cached.buffer);
  });

  // Voice cloning - Admin only
  app.post("/api/admin/zyphra/clone-voice", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { text, referenceAudioBase64, speakingRate, languageIsoCode, mimeType, model } = req.body;
      
      if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      if (text.length > 10000) {
        return res.status(400).json({ error: "Text exceeds 10,000 character limit" });
      }
      
      if (!referenceAudioBase64) {
        return res.status(400).json({ error: "Reference audio is required for voice cloning" });
      }
      
      // Check base64 size (10MB limit = ~13.3MB base64)
      const maxBase64Size = 10 * 1024 * 1024 * 1.33;
      if (referenceAudioBase64.length > maxBase64Size) {
        return res.status(400).json({ error: "Reference audio file exceeds 10MB limit" });
      }
      
      const zyphra = await import("./zyphra");
      const result = await zyphra.cloneVoiceWithRetry(text, referenceAudioBase64, {
        speakingRate,
        languageIsoCode,
        mimeType: mimeType || "audio/wav",
        model,
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      
      // Store audio in cache and return an ID for streaming
      const audioId = crypto.randomUUID();
      audioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: result.mimeType || "audio/wav",
        timestamp: Date.now(),
        userId: req.session.userId!, // Admin-generated audio
      });
      
      // Get token remaining minutes
      let tokenRemaining = 0;
      let tokenLabel = "";
      if (result.tokenId) {
        const tokens = await zyphra.getAllZyphraTokens();
        const usedToken = tokens.find(t => t.id === result.tokenId);
        if (usedToken) {
          tokenRemaining = Math.max(0, usedToken.minutesLimit - usedToken.minutesUsed);
          tokenLabel = usedToken.label;
        }
      }
      
      res.json({ 
        success: true, 
        audioId,
        mimeType: result.mimeType,
        charactersUsed: result.charactersUsed || 0,
        tokenRemaining,
        tokenLabel
      });
    } catch (error) {
      console.error("Error cloning voice:", error);
      res.status(500).json({ error: "Failed to clone voice" });
    }
  });

  // Get default voices and supported languages
  app.get("/api/admin/zyphra/voices", requireAuth, requireAdmin, async (req, res) => {
    try {
      const zyphra = await import("./zyphra");
      res.json({ 
        voices: zyphra.DEFAULT_VOICES,
        languages: zyphra.SUPPORTED_LANGUAGES 
      });
    } catch (error) {
      console.error("Error fetching voices:", error);
      res.status(500).json({ error: "Failed to fetch voices" });
    }
  });

  // ==================== CARTESIA API ENDPOINTS (Admin Only) ====================

  // Get all Cartesia tokens
  app.get("/api/admin/cartesia-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      const tokens = await cartesia.getAllCartesiaTokens();
      res.json(tokens);
    } catch (error) {
      console.error("Error fetching Cartesia tokens:", error);
      res.status(500).json({ error: "Failed to fetch Cartesia tokens" });
    }
  });

  // Add single Cartesia token
  app.post("/api/admin/cartesia-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { apiKey, label, charactersLimit } = req.body;
      if (!apiKey || !label) {
        return res.status(400).json({ error: "API key and label are required" });
      }
      const cartesia = await import("./cartesia");
      const token = await cartesia.addCartesiaToken(apiKey, label, charactersLimit || 20000);
      res.json(token);
    } catch (error: any) {
      console.error("Error adding Cartesia token:", error);
      if (error.message?.includes("duplicate")) {
        return res.status(400).json({ error: "API key already exists" });
      }
      res.status(500).json({ error: "Failed to add Cartesia token" });
    }
  });

  // Bulk add Cartesia tokens
  app.post("/api/admin/cartesia-tokens/bulk", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { tokens: tokensText, charactersLimit } = req.body;
      if (!tokensText) {
        return res.status(400).json({ error: "Tokens text is required" });
      }
      const cartesia = await import("./cartesia");
      const lines = tokensText.split("\n").filter((l: string) => l.trim());
      const results = { added: 0, failed: 0, errors: [] as string[] };
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const parts = line.split(",").map((p: string) => p.trim());
        const apiKey = parts[0];
        const label = parts[1] || `Cartesia Key ${i + 1}`;
        
        try {
          await cartesia.addCartesiaToken(apiKey, label, charactersLimit || 20000);
          results.added++;
        } catch (e: any) {
          results.failed++;
          results.errors.push(`Line ${i + 1}: ${e.message}`);
        }
      }
      
      res.json(results);
    } catch (error) {
      console.error("Error bulk adding Cartesia tokens:", error);
      res.status(500).json({ error: "Failed to bulk add Cartesia tokens" });
    }
  });

  // Update Cartesia token
  app.patch("/api/admin/cartesia-tokens/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const cartesia = await import("./cartesia");
      const token = await cartesia.updateCartesiaToken(id, updates);
      if (!token) {
        return res.status(404).json({ error: "Token not found" });
      }
      res.json(token);
    } catch (error) {
      console.error("Error updating Cartesia token:", error);
      res.status(500).json({ error: "Failed to update Cartesia token" });
    }
  });

  // Delete Cartesia token
  app.delete("/api/admin/cartesia-tokens/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const cartesia = await import("./cartesia");
      await cartesia.deleteCartesiaToken(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting Cartesia token:", error);
      res.status(500).json({ error: "Failed to delete Cartesia token" });
    }
  });

  // Delete all Cartesia tokens
  app.delete("/api/admin/cartesia-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      await cartesia.deleteAllCartesiaTokens();
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting all Cartesia tokens:", error);
      res.status(500).json({ error: "Failed to delete all Cartesia tokens" });
    }
  });

  // Reset all Cartesia token usage
  app.post("/api/admin/cartesia-tokens/reset-usage", requireAuth, requireAdmin, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      await cartesia.resetAllTokenUsage();
      res.json({ success: true });
    } catch (error) {
      console.error("Error resetting Cartesia token usage:", error);
      res.status(500).json({ error: "Failed to reset token usage" });
    }
  });

  // Reset single Cartesia token usage
  app.post("/api/admin/cartesia-tokens/:id/reset", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const cartesia = await import("./cartesia");
      await cartesia.resetTokenUsage(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error resetting Cartesia token usage:", error);
      res.status(500).json({ error: "Failed to reset token usage" });
    }
  });

  // Get Cartesia token stats
  app.get("/api/admin/cartesia-tokens/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      const stats = await cartesia.getCartesiaTokenStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting Cartesia token stats:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  // Get Cartesia voices
  app.get("/api/admin/cartesia/voices", requireAuth, requireAdmin, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      res.json({ 
        voices: cartesia.CARTESIA_VOICES,
        languages: cartesia.CARTESIA_LANGUAGES 
      });
    } catch (error) {
      console.error("Error fetching Cartesia voices:", error);
      res.status(500).json({ error: "Failed to fetch voices" });
    }
  });

  // ==================== VEO3 TTS USER ENDPOINTS (All Authenticated Users) ====================
  
  // Get voices and languages (for all users)
  app.get("/api/veo3_tts/voices", requireAuth, async (req, res) => {
    try {
      const zyphra = await import("./zyphra");
      res.json({ 
        voices: zyphra.DEFAULT_VOICES,
        languages: zyphra.SUPPORTED_LANGUAGES 
      });
    } catch (error) {
      console.error("Error fetching voices:", error);
      res.status(500).json({ error: "Failed to fetch voices" });
    }
  });

  // Text-to-Speech for all users
  app.post("/api/veo3_tts/tts", requireAuth, async (req, res) => {
    try {
      // Check and reset voice characters if needed
      const freshUser = await storage.checkAndResetVoiceCharacters(req.session.userId!);
      if (!freshUser) {
        return res.status(401).json({ error: "User not found" });
      }
      
      // Check plan access for voice tools
      const toolCheck = canAccessTool(freshUser, "voiceTools");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }
      
      const { text, speakingRate, languageIsoCode, defaultVoiceName, mimeType } = req.body;
      
      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      // Limit text length based on user's plan
      const maxRequestChars = getPerRequestCharLimit(freshUser);
      if (text.length > maxRequestChars) {
        return res.status(400).json({ error: `Text exceeds maximum length of ${maxRequestChars.toLocaleString()} characters for your plan` });
      }
      
      // Check voice character limit
      const charCheck = canUseVoiceCharacters(freshUser, text.length);
      if (!charCheck.allowed) {
        return res.status(403).json({ error: charCheck.reason });
      }
      
      const zyphra = await import("./zyphra");
      const result = await zyphra.generateSpeechWithRetry({
        text,
        speakingRate: speakingRate || 15,
        languageIsoCode: languageIsoCode || "en-us",
        defaultVoiceName: defaultVoiceName || "American Female",
        mimeType: mimeType || "audio/wav",
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      
      // Increment voice character usage after successful generation
      await storage.incrementVoiceCharacters(req.session.userId!, text.length);
      
      // Store audio in cache and return an ID for streaming (includes userId for ownership)
      const audioId = crypto.randomUUID();
      audioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: result.mimeType || "audio/wav",
        timestamp: Date.now(),
        userId: req.session.userId!,
      });
      
      // Get updated usage for response
      const updatedUser = await storage.getUser(req.session.userId!);
      const usage = updatedUser ? getVoiceCharacterUsage(updatedUser) : null;
      
      console.log(`[Voice TTS] User: ${freshUser.username} (Plan: ${freshUser.planType}) generated audio, chars: ${text.length}`);
      
      res.json({ 
        success: true, 
        audioId,
        mimeType: result.mimeType,
        charactersUsed: result.charactersUsed || 0,
        voiceCharacterUsage: usage,
      });
    } catch (error) {
      console.error("Error generating speech:", error);
      res.status(500).json({ error: "Failed to generate speech" });
    }
  });

  // Get audio file for all users - validates ownership
  app.get("/api/veo3_tts/audio/:audioId", requireAuth, (req, res) => {
    const { audioId } = req.params;
    const cached = audioCache.get(audioId);
    
    if (!cached) {
      return res.status(404).json({ error: "Audio not found or expired" });
    }
    
    // Validate ownership - user can only access their own audio
    if (cached.userId !== req.session.userId) {
      console.warn(`[Security] User ${req.session.userId} attempted to access audio owned by ${cached.userId}`);
      return res.status(403).json({ error: "Access denied" });
    }
    
    res.setHeader("Content-Type", cached.mimeType);
    const ext = cached.mimeType.split("/")[1] || "wav";
    res.setHeader("Content-Disposition", `attachment; filename="speech.${ext}"`);
    res.send(cached.buffer);
  });

  // Voice cloning for all users
  app.post("/api/veo3_tts/clone-voice", requireAuth, async (req, res) => {
    try {
      // Check and reset voice characters if needed
      const freshUser = await storage.checkAndResetVoiceCharacters(req.session.userId!);
      if (!freshUser) {
        return res.status(401).json({ error: "User not found" });
      }
      
      // Check plan access for voice tools
      const toolCheck = canAccessTool(freshUser, "voiceTools");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }
      
      const { text, referenceAudioBase64, speakingRate, languageIsoCode, mimeType, model } = req.body;
      
      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      // Limit text length based on user's plan
      const maxRequestChars = getPerRequestCharLimit(freshUser);
      if (text.length > maxRequestChars) {
        return res.status(400).json({ error: `Text exceeds maximum length of ${maxRequestChars.toLocaleString()} characters for your plan` });
      }
      
      // Check voice character limit
      const charCheck = canUseVoiceCharacters(freshUser, text.length);
      if (!charCheck.allowed) {
        return res.status(403).json({ error: charCheck.reason });
      }
      
      if (!referenceAudioBase64) {
        return res.status(400).json({ error: "Reference audio is required for voice cloning" });
      }
      
      // Check base64 size (10MB limit = ~13.3MB base64)
      const maxBase64Size = 10 * 1024 * 1024 * 1.33;
      if (referenceAudioBase64.length > maxBase64Size) {
        return res.status(400).json({ error: "Reference audio file exceeds 10MB limit" });
      }
      
      const zyphra = await import("./zyphra");
      const result = await zyphra.cloneVoiceWithRetry(text, referenceAudioBase64, {
        speakingRate,
        languageIsoCode,
        mimeType: mimeType || "audio/wav",
        model,
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      
      // Increment voice character usage after successful generation
      await storage.incrementVoiceCharacters(req.session.userId!, text.length);
      
      // Store audio in cache and return an ID for streaming (includes userId for ownership)
      const audioId = crypto.randomUUID();
      audioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: result.mimeType || "audio/wav",
        timestamp: Date.now(),
        userId: req.session.userId!,
      });
      
      // Get updated usage for response
      const updatedUser = await storage.getUser(req.session.userId!);
      const usage = updatedUser ? getVoiceCharacterUsage(updatedUser) : null;
      
      console.log(`[Voice Cloning] User: ${freshUser.username} (Plan: ${freshUser.planType}) cloned voice, chars: ${text.length}`);
      
      res.json({ 
        success: true, 
        audioId,
        mimeType: result.mimeType,
        charactersUsed: result.charactersUsed || 0,
        voiceCharacterUsage: usage,
      });
    } catch (error) {
      console.error("Error cloning voice:", error);
      res.status(500).json({ error: "Failed to clone voice" });
    }
  });

  // ==================== CARTESIA TTS V2 ENDPOINTS (All Users) ====================
  
  // TTS V2 Audio cache
  const ttsV2AudioCache = new Map<string, { buffer: Buffer; mimeType: string; userId: string; createdAt: number }>();
  
  // Cleanup expired TTS V2 audio cache entries every 10 minutes
  setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    const keysToDelete: string[] = [];
    ttsV2AudioCache.forEach((data, id) => {
      if (now - data.createdAt > maxAge) {
        keysToDelete.push(id);
      }
    });
    keysToDelete.forEach(id => ttsV2AudioCache.delete(id));
  }, 10 * 60 * 1000);

  // Get available Cartesia voices
  app.get("/api/tts-v2/voices", requireAuth, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      const result = await cartesia.listVoices();
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to list voices" });
      }
      
      res.json({ voices: result.voices });
    } catch (error) {
      console.error("[TTS V2] Error listing voices:", error);
      res.status(500).json({ error: "Failed to list voices" });
    }
  });

  // Synthesize speech with Cartesia API (uses token rotation)
  app.post("/api/tts-v2/synthesize", requireAuth, async (req, res) => {
    try {
      const { text, voiceId, language, speed, emotion } = req.body;
      
      if (!text || !text.trim()) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      if (text.length > 10000) {
        return res.status(400).json({ error: "Text exceeds maximum length of 10,000 characters" });
      }
      
      if (!voiceId) {
        return res.status(400).json({ error: "Voice ID is required" });
      }
      
      const cartesia = await import("./cartesia");
      const speedMap: Record<string, "slowest" | "slow" | "normal" | "fast" | "fastest"> = {
        "slow": "slow",
        "normal": "normal", 
        "fast": "fast"
      };
      
      const result = await cartesia.generateSpeechWithRetry({
        text,
        voiceId,
        language: language || "en",
        speed: speedMap[speed] || "normal",
        emotion: emotion ? [emotion + ":high"] : undefined
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to synthesize speech" });
      }
      
      const audioId = crypto.randomUUID();
      
      ttsV2AudioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: "audio/mpeg",
        userId: req.session.userId!,
        createdAt: Date.now(),
      });
      
      // Track character usage for this user
      await storage.incrementVoiceCharacters(req.session.userId!, text.length);
      
      console.log(`[TTS V2] Cartesia generated audio for user, chars: ${text.length}, voice: ${voiceId}`);
      
      res.json({
        success: true,
        audioId,
        mimeType: "audio/mpeg",
        charactersUsed: text.length,
      });
    } catch (error: any) {
      console.error("[TTS V2] Error synthesizing speech:", error);
      res.status(500).json({ error: error.message || "Failed to synthesize speech" });
    }
  });

  // Get TTS V2 audio file
  app.get("/api/tts-v2/audio/:audioId", requireAuth, (req, res) => {
    const { audioId } = req.params;
    const cached = ttsV2AudioCache.get(audioId);
    
    if (!cached) {
      return res.status(404).json({ error: "Audio not found or expired" });
    }
    
    if (cached.userId !== req.session.userId) {
      return res.status(403).json({ error: "Access denied" });
    }
    
    res.setHeader("Content-Type", cached.mimeType);
    const ext = cached.mimeType === "audio/mpeg" ? "mp3" : cached.mimeType === "audio/wav" ? "wav" : "ogg";
    res.setHeader("Content-Disposition", `attachment; filename="tts-v2.${ext}"`);
    res.send(cached.buffer);
  });

  // ==================== VOICE CLONING V2 (CARTESIA) ====================
  
  // Get user's cloned voices (uses token rotation)
  app.get("/api/voice-cloning-v2/my-voices", requireAuth, async (req, res) => {
    try {
      const cartesia = await import("./cartesia");
      const result = await cartesia.listVoices();
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to list voices" });
      }
      
      const myVoices = (result.voices || []).filter((v: any) => !v.is_public);
      res.json({ voices: myVoices });
    } catch (error) {
      console.error("[Voice Clone V2] Error fetching voices:", error);
      res.status(500).json({ error: "Failed to fetch cloned voices" });
    }
  });

  // Clone a voice from audio (uses token rotation)
  app.post("/api/voice-cloning-v2/clone", requireAuth, async (req, res) => {
    try {
      const multerLib = await import("multer");
      const upload = multerLib.default({ 
        storage: multerLib.default.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 }
      }).single("clip");
      
      upload(req as any, res as any, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: "Failed to upload file: " + err.message });
        }
        
        const file = (req as any).file;
        if (!file) {
          return res.status(400).json({ error: "No audio file provided" });
        }
        
        const { name, description, language, mode, enhance } = req.body;
        
        if (!name || !name.trim()) {
          return res.status(400).json({ error: "Voice name is required" });
        }
        
        try {
          const cartesia = await import("./cartesia");
          const result = await cartesia.cloneVoiceWithRetry({
            clip: file.buffer,
            name,
            description,
            language: language || "en",
            mode: mode || "similarity",
            enhance: enhance === "true"
          });
          
          if (!result.success) {
            return res.status(500).json({ error: result.error || "Failed to clone voice" });
          }
          
          console.log(`[Voice Clone V2] Voice cloned successfully: ${result.voice?.id} - ${name}`);
          
          res.json({
            success: true,
            voice: {
              id: result.voice?.id,
              name: result.voice?.name,
              description: result.voice?.description,
              language: result.voice?.language,
            },
          });
        } catch (cloneError: any) {
          console.error("[Voice Clone V2] Clone error:", cloneError);
          res.status(500).json({ error: cloneError.message || "Failed to clone voice" });
        }
      });
    } catch (error: any) {
      console.error("[Voice Clone V2] Error:", error);
      res.status(500).json({ error: error.message || "Failed to clone voice" });
    }
  });

  // Test cloned voice (uses token rotation)
  app.post("/api/voice-cloning-v2/test", requireAuth, async (req, res) => {
    try {
      const { voiceId, text } = req.body;
      
      if (!voiceId || !text?.trim()) {
        return res.status(400).json({ error: "Voice ID and text are required" });
      }
      
      const cartesia = await import("./cartesia");
      const result = await cartesia.generateSpeechWithRetry({
        text,
        voiceId,
        language: "en",
        speed: "normal"
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to generate test audio" });
      }
      
      const audioId = crypto.randomUUID();
      
      ttsV2AudioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: "audio/mpeg",
        userId: req.session.userId!,
        createdAt: Date.now(),
      });
      
      console.log(`[Voice Clone V2] Test audio generated for voice ${voiceId}`);
      
      res.json({ success: true, audioId });
    } catch (error: any) {
      console.error("[Voice Clone V2] Test error:", error);
      res.status(500).json({ error: error.message || "Failed to generate test audio" });
    }
  });

  // Delete cloned voice (uses token rotation)
  app.delete("/api/voice-cloning-v2/voice/:voiceId", requireAuth, async (req, res) => {
    try {
      const { voiceId } = req.params;
      
      const cartesia = await import("./cartesia");
      const result = await cartesia.deleteVoice(voiceId);
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to delete voice" });
      }
      
      console.log(`[Voice Clone V2] Voice deleted: ${voiceId}`);
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Voice Clone V2] Delete error:", error);
      res.status(500).json({ error: error.message || "Failed to delete voice" });
    }
  });

  // ==================== TOP VOICES ENDPOINTS ====================
  
  // Get all top voices (for users) - only active ones
  app.get("/api/top-voices", requireAuth, async (req, res) => {
    try {
      const { topVoices } = await import("@shared/schema");
      const voices = await db
        .select()
        .from(topVoices)
        .where(eq(topVoices.isActive, true))
        .orderBy(topVoices.sortOrder);
      res.json(voices);
    } catch (error) {
      console.error("Error fetching top voices:", error);
      res.status(500).json({ error: "Failed to fetch top voices" });
    }
  });

  // Admin: Get all top voices (including inactive)
  app.get("/api/admin/top-voices", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { topVoices } = await import("@shared/schema");
      const voices = await db
        .select()
        .from(topVoices)
        .orderBy(topVoices.sortOrder);
      res.json(voices);
    } catch (error) {
      console.error("Error fetching top voices:", error);
      res.status(500).json({ error: "Failed to fetch top voices" });
    }
  });

  // Admin: Add new top voice
  app.post("/api/admin/top-voices", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { topVoices } = await import("@shared/schema");
      const { name, description, demoAudioUrl, demoAudioBase64, sortOrder } = req.body;
      
      if (!name || !demoAudioUrl) {
        return res.status(400).json({ error: "Name and demo audio URL are required" });
      }
      
      const [voice] = await db
        .insert(topVoices)
        .values({
          name,
          description: description || null,
          demoAudioUrl,
          demoAudioBase64: demoAudioBase64 || null,
          sortOrder: sortOrder || 0,
        })
        .returning();
      
      res.json(voice);
    } catch (error) {
      console.error("Error adding top voice:", error);
      res.status(500).json({ error: "Failed to add top voice" });
    }
  });

  // Admin: Update top voice
  app.patch("/api/admin/top-voices/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { topVoices } = await import("@shared/schema");
      const { id } = req.params;
      const updates = req.body;
      
      const [voice] = await db
        .update(topVoices)
        .set(updates)
        .where(eq(topVoices.id, id))
        .returning();
      
      if (!voice) {
        return res.status(404).json({ error: "Voice not found" });
      }
      
      res.json(voice);
    } catch (error) {
      console.error("Error updating top voice:", error);
      res.status(500).json({ error: "Failed to update top voice" });
    }
  });

  // Admin: Delete top voice
  app.delete("/api/admin/top-voices/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { topVoices } = await import("@shared/schema");
      const { id } = req.params;
      
      await db.delete(topVoices).where(eq(topVoices.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting top voice:", error);
      res.status(500).json({ error: "Failed to delete top voice" });
    }
  });

  // Generate audio from top voice - uses voice cloning
  app.post("/api/top-voices/:id/generate", requireAuth, async (req, res) => {
    try {
      // Check and reset voice characters if needed
      const freshUser = await storage.checkAndResetVoiceCharacters(req.session.userId!);
      if (!freshUser) {
        return res.status(401).json({ error: "User not found" });
      }
      
      const toolCheck = canAccessTool(freshUser, "voiceTools");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }
      
      const { topVoices } = await import("@shared/schema");
      const { id } = req.params;
      const { text, speakingRate, languageIsoCode } = req.body;
      
      if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      // Limit text length based on user's plan
      const maxRequestChars = getPerRequestCharLimit(freshUser);
      if (text.length > maxRequestChars) {
        return res.status(400).json({ error: `Text exceeds maximum length of ${maxRequestChars.toLocaleString()} characters for your plan` });
      }
      
      // Check voice character limit
      const charCheck = canUseVoiceCharacters(freshUser, text.length);
      if (!charCheck.allowed) {
        return res.status(403).json({ error: charCheck.reason });
      }
      
      // Get the voice
      const [voice] = await db
        .select()
        .from(topVoices)
        .where(eq(topVoices.id, id));
      
      if (!voice || !voice.isActive) {
        return res.status(404).json({ error: "Voice not found" });
      }
      
      // Get the demo audio for cloning
      let referenceAudioBase64 = voice.demoAudioBase64;
      
      // If no cached base64, fetch from URL
      if (!referenceAudioBase64 && voice.demoAudioUrl) {
        try {
          const response = await fetch(voice.demoAudioUrl);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            referenceAudioBase64 = Buffer.from(arrayBuffer).toString('base64');
          }
        } catch (fetchError) {
          console.error("Error fetching demo audio:", fetchError);
          return res.status(500).json({ error: "Failed to fetch demo audio for cloning" });
        }
      }
      
      if (!referenceAudioBase64) {
        return res.status(500).json({ error: "No demo audio available for cloning" });
      }
      
      // Clone voice using Zyphra with silent retry
      const zyphra = await import("./zyphra");
      const result = await zyphra.cloneVoiceWithRetry(text, referenceAudioBase64, {
        speakingRate,
        languageIsoCode,
        mimeType: "audio/wav",
      });
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }
      
      // Increment voice character usage after successful generation
      await storage.incrementVoiceCharacters(req.session.userId!, text.length);
      
      // Store audio in cache with userId for ownership
      const audioId = crypto.randomUUID();
      audioCache.set(audioId, {
        buffer: result.audioData!,
        mimeType: result.mimeType || "audio/wav",
        timestamp: Date.now(),
        userId: req.session.userId!,
      });
      
      // Get updated usage for response
      const updatedUser = await storage.getUser(req.session.userId!);
      const usage = updatedUser ? getVoiceCharacterUsage(updatedUser) : null;
      
      console.log(`[Top Voice] User: ${freshUser.username} (Plan: ${freshUser.planType}) generated audio, chars: ${text.length}`);
      
      res.json({ 
        success: true, 
        audioId,
        mimeType: result.mimeType,
        voiceName: voice.name,
        voiceCharacterUsage: usage,
      });
    } catch (error) {
      console.error("Error generating from top voice:", error);
      res.status(500).json({ error: "Failed to generate audio" });
    }
  });

  // Stream top voice audio by ID - validates ownership
  app.get("/api/top-voices/audio/:audioId", requireAuth, (req, res) => {
    const { audioId } = req.params;
    const cached = audioCache.get(audioId);
    
    if (!cached) {
      return res.status(404).json({ error: "Audio not found or expired" });
    }
    
    // Validate ownership - user can only access their own audio
    if (cached.userId !== req.session.userId) {
      console.warn(`[Security] User ${req.session.userId} attempted to access top voice audio owned by ${cached.userId}`);
      return res.status(403).json({ error: "Access denied" });
    }
    
    res.setHeader("Content-Type", cached.mimeType);
    res.setHeader("Content-Length", cached.buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    res.send(cached.buffer);
  });

  // ==================== COMMUNITY VOICES ENDPOINTS ====================

  // Get all community voices (WITHOUT audio data for fast loading)
  app.get("/api/community-voices", requireAuth, async (req, res) => {
    try {
      const voices = await storage.getAllCommunityVoicesLite();
      const userId = req.session.userId;
      const likedIds = userId ? await storage.getUserLikedVoiceIds(userId) : [];
      res.json({ voices, likedIds });
    } catch (error) {
      console.error("Error fetching community voices:", error);
      res.status(500).json({ error: "Failed to fetch community voices" });
    }
  });

  // Get top community voices by likes (WITHOUT audio data for fast loading)
  app.get("/api/community-voices/top", requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const voices = await storage.getTopCommunityVoicesLite(limit);
      const userId = req.session.userId;
      const likedIds = userId ? await storage.getUserLikedVoiceIds(userId) : [];
      res.json({ voices, likedIds });
    } catch (error) {
      console.error("Error fetching top community voices:", error);
      res.status(500).json({ error: "Failed to fetch top community voices" });
    }
  });

  // Stream community voice demo audio by voice ID
  app.get("/api/community-voices/:id/audio", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const voice = await storage.getCommunityVoiceById(id);
      
      if (!voice) {
        return res.status(404).json({ error: "Voice not found" });
      }
      
      if (!voice.demoAudioBase64) {
        return res.status(404).json({ error: "No audio available" });
      }
      
      const audioBuffer = Buffer.from(voice.demoAudioBase64, "base64");
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24 hours
      res.send(audioBuffer);
    } catch (error) {
      console.error("Error streaming community voice audio:", error);
      res.status(500).json({ error: "Failed to stream audio" });
    }
  });

  // Create a new community voice
  app.post("/api/community-voices", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      const { name, description, language, gender, demoAudioBase64 } = req.body;

      // Validate required fields
      if (!name || name.length < 2) {
        return res.status(400).json({ error: "Name must be at least 2 characters" });
      }
      if (!demoAudioBase64) {
        return res.status(400).json({ error: "Demo audio is required" });
      }
      if (!language) {
        return res.status(400).json({ error: "Language is required" });
      }
      if (!gender || !["Male", "Female"].includes(gender)) {
        return res.status(400).json({ error: "Gender must be Male or Female" });
      }

      // Server-side validation: compute actual file size from base64 data
      const audioBuffer = Buffer.from(demoAudioBase64, "base64");
      const actualFileSizeBytes = audioBuffer.length;
      if (actualFileSizeBytes > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "File must be less than 5MB" });
      }

      // Server-side validation: parse audio to get actual duration
      let actualDurationSeconds = 0;
      try {
        const mm = await import("music-metadata");
        const metadata = await mm.parseBuffer(audioBuffer);
        actualDurationSeconds = metadata.format.duration || 0;
      } catch (parseError) {
        console.error("Error parsing audio metadata:", parseError);
        return res.status(400).json({ error: "Could not parse audio file. Please upload a valid audio file." });
      }

      if (actualDurationSeconds < 10) {
        return res.status(400).json({ error: `Audio must be at least 10 seconds (detected: ${actualDurationSeconds.toFixed(1)}s)` });
      }

      const voice = await storage.createCommunityVoice(
        { name, description, language, gender, demoAudioBase64, durationSeconds: Math.floor(actualDurationSeconds), fileSizeBytes: actualFileSizeBytes },
        userId,
        user.username
      );

      res.json({ success: true, voice });
    } catch (error) {
      console.error("Error creating community voice:", error);
      res.status(500).json({ error: "Failed to create community voice" });
    }
  });

  // Toggle like on a community voice
  app.post("/api/community-voices/:id/like", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const voiceId = req.params.id;
      const voice = await storage.getCommunityVoiceById(voiceId);
      if (!voice) {
        return res.status(404).json({ error: "Voice not found" });
      }

      const result = await storage.toggleCommunityVoiceLike(voiceId, userId);
      res.json(result);
    } catch (error) {
      console.error("Error toggling like:", error);
      res.status(500).json({ error: "Failed to toggle like" });
    }
  });

  // Delete a community voice (creator or admin only)
  app.delete("/api/community-voices/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const voiceId = req.params.id;
      const voice = await storage.getCommunityVoiceById(voiceId);
      if (!voice) {
        return res.status(404).json({ error: "Voice not found" });
      }

      const user = await storage.getUser(userId);
      if (voice.creatorId !== userId && !user?.isAdmin) {
        return res.status(403).json({ error: "Not authorized to delete this voice" });
      }

      await storage.deleteCommunityVoice(voiceId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting community voice:", error);
      res.status(500).json({ error: "Failed to delete community voice" });
    }
  });

  // Generate TTS using a community voice
  app.post("/api/community-voices/:id/generate", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      // Check and reset voice characters if needed
      const freshUser = await storage.checkAndResetVoiceCharacters(userId);
      if (!freshUser) {
        return res.status(401).json({ error: "User not found" });
      }
      
      const toolCheck = canAccessTool(freshUser, "voiceTools");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const voiceId = req.params.id;
      const voice = await storage.getCommunityVoiceById(voiceId);
      if (!voice) {
        return res.status(404).json({ error: "Voice not found" });
      }

      const { text, speakingRate = 10, mimeType } = req.body;
      if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: "Text is required" });
      }
      
      // Limit text length based on user's plan
      const maxRequestChars = getPerRequestCharLimit(freshUser);
      if (text.length > maxRequestChars) {
        return res.status(400).json({ error: `Text exceeds maximum length of ${maxRequestChars.toLocaleString()} characters for your plan` });
      }
      
      // Check voice character limit
      const charCheck = canUseVoiceCharacters(freshUser, text.length);
      if (!charCheck.allowed) {
        return res.status(403).json({ error: charCheck.reason });
      }

      const zyphra = await import("./zyphra");
      
      // Use the voice's demo audio as reference for voice cloning with silent retry
      const result = await zyphra.cloneVoiceWithRetry(text, voice.demoAudioBase64, {
        speakingRate,
        languageIsoCode: "en-us",
        mimeType: mimeType || "audio/wav",
        model: "zonos-v0.1-transformer",
      });

      if (!result.success || !result.audioData) {
        return res.status(500).json({ error: result.error || "Failed to generate audio" });
      }
      
      // Increment voice character usage after successful generation
      await storage.incrementVoiceCharacters(userId, text.length);

      // Store audio in cache with userId for ownership
      const audioId = `community_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      audioCache.set(audioId, {
        buffer: result.audioData,
        mimeType: result.mimeType || "audio/wav",
        timestamp: Date.now(),
        userId: req.session.userId!,
      });
      
      // Get updated usage for response
      const updatedUser = await storage.getUser(userId);
      const usage = updatedUser ? getVoiceCharacterUsage(updatedUser) : null;
      
      console.log(`[Community Voice] User: ${freshUser.username} (Plan: ${freshUser.planType}) generated audio, chars: ${text.length}`);

      res.json({
        success: true,
        audioId,
        mimeType: result.mimeType,
        voiceName: voice.name,
        voiceCharacterUsage: usage,
      });
    } catch (error) {
      console.error("Error generating from community voice:", error);
      res.status(500).json({ error: "Failed to generate audio" });
    }
  });

  // Stream community voice audio by ID - validates ownership
  app.get("/api/community-voices/audio/:audioId", requireAuth, (req, res) => {
    const { audioId } = req.params;
    const cached = audioCache.get(audioId);

    if (!cached) {
      return res.status(404).json({ error: "Audio not found or expired" });
    }
    
    // Validate ownership - user can only access their own audio
    if (cached.userId !== req.session.userId) {
      console.warn(`[Security] User ${req.session.userId} attempted to access community voice audio owned by ${cached.userId}`);
      return res.status(403).json({ error: "Access denied" });
    }

    res.setHeader("Content-Type", cached.mimeType);
    res.setHeader("Content-Length", cached.buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    res.send(cached.buffer);
  });

  // ==================== RESELLER PORTAL ENDPOINTS ====================

  // Reseller login
  app.post("/api/reseller/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      const reseller = await storage.getResellerByUsername(username);
      if (!reseller) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!reseller.isActive) {
        return res.status(403).json({ error: "Account is inactive" });
      }

      const isValidPassword = await storage.verifyResellerPassword(reseller, password);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Set reseller session
      req.session.resellerId = reseller.id;
      req.session.isReseller = true;
      
      res.json({ 
        reseller: { 
          id: reseller.id, 
          username: reseller.username, 
          creditBalance: reseller.creditBalance,
          isActive: reseller.isActive
        } 
      });
    } catch (error) {
      console.error("Reseller login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Reseller logout
  app.post("/api/reseller/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
    });
  });

  // Get reseller session
  app.get("/api/reseller/session", async (req, res) => {
    try {
      if (!req.session.resellerId || !req.session.isReseller) {
        return res.json({ authenticated: false });
      }

      const reseller = await storage.getResellerById(req.session.resellerId);
      if (!reseller || !reseller.isActive) {
        req.session.destroy(() => {});
        return res.json({ authenticated: false });
      }

      res.json({ 
        authenticated: true, 
        reseller: { 
          id: reseller.id, 
          username: reseller.username, 
          creditBalance: reseller.creditBalance 
        } 
      });
    } catch (error) {
      console.error("Error getting reseller session:", error);
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  // Reseller auth middleware
  const requireReseller = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.resellerId || !req.session.isReseller) {
      return res.status(401).json({ error: "Reseller authentication required" });
    }

    const reseller = await storage.getResellerById(req.session.resellerId);
    if (!reseller) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: "Session expired" });
    }

    if (!reseller.isActive) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Account is inactive" });
    }

    next();
  };

  // Get reseller's credit balance
  app.get("/api/reseller/credits", requireReseller, async (req, res) => {
    try {
      const reseller = await storage.getResellerById(req.session.resellerId!);
      if (!reseller) {
        return res.status(404).json({ error: "Reseller not found" });
      }
      res.json({ creditBalance: reseller.creditBalance });
    } catch (error) {
      console.error("Error fetching reseller credits:", error);
      res.status(500).json({ error: "Failed to fetch credits" });
    }
  });

  // Get reseller's credit ledger
  app.get("/api/reseller/ledger", requireReseller, async (req, res) => {
    try {
      const ledger = await storage.getResellerCreditLedger(req.session.resellerId!);
      res.json({ ledger });
    } catch (error) {
      console.error("Error fetching reseller ledger:", error);
      res.status(500).json({ error: "Failed to fetch ledger" });
    }
  });

  // Get users created by this reseller
  app.get("/api/reseller/users", requireReseller, async (req, res) => {
    try {
      const users = await storage.getResellerUsers(req.session.resellerId!);
      res.json({ users });
    } catch (error) {
      console.error("Error fetching reseller users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Create user as reseller
  app.post("/api/reseller/users", requireReseller, async (req, res) => {
    try {
      const { username, password, planType } = req.body;
      
      if (!username || !password || !planType) {
        return res.status(400).json({ error: "Username, password, and plan type are required" });
      }

      if (planType !== "scale" && planType !== "empire") {
        return res.status(400).json({ error: "Plan type must be 'scale' or 'empire'" });
      }

      const result = await storage.createUserByReseller(req.session.resellerId!, {
        username,
        password,
        planType,
      });

      res.json({ 
        user: { 
          id: result.user.id, 
          username: result.user.username, 
          planType: result.user.planType 
        },
        creditCost: result.resellerUser.creditCost
      });
    } catch (error: any) {
      console.error("Error creating user by reseller:", error);
      if (error.message.includes("Insufficient credits")) {
        return res.status(400).json({ error: error.message });
      }
      if (error.message === "Username already exists") {
        return res.status(400).json({ error: "Username already exists" });
      }
      if (error.message === "Reseller account is inactive") {
        return res.status(403).json({ error: "Your account is inactive" });
      }
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Video history endpoints
  app.get("/api/admin/video-history", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Add pagination support - default limit 100, max 500
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      
      const videos = await db
        .select()
        .from(videoHistory)
        .orderBy(desc(videoHistory.createdAt))
        .limit(limit)
        .offset(offset);
      
      res.json({ videos, limit, offset });
    } catch (error) {
      console.error("Error fetching all video history:", error);
      res.status(500).json({ 
        error: "Failed to fetch video history",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/video-history", requireAuth, async (req, res) => {
    const startTime = Date.now();
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      console.log(`[VideoHistory] Starting query for user ${userId}`);

      // Prevent caching to ensure fresh data on every request
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // Allow up to 500 videos for bulk generation batches
      const limit = Math.min(parseInt(req.query.limit as string) || 500, 500);
      const offset = parseInt(req.query.offset as string) || 0;

      // Optimized query - select only essential columns (exclude metadata, referenceImageUrl which are huge)
      // FIXED: Sort by createdAt DESC first (most recent batch), then by sceneNumber ASC (sequence within batch)
      const videos = await db
        .select({
          id: videoHistory.id,
          prompt: videoHistory.prompt,
          videoUrl: videoHistory.videoUrl,
          status: videoHistory.status,
          createdAt: videoHistory.createdAt,
          updatedAt: videoHistory.updatedAt,
          title: videoHistory.title,
          errorMessage: videoHistory.errorMessage,
          retryCount: videoHistory.retryCount,
          operationName: videoHistory.operationName,
          sceneId: videoHistory.sceneId,
          tokenUsed: videoHistory.tokenUsed,
          sceneNumber: videoHistory.sceneNumber,
          aspectRatio: videoHistory.aspectRatio,
          userId: videoHistory.userId,
        })
        .from(videoHistory)
        .where(
          and(
            eq(videoHistory.userId, userId),
            eq(videoHistory.deletedByUser, false)
          )
        )
        .orderBy(desc(videoHistory.createdAt))
        .limit(limit)
        .offset(offset);

      // Sort by sceneNumber ascending to display in correct sequence (Scene 1, 2, 3...)
      const videosInOrder = [...videos].sort((a, b) => {
        const aScene = a.sceneNumber ?? 999999;
        const bScene = b.sceneNumber ?? 999999;
        return aScene - bScene;
      });

      const duration = Date.now() - startTime;
      console.log(`[VideoHistory] Query completed in ${duration}ms, found ${videosInOrder.length} videos`);

      res.json({ videos: videosInOrder, limit, offset });
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[VideoHistory] Error after ${duration}ms:`, error);
      res.status(500).json({ 
        error: "Failed to fetch video history",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // GET single video history by ID (for polling status)
  app.get("/api/video-history/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const videoId = req.params.id;
      
      const video = await db
        .select({
          id: videoHistory.id,
          userId: videoHistory.userId,
          prompt: videoHistory.prompt,
          videoUrl: videoHistory.videoUrl,
          status: videoHistory.status,
          createdAt: videoHistory.createdAt,
          updatedAt: videoHistory.updatedAt,
          title: videoHistory.title,
          errorMessage: videoHistory.errorMessage,
        })
        .from(videoHistory)
        .where(eq(videoHistory.id, videoId))
        .limit(1);

      if (video.length === 0) {
        return res.status(404).json({ error: "Video not found" });
      }

      // Verify ownership
      if (video[0].userId !== userId) {
        return res.status(403).json({ error: "Not authorized to view this video" });
      }

      res.json(video[0]);
    } catch (error) {
      console.error("[VideoHistory/:id] Error:", error);
      res.status(500).json({ error: "Failed to fetch video" });
    }
  });

  app.post("/api/video-history", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Get user and check plan restrictions
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user can generate video (plan expiry and daily limit)
      const videoCheck = canGenerateVideo(user);
      if (!videoCheck.allowed) {
        return res.status(403).json({ error: videoCheck.reason });
      }

      const schema = z.object({
        prompt: z.string().min(10, "Prompt must be at least 10 characters"),
        aspectRatio: z.enum(["landscape", "portrait"]),
        videoUrl: z.string().optional(),
        status: z.enum(["pending", "completed", "failed", "queued"]),
        title: z.string().optional(),
        tokenUsed: z.string().optional(),
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const video = await storage.addVideoHistory({
        userId,
        ...validationResult.data
      });

      // Daily count will be incremented when video completes successfully
      // This ensures only completed videos count toward daily limit

      res.json({ video });
    } catch (error) {
      console.error("Error saving video history:", error);
      res.status(500).json({ 
        error: "Failed to save video history",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Delete individual video from history (soft delete)
  app.delete("/api/video-history/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const videoId = req.params.id;
      if (!videoId) {
        return res.status(400).json({ error: "Video ID is required" });
      }

      // Get the video and verify ownership
      const video = await storage.getVideoById(videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }

      if (video.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to delete this video" });
      }

      // Delete video file from object storage if exists
      if (video.videoUrl) {
        try {
          const { ObjectStorageService } = await import('./objectStorage.js');
          const objectStorageService = new ObjectStorageService();
          const file = await objectStorageService.getObjectEntityFile(video.videoUrl);
          await file.delete();
          console.log(`[API] Deleted video file: ${video.videoUrl}`);
        } catch (error) {
          console.warn(`[API] Could not delete video file ${video.videoUrl}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }

      // Soft delete: Mark video as deleted
      await db
        .update(videoHistory)
        .set({ 
          deletedByUser: true,
          deletedAt: sql`now()::text`
        })
        .where(
          and(
            eq(videoHistory.id, videoId),
            eq(videoHistory.userId, userId)
          )
        );

      console.log(`[API] User ${userId}: Deleted video ${videoId}`);

      res.json({ 
        success: true, 
        message: "Video deleted successfully"
      });
    } catch (error) {
      console.error("Error deleting video:", error);
      res.status(500).json({ 
        error: "Failed to delete video",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Clear all video history for the current user (soft delete)
  app.delete("/api/video-history", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // First, get all non-deleted videos for this user
      const videos = await db
        .select()
        .from(videoHistory)
        .where(
          and(
            eq(videoHistory.userId, userId),
            eq(videoHistory.deletedByUser, false) // Only fetch non-deleted videos
          )
        );

      console.log(`[API] User ${userId}: Found ${videos.length} videos to soft delete`);

      // Delete video files from object storage (to save space)
      const { ObjectStorageService } = await import('./objectStorage.js');
      const objectStorageService = new ObjectStorageService();
      let deletedFilesCount = 0;

      for (const video of videos) {
        if (video.videoUrl) {
          try {
            const file = await objectStorageService.getObjectEntityFile(video.videoUrl);
            await file.delete();
            deletedFilesCount++;
            console.log(`[API] Deleted video file: ${video.videoUrl}`);
          } catch (error) {
            // File might not exist or already deleted - continue
            console.warn(`[API] Could not delete video file ${video.videoUrl}:`, error instanceof Error ? error.message : 'Unknown error');
          }
        }
      }

      // Soft delete: Mark videos as deleted instead of removing from database
      await db
        .update(videoHistory)
        .set({ 
          deletedByUser: true,
          deletedAt: sql`now()::text`
        })
        .where(
          and(
            eq(videoHistory.userId, userId),
            eq(videoHistory.deletedByUser, false)
          )
        );

      console.log(`[API] User ${userId}: Soft deleted ${videos.length} video history records, deleted ${deletedFilesCount} files from storage`);

      res.json({ 
        success: true, 
        message: "All video history cleared successfully",
        deletedRecords: videos.length,
        deletedFiles: deletedFilesCount
      });
    } catch (error) {
      console.error("Error clearing video history:", error);
      res.status(500).json({ 
        error: "Failed to clear video history",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // BULK VIDEO WITH REFERENCE IMAGE - 5-Step Whisk Flow (SSE)
  // Flow: 1) Upload reference → 2) Generate image (runImageRecipe) → 3) Upload for video → 4) Start video (generateVideo) → 5) Poll until complete
  app.post("/api/bulk-video-reference-stream", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const toolCheck = canAccessTool(user, "bulk");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const schema = z.object({
        prompts: z.array(z.string().min(3)).min(1).max(50),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape"),
        referenceImageBase64: z.string().min(100),
        referenceImageMimeType: z.string().default("image/jpeg"),
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }

      const { prompts, aspectRatio, referenceImageBase64, referenceImageMimeType } = validationResult.data;
      
      // Generate unique batch ID for this generation request
      const bulkRefBatchId = `bulk-ref-${Date.now()}`;
      
      console.log(`[Bulk Reference Video] Starting ${prompts.length} prompts with reference image, User: ${user.username}, batchId: ${bulkRefBatchId}`);

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
      }
      res.flushHeaders();

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Get API tokens for whisk operations
      const activeTokens = await storage.getActiveApiTokens();
      if (activeTokens.length === 0) {
        sendEvent('error', { error: "No active API tokens available" });
        res.end();
        return;
      }

      const imageAspectRatio = aspectRatio === "portrait" ? "IMAGE_ASPECT_RATIO_PORTRAIT" : "IMAGE_ASPECT_RATIO_LANDSCAPE";
      const videoAspectRatio = aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE";
      const videoModelKey = aspectRatio === "portrait" ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra";
      const veoProjectId = process.env.VEO3_PROJECT_ID || "5fdc3f34-d4c6-4afb-853a-aba4390bafdc";

      // Process each prompt sequentially
      for (let index = 0; index < prompts.length; index++) {
        const prompt = prompts[index].trim();
        const token = activeTokens[index % activeTokens.length];
        const sessionId = `;${Date.now()}`;
        const workflowId = crypto.randomUUID();
        const sceneId = crypto.randomUUID();
        const seed = Math.floor(Math.random() * 100000);

        console.log(`[Bulk Ref ${index}] Starting with Token ${token.label}`);
        sendEvent('progress', { index, phase: 'starting', message: 'Starting generation...' });

        try {
          // ===== STEP 1: Upload reference image to get uploadMediaGenerationId =====
          console.log(`[Bulk Ref ${index}] Step 1: Uploading reference image...`);
          sendEvent('progress', { index, phase: 'uploading_reference', message: 'Uploading character reference...' });

          const refUploadPayload = {
            json: {
              clientContext: {
                workflowId: workflowId,
                sessionId: sessionId
              },
              uploadMediaInput: {
                mediaCategory: "MEDIA_CATEGORY_SUBJECT",
                rawBytes: `data:${referenceImageMimeType};base64,${referenceImageBase64}`
              }
            }
          };

          const refUploadResponse = await fetch("https://labs.google/fx/api/trpc/backbone.uploadImage", {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token.token}`,
            },
            body: JSON.stringify(refUploadPayload),
          });

          let uploadMediaGenerationId: string | null = null;
          if (refUploadResponse.ok) {
            const refData = await refUploadResponse.json();
            uploadMediaGenerationId = refData?.result?.data?.json?.result?.uploadMediaGenerationId;
            console.log(`[Bulk Ref ${index}] Step 1 complete: Got uploadMediaGenerationId`);
          }

          if (!uploadMediaGenerationId) {
            // Fallback: Try using aisandbox uploadUserImage
            console.log(`[Bulk Ref ${index}] Step 1 fallback: Using uploadUserImage API...`);
            const fallbackPayload = {
              imageInput: {
                rawImageBytes: referenceImageBase64,
                mimeType: referenceImageMimeType
              }
            };
            
            const fallbackResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(fallbackPayload),
            });

            if (fallbackResponse.ok) {
              const fallbackData = await fallbackResponse.json();
              uploadMediaGenerationId = fallbackData.mediaGenerationId?.mediaGenerationId || fallbackData.mediaGenerationId;
            }
          }

          if (!uploadMediaGenerationId) {
            console.log(`[Bulk Ref ${index}] Step 1 failed: Could not upload reference image`);
            sendEvent('result', { index, status: 'failed', error: 'Failed to upload reference image' });
            continue;
          }

          // Mark token as used to prevent rotation
          await storage.updateTokenUsage(token.id);

          // ===== STEP 2: Generate image with reference (whisk:runImageRecipe) =====
          console.log(`[Bulk Ref ${index}] Step 2: Generating image with reference...`);
          sendEvent('progress', { index, phase: 'generating_image', message: 'Generating image with character...' });

          const recipePayload = {
            clientContext: {
              workflowId: workflowId,
              tool: "BACKBONE",
              sessionId: sessionId
            },
            seed: seed,
            imageModelSettings: {
              imageModel: "GEM_PIX",
              aspectRatio: imageAspectRatio
            },
            userInstruction: prompt,
            recipeMediaInputs: [{
              caption: "character",
              mediaInput: {
                mediaCategory: "MEDIA_CATEGORY_SUBJECT",
                mediaGenerationId: uploadMediaGenerationId
              }
            }]
          };

          const recipeResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(recipePayload),
          });

          if (!recipeResponse.ok) {
            const errText = await recipeResponse.text();
            console.log(`[Bulk Ref ${index}] Step 2 failed: ${errText}`);
            sendEvent('result', { index, status: 'failed', error: 'Failed to generate image with reference' });
            continue;
          }

          const recipeData = await recipeResponse.json();
          const generatedImageBase64 = recipeData?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;

          if (!generatedImageBase64) {
            console.log(`[Bulk Ref ${index}] Step 2 failed: No image in response`);
            sendEvent('result', { index, status: 'failed', error: 'No image generated from recipe' });
            continue;
          }

          const imageDataUrl = `data:image/png;base64,${generatedImageBase64}`;
          console.log(`[Bulk Ref ${index}] Step 2 complete: Image generated (${Math.round(generatedImageBase64.length / 1024)}KB)`);
          sendEvent('progress', { index, phase: 'image_complete', imageUrl: imageDataUrl, message: 'Image generated!' });

          // ===== STEP 3: Upload generated image for video (uploadUserImage) =====
          console.log(`[Bulk Ref ${index}] Step 3: Uploading image for video...`);
          sendEvent('progress', { index, phase: 'uploading_for_video', message: 'Preparing for video...' });

          const videoImagePayload = {
            imageInput: {
              rawImageBytes: generatedImageBase64,
              mimeType: "image/png",
              isUserUploaded: true,
              aspectRatio: imageAspectRatio
            },
            clientContext: {
              sessionId: sessionId,
              tool: "ASSET_MANAGER"
            }
          };

          const videoImageResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(videoImagePayload),
          });

          // ===== STEP 4: Start video generation (whisk:generateVideo) =====
          console.log(`[Bulk Ref ${index}] Step 4: Starting video generation...`);
          sendEvent('progress', { index, phase: 'starting_video', message: 'Starting video generation...' });

          const videoPayload = {
            clientContext: {
              sessionId: sessionId,
              tool: "BACKBONE",
              workflowId: workflowId
            },
            promptImageInput: {
              prompt: prompt,
              rawBytes: `data:image/png;base64,${generatedImageBase64}`
            },
            sceneId: sceneId,
            videoModelSettings: {
              aspectRatio: videoAspectRatio,
              videoModelKey: videoModelKey
            },
            seed: seed
          };

          const videoStartResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(videoPayload),
          });

          if (!videoStartResponse.ok) {
            const errText = await videoStartResponse.text();
            console.log(`[Bulk Ref ${index}] Step 4 failed: ${errText}`);
            sendEvent('result', { index, status: 'failed', error: 'Failed to start video generation', imageUrl: imageDataUrl });
            continue;
          }

          const videoStartData = await videoStartResponse.json();
          const operationName = videoStartData?.operation?.operation?.name || videoStartData?.operation?.name;

          if (!operationName) {
            console.log(`[Bulk Ref ${index}] Step 4 failed: No operation name in response`);
            sendEvent('result', { index, status: 'failed', error: 'No operation returned from video start', imageUrl: imageDataUrl });
            continue;
          }

          console.log(`[Bulk Ref ${index}] Step 4 complete: Operation ${operationName}`);

          // ===== STEP 5: Poll for video completion =====
          console.log(`[Bulk Ref ${index}] Step 5: Polling for video...`);
          sendEvent('progress', { index, phase: 'polling', operationName, imageUrl: imageDataUrl, message: 'Generating video...' });

          let videoBase64: string | null = null;
          let pollAttempts = 0;
          const maxPollAttempts = 120; // 10 minutes max

          while (pollAttempts < maxPollAttempts && !videoBase64) {
            await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds between polls
            pollAttempts++;

            try {
              const pollPayload = {
                operations: [{
                  operation: { name: operationName },
                  sceneId: sceneId,
                  status: "MEDIA_GENERATION_STATUS_PENDING"
                }]
              };

              const pollResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(pollPayload),
              });

              if (pollResponse.ok) {
                const pollData = await pollResponse.json();
                const status = pollData?.operations?.[0]?.status;
                const video = pollData?.operations?.[0]?.operation?.response?.generatedVideos?.[0];

                if (video?.encodedVideo) {
                  videoBase64 = video.encodedVideo;
                  console.log(`[Bulk Ref ${index}] Step 5 complete: Video ready after ${pollAttempts} polls`);
                } else if (status === "MEDIA_GENERATION_STATUS_FAILED") {
                  console.log(`[Bulk Ref ${index}] Step 5 failed: Video generation failed`);
                  break;
                }
              }
            } catch (pollError) {
              console.log(`[Bulk Ref ${index}] Poll error:`, pollError);
            }

            // Send polling update every 6 polls (30 seconds)
            if (pollAttempts % 6 === 0) {
              sendEvent('progress', { index, phase: 'polling', poll: pollAttempts, imageUrl: imageDataUrl, message: `Generating video... (${pollAttempts * 5}s)` });
            }
          }

          if (!videoBase64) {
            console.log(`[Bulk Ref ${index}] Step 5 timeout: Video not ready after ${maxPollAttempts} polls`);
            sendEvent('result', { index, status: 'failed', error: 'Video generation timeout', imageUrl: imageDataUrl });
            continue;
          }

          // ===== Upload video to storage =====
          console.log(`[Bulk Ref ${index}] Uploading video to storage...`);
          sendEvent('progress', { index, phase: 'uploading', imageUrl: imageDataUrl, message: 'Uploading video...' });

          const uploadResult = await uploadBase64VideoWithFallback(videoBase64, `bulk_ref_${index}_${Date.now()}`);
          const videoUrl = uploadResult.url;

          // Create history entry with scene number and batch ID for proper ordering
          const historyEntry = await storage.addVideoHistory({
            userId,
            prompt,
            aspectRatio: videoAspectRatio,
            status: 'completed',
            videoUrl: videoUrl || undefined,
            title: `Bulk Reference Video ${index + 1}`,
            tokenUsed: token.id,
            sceneNumber: index + 1, // 1-based scene number matching prompt order
            batchId: bulkRefBatchId, // Group videos from same batch together
          });

          console.log(`[Bulk Ref ${index}] ✅ Complete! Video uploaded: ${videoUrl ? 'Yes' : 'No'}`);
          sendEvent('result', { 
            index, 
            status: 'completed', 
            imageUrl: imageDataUrl,
            videoUrl: videoUrl,
            historyId: historyEntry.id,
          });

        } catch (error: any) {
          console.error(`[Bulk Ref ${index}] Error:`, error);
          sendEvent('result', { index, status: 'failed', error: error.message || 'Unknown error' });
        }
      }

      sendEvent('complete', { message: 'All prompts processed' });
      res.end();

    } catch (error) {
      console.error("[Bulk Reference Video] Error:", error);
      res.status(500).json({ error: "Generation failed" });
    }
  });

  // Bulk generate endpoint - processes videos in background queue using Flow Cookies
  app.post("/api/bulk-generate", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Import queue functions (no blocking check - new batch always overrides old)
      const { stopFlowQueue } = await import('./bulkQueueFlow');

      // Get user and check plan restrictions
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const schema = z.object({
        prompts: z.array(z.string().min(10, "Each prompt must be at least 10 characters")).min(1).max(100),
        aspectRatio: z.enum(["landscape", "portrait"]),
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { prompts, aspectRatio } = validationResult.data;

      // Check if user can perform bulk generation with this batch size
      const bulkCheck = canBulkGenerate(user, prompts.length);
      if (!bulkCheck.allowed) {
        return res.status(403).json({ error: bulkCheck.reason });
      }

      // Check if flow cookies are available
      const activeCookies = await storage.getActiveFlowCookies();
      if (activeCookies.length === 0) {
        return res.status(400).json({ error: "No Flow Cookies available. Please add cookies in Admin panel." });
      }
      
      const { addToFlowQueue } = await import('./bulkQueueFlow');
      
      console.log(`[Bulk Generate] Starting bulk generation for ${prompts.length} videos using Flow Cookies (User: ${user.username})`);

      // AUTO-CLEAR: Fast batch delete all pending/stuck videos
      try {
        stopFlowQueue(userId);
        
        const deleteResult = await db
          .delete(videoHistory)
          .where(
            and(
              eq(videoHistory.userId, userId),
              or(
                eq(videoHistory.status, 'pending'),
                eq(videoHistory.status, 'generating'),
                eq(videoHistory.status, 'queued'),
                eq(videoHistory.status, 'retrying'),
                eq(videoHistory.status, 'processing'),
                eq(videoHistory.status, 'initializing')
              )
            )
          )
          .returning({ id: videoHistory.id });
        
        if (deleteResult.length > 0) {
          console.log(`[Bulk Generate] Fast-cleared ${deleteResult.length} stuck/pending videos for user ${userId}`);
        }
      } catch (clearError) {
        console.error('[Bulk Generate] Error auto-clearing stuck videos:', clearError);
      }

      // Create all video history entries immediately
      const videoIds: string[] = [];
      const queuedVideos = [];
      const bulkBatchId = `bulk-batch-${Date.now()}`; // Unique batch ID for this bulk request
      
      for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        const sceneNum = i + 1; // 1-based scene number matching prompt order
        const video = await storage.addVideoHistory({
          userId,
          prompt,
          aspectRatio,
          status: "pending",
          title: `Bulk Flow ${aspectRatio} video ${sceneNum}`,
          sceneNumber: sceneNum, // Save scene number at creation time for proper ordering
          batchId: bulkBatchId, // Group videos from same batch together
        });
        
        videoIds.push(video.id);
        queuedVideos.push({
          videoId: video.id,
          prompt,
          aspectRatio,
          sceneNumber: sceneNum,
          userId,
        });
      }

      // Add all videos to the background queue (processes in batches of 10)
      // isNewBatch=false because stopFlowQueue already cleared the old batch
      await addToFlowQueue(queuedVideos, false);

      console.log(`[Bulk Generate] Created ${videoIds.length} videos and added to Flow queue (batch size: 10)`);

      res.json({ 
        success: true,
        videoIds,
        message: `Started generating ${prompts.length} videos using Flow Cookies. Processing in batches of 10.`
      });
    } catch (error) {
      console.error("Error starting bulk generation:", error);
      res.status(500).json({ 
        error: "Failed to start bulk generation",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Stop bulk processing for the current user
  app.post("/api/bulk-generate/stop", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      
      const { stopFlowQueue } = await import('./bulkQueueFlow');
      const result = stopFlowQueue(userId);
      
      console.log(`[API] User ${userId}: Bulk processing stopped. Cleared ${result.remaining} videos.`);
      
      res.json({ stopped: result.stopped, clearedVideos: result.remaining });
    } catch (error) {
      console.error("Error stopping bulk processing:", error);
      res.status(500).json({ 
        error: "Failed to stop bulk processing",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Status cache to reduce DB calls (5 second TTL per user)
  const statusCache = new Map<string, { data: any; timestamp: number }>();
  const STATUS_CACHE_TTL = 5000; // 5 seconds - increased for multi-user efficiency

  // Get queue status for the current user
  app.get("/api/bulk-generate/status", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      
      // Check cache first
      const cached = statusCache.get(userId);
      const now = Date.now();
      if (cached && (now - cached.timestamp) < STATUS_CACHE_TTL) {
        return res.json(cached.data);
      }
      
      const { getFlowQueueStatus } = await import('./bulkQueueFlow');
      const status = getFlowQueueStatus(userId);
      
      // OPTIMIZED: Only fetch videos from current batch if we have batch IDs
      let videos;
      if (status.batchVideoIds && status.batchVideoIds.length > 0) {
        // Fast query: only fetch current batch videos by ID (much faster than limit 500)
        videos = await db
          .select({
            id: videoHistory.id,
            prompt: videoHistory.prompt,
            status: videoHistory.status,
            videoUrl: videoHistory.videoUrl,
            errorMessage: videoHistory.errorMessage,
            tokenUsed: videoHistory.tokenUsed,
          })
          .from(videoHistory)
          .where(inArray(videoHistory.id, status.batchVideoIds));
      } else {
        // Fallback: no active batch, fetch recent videos
        videos = await db
          .select({
            id: videoHistory.id,
            prompt: videoHistory.prompt,
            status: videoHistory.status,
            videoUrl: videoHistory.videoUrl,
            errorMessage: videoHistory.errorMessage,
            tokenUsed: videoHistory.tokenUsed,
          })
          .from(videoHistory)
          .where(and(
            eq(videoHistory.userId, userId),
            eq(videoHistory.deletedByUser, false)
          ))
          .orderBy(desc(videoHistory.createdAt))
          .limit(100);
      }
      
      // Map database status to frontend status format
      const mapStatus = (dbStatus: string): "pending" | "processing" | "completed" | "failed" => {
        switch (dbStatus) {
          case "completed": return "completed";
          case "failed": return "failed";
          case "generating":
          case "queued":
          case "retrying":
          case "initializing":
            return "processing";
          default: return "pending";
        }
      };
      
      // Map to format frontend expects (include id for batch filtering)
      const results = videos.map(video => ({
        id: video.id,
        prompt: video.prompt,
        status: mapStatus(video.status),
        videoUrl: video.videoUrl || undefined,
        error: video.errorMessage || undefined,
        tokenLabel: video.tokenUsed || null,
      }));
      
      const response = {
        ...status,
        results,
      };
      
      // Cache the response
      statusCache.set(userId, { data: response, timestamp: now });
      
      res.json(response);
    } catch (error) {
      console.error("Error getting queue status:", error);
      res.status(500).json({ 
        error: "Failed to get queue status",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.patch("/api/video-history/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.session.userId;
      
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const schema = z.object({
        status: z.enum(["pending", "completed", "failed", "queued"]),
        videoUrl: z.string().optional(),
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { status, videoUrl } = validationResult.data;

      const updated = await storage.updateVideoHistoryStatus(id, userId, status, videoUrl);

      if (!updated) {
        return res.status(404).json({ error: "Video history entry not found or access denied" });
      }

      res.json({ video: updated });
    } catch (error) {
      console.error("Error updating video history:", error);
      res.status(500).json({ 
        error: "Failed to update video history",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Download multiple videos as ZIP (No authentication required)
  app.post("/api/videos/download-zip", async (req, res) => {
    // Check concurrency limit first
    if (activeZipDownloads >= MAX_CONCURRENT_ZIP_DOWNLOADS) {
      console.log(`[ZIP Download] Rejected - too many active downloads (${activeZipDownloads}/${MAX_CONCURRENT_ZIP_DOWNLOADS})`);
      return res.status(503).json({ 
        error: "Server busy", 
        message: "Too many downloads in progress. Please try again in a few seconds." 
      });
    }
    
    activeZipDownloads++;
    console.log(`[ZIP Download] Started (active: ${activeZipDownloads}/${MAX_CONCURRENT_ZIP_DOWNLOADS})`);
    
    try {
      const schema = z.object({
        videoIds: z.array(z.string()).min(1, "At least one video must be selected").max(200, "Maximum 200 videos can be downloaded at once")
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        activeZipDownloads--;
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { videoIds } = validationResult.data;

      // Fetch videos from database
      const videos = await Promise.all(
        videoIds.map(id => storage.getVideoById(id))
      );

      // Filter out null values and videos without URLs (no userId check)
      const validVideos = videos.filter((v): v is VideoHistory => 
        v !== undefined && v.videoUrl !== null && v.status === "completed"
      );

      if (validVideos.length === 0) {
        activeZipDownloads--;
        return res.status(404).json({ error: "No valid videos found" });
      }

      console.log(`[ZIP Download] Downloading ${validVideos.length} videos (active: ${activeZipDownloads})`);

      // Set response headers for ZIP download
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="videos-${timestamp}.zip"`);

      // Create ZIP archive with optimized buffering
      const archive = archiver('zip', {
        zlib: { level: 0 }, // No compression for faster processing
        highWaterMark: 1024 * 1024 * 4 // 4MB buffer for better throughput
      });

      // Pipe archive to response
      archive.pipe(res);

      // Error handling
      archive.on('error', (err) => {
        console.error('[ZIP Download] Archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to create ZIP archive' });
        }
      });

      // Download and add videos to the archive with controlled parallelism
      let successCount = 0;
      const PARALLEL_DOWNLOADS = 10; // Reduced for stability with 100+ users
      const VIDEO_FETCH_TIMEOUT = 60000; // 60 seconds per video
      
      // Process videos in batches
      for (let batchStart = 0; batchStart < validVideos.length; batchStart += PARALLEL_DOWNLOADS) {
        const batchEnd = Math.min(batchStart + PARALLEL_DOWNLOADS, validVideos.length);
        const batch = validVideos.slice(batchStart, batchEnd);
        
        console.log(`[ZIP Download] Processing batch ${Math.floor(batchStart / PARALLEL_DOWNLOADS) + 1} (${batchStart + 1}-${batchEnd}/${validVideos.length})`);
        
        // Download all videos in this batch in parallel with timeout
        await Promise.all(
          batch.map(async (video, batchIndex) => {
            const i = batchStart + batchIndex;
            if (!video || !video.videoUrl) return;

            try {
              // Create a unique filename based on prompt or ID
              const safePrompt = video.prompt?.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_') || 'video';
              const filename = `${i + 1}_${safePrompt}_${video.id}.mp4`;

              // Fetch video from URL and add to archive (with keep-alive agent and timeout)
              await new Promise<void>((resolve) => {
                const isHttps = video.videoUrl!.startsWith('https');
                const protocol = isHttps ? https : http;
                const agent = isHttps ? httpsAgent : httpAgent;
                
                // Set timeout for this video fetch
                const timeoutId = setTimeout(() => {
                  console.error(`[ZIP Download] Timeout for video ${i + 1}: ${filename}`);
                  resolve(); // Continue with other videos
                }, VIDEO_FETCH_TIMEOUT);
                
                const request = protocol.get(video.videoUrl!, { agent }, (response) => {
                  if (response.statusCode === 200) {
                    archive.append(response, { name: filename });
                    response.on('end', () => {
                      clearTimeout(timeoutId);
                      successCount++;
                      resolve();
                    });
                    response.on('error', () => {
                      clearTimeout(timeoutId);
                      resolve();
                    });
                  } else {
                    clearTimeout(timeoutId);
                    console.error(`[ZIP Download] Failed to fetch video ${i + 1}: ${response.statusCode}`);
                    resolve(); // Continue with other videos
                  }
                });
                
                request.on('error', (err) => {
                  clearTimeout(timeoutId);
                  console.error(`[ZIP Download] Request error for video ${i + 1}:`, err.message);
                  resolve(); // Continue with other videos
                });
                
                // Set socket timeout
                request.setTimeout(VIDEO_FETCH_TIMEOUT, () => {
                  clearTimeout(timeoutId);
                  request.destroy();
                  resolve();
                });
              });
            } catch (error) {
              console.error(`[ZIP Download] Error adding video ${i + 1} to archive:`, error);
              // Continue with other videos
            }
          })
        );
      }

      console.log(`[ZIP Download] Successfully added ${successCount}/${validVideos.length} videos to ZIP`);

      // Finalize the archive
      await archive.finalize();
      
      activeZipDownloads--;
      console.log(`[ZIP Download] Complete (active: ${activeZipDownloads})`);

    } catch (error) {
      activeZipDownloads--;
      console.error("Error creating ZIP download:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Failed to create ZIP download",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
  });

  // Confirm direct video download and clear from cache (called by frontend after successful blob conversion)
  app.post("/api/videos/confirm-download", requireAuth, async (req, res) => {
    try {
      const { videoId } = req.body;
      if (!videoId) {
        return res.status(400).json({ error: "Missing videoId" });
      }
      
      const { deleteDirectVideo } = await import('./bulkQueueFlow');
      const deleted = await deleteDirectVideo(videoId);
      
      res.json({ success: true, deleted });
    } catch (error) {
      console.error("[Confirm Download] Error:", error);
      res.status(500).json({ error: "Failed to confirm download" });
    }
  });

  // Single video download endpoint (proxy to avoid CORS) - supports both GET and POST
  app.get("/api/videos/download-single", requireAuth, async (req, res) => {
    try {
      const videoUrl = req.query.videoUrl as string;
      const filename = req.query.filename as string;

      if (!videoUrl || !filename) {
        return res.status(400).json({ error: "Missing videoUrl or filename" });
      }

      console.log(`[Single Download] Downloading: ${filename} from ${videoUrl.substring(0, 80)}...`);

      // Handle direct: URLs (from direct_to_user mode) - videos cached in temp files
      if (videoUrl.startsWith('direct:')) {
        const videoId = videoUrl.replace('direct:', '');
        const { getDirectVideo } = await import('./bulkQueueFlow');
        const base64 = await getDirectVideo(videoId);
        
        if (base64) {
          console.log(`[Single Download] Serving direct video from temp file: ${videoId}`);
          const buffer = Buffer.from(base64, 'base64');
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', buffer.length);
          res.send(buffer);
          console.log(`[Single Download] Complete: ${filename} (${buffer.length} bytes)`);
          return;
        } else {
          console.error(`[Single Download] Direct video not found or expired: ${videoId}`);
          return res.status(404).json({ error: 'Video expired or already downloaded. Please regenerate.' });
        }
      }

      // Handle local preview URLs (in-memory buffer)
      if (videoUrl.startsWith('/api/video-preview/')) {
        const videoId = videoUrl.replace('/api/video-preview/', '');
        const buffer = getVideoBuffer(videoId);
        
        if (buffer) {
          console.log(`[Single Download] Serving from memory buffer: ${videoId} (${buffer.length} bytes)`);
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', buffer.length);
          res.send(buffer);
          console.log(`[Single Download] Complete: ${filename}`);
          return;
        } else {
          console.error(`[Single Download] Video buffer not found: ${videoId}`);
          return res.status(404).json({ error: 'Video not found or expired' });
        }
      }

      // Handle local disk URLs (VPS storage with 3-hour expiry)
      if (videoUrl.startsWith('/api/local-video/')) {
        const videoId = videoUrl.replace('/api/local-video/', '');
        const { getVideoPath, getVideoMetadata } = await import('./localDiskStorage');
        const videoPath = getVideoPath(videoId);
        const metadata = getVideoMetadata(videoId);
        
        if (videoPath) {
          console.log(`[Single Download] Serving from local disk: ${videoId}`);
          const fs = await import('fs');
          const stat = fs.statSync(videoPath);
          
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', stat.size);
          
          const readStream = fs.createReadStream(videoPath);
          readStream.pipe(res);
          
          readStream.on('end', () => {
            console.log(`[Single Download] Complete: ${filename} (${stat.size} bytes)`);
          });
          
          readStream.on('error', (err) => {
            console.error(`[Single Download] Stream error:`, err);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Failed to stream video' });
            }
          });
          return;
        } else {
          console.error(`[Single Download] Local disk video not found or expired: ${videoId}`);
          return res.status(404).json({ error: 'Video expired or deleted. Local disk videos expire after 3 hours.' });
        }
      }

      // BANDWIDTH OPTIMIZATION: Redirect to CDN URLs instead of proxying through VPS
      // SECURITY: Use strict hostname validation to prevent open redirect attacks
      const ALLOWED_CDN_HOSTS = [
        'res.cloudinary.com',
        'storage.googleapis.com', 
        'lh3.googleusercontent.com',
        'lh4.googleusercontent.com',
        'lh5.googleusercontent.com',
        'lh6.googleusercontent.com',
        'drive.google.com',
        'www.googleapis.com',
        'video.google.com',
      ];
      
      let isCDNUrl = false;
      try {
        const parsedUrl = new URL(videoUrl);
        isCDNUrl = ALLOWED_CDN_HOSTS.some(host => 
          parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host)
        );
      } catch {
        isCDNUrl = false; // Invalid URL, don't redirect
      }
      
      if (isCDNUrl) {
        console.log(`[Single Download] Redirecting to CDN: ${filename}`);
        // Use 302 redirect - client downloads directly from CDN, saving VPS bandwidth!
        return res.redirect(302, videoUrl);
      }
      
      // Only proxy for non-CDN URLs (rare cases)
      console.log(`[Single Download] Proxying non-CDN URL: ${videoUrl.substring(0, 60)}...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

      try {
        const response = await fetch(videoUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.error(`[Single Download] Failed to fetch video: ${response.status} ${response.statusText}`);
          return res.status(500).json({ error: `Failed to download video: ${response.status}` });
        }

        // Set response headers
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        // Forward content-length if available
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          res.setHeader('Content-Length', contentLength);
        }

        // Stream the response
        if (response.body) {
          const reader = response.body.getReader();
          
          const pump = async (): Promise<void> => {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              return;
            }
            if (!res.writableEnded) {
              res.write(Buffer.from(value));
              return pump();
            }
          };
          
          await pump();
          console.log(`[Single Download] Complete: ${filename}`);
        } else {
          res.status(500).json({ error: 'No response body' });
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          console.error(`[Single Download] Timeout for ${filename}`);
          if (!res.headersSent) {
            res.status(504).json({ error: 'Download timeout - video took too long' });
          }
        } else {
          throw fetchError;
        }
      }

    } catch (error) {
      console.error("Error in single video download:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Failed to download video",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
  });

  // Image download proxy endpoint - OPTIMIZED to redirect CDN URLs
  app.get("/api/images/download-proxy", requireAuth, async (req, res) => {
    try {
      const imageUrl = req.query.imageUrl as string;
      const filename = (req.query.filename as string) || `image-${Date.now()}.png`;

      if (!imageUrl) {
        return res.status(400).json({ error: "Missing imageUrl" });
      }

      // BANDWIDTH OPTIMIZATION: Redirect to CDN URLs instead of proxying
      // SECURITY: Use strict hostname validation to prevent open redirect attacks
      const ALLOWED_IMAGE_CDN_HOSTS = [
        'res.cloudinary.com',
        'storage.googleapis.com',
        'lh3.googleusercontent.com',
        'fal.media',
        'v3.fal.media',
        'replicate.delivery',
      ];
      
      let isCDNUrl = false;
      try {
        const parsedUrl = new URL(imageUrl);
        isCDNUrl = ALLOWED_IMAGE_CDN_HOSTS.some(host => 
          parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host)
        );
      } catch {
        isCDNUrl = false; // Invalid URL, don't redirect
      }
      
      // NOTE: We don't redirect anymore because redirects don't preserve download headers
      // Always proxy the image to force download with Content-Disposition header
      console.log(`[Image Download] Proxying image: ${filename}`);

      // Determine content type from URL or default to png
      let contentType = 'image/png';
      if (imageUrl.includes('.jpg') || imageUrl.includes('.jpeg')) {
        contentType = 'image/jpeg';
      } else if (imageUrl.includes('.webp')) {
        contentType = 'image/webp';
      } else if (imageUrl.includes('.gif')) {
        contentType = 'image/gif';
      }

      // Set response headers for download
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // Fetch image and pipe to response with timeout
      const isHttps = imageUrl.startsWith('https');
      const protocol = isHttps ? https : http;
      const agent = isHttps ? httpsAgent : httpAgent;
      const IMAGE_TIMEOUT = 30000; // 30 seconds for images

      const request = protocol.get(imageUrl, { agent }, (imageResponse) => {
        if (imageResponse.statusCode === 200) {
          imageResponse.pipe(res);
        } else {
          console.error(`[Image Download] Failed to fetch image: ${imageResponse.statusCode}`);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to download image' });
          }
        }
      });
      
      request.on('error', (err) => {
        console.error(`[Image Download] Request error:`, err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to download image' });
        }
      });
      
      request.setTimeout(IMAGE_TIMEOUT, () => {
        request.destroy();
        console.error(`[Image Download] Timeout for ${filename}`);
        if (!res.headersSent) {
          res.status(504).json({ error: 'Image download timeout' });
        }
      });

    } catch (error) {
      console.error("Error in image download proxy:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Failed to download image",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
  });

  // Script creator endpoint
  app.post("/api/generate-script", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Get user and check plan restrictions
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user can access script creator
      const toolCheck = canAccessTool(user, "script");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const schema = z.object({
        storyAbout: z.string().min(5, "Story description must be at least 5 characters"),
        numberOfPrompts: z.number().min(1).max(39),
        finalStep: z.string().min(5, "Final step must be at least 5 characters")
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { storyAbout, numberOfPrompts, finalStep } = validationResult.data;

      console.log(`[Script Generator] User: ${user.username}, Plan: ${user.planType}`);

      // Generate script using OpenAI GPT-5
      const script = await generateScript(storyAbout, numberOfPrompts, finalStep);

      res.json({ script });
    } catch (error) {
      console.error("Error in /api/generate-script:", error);
      res.status(500).json({ 
        error: "Failed to generate script",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Script to Image Prompts endpoint (Admin only - uses Gemini API)
  app.post("/api/script-to-prompts", requireAdmin, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const schema = z.object({
        script: z.string().min(10, "Script must be at least 10 characters"),
        numberOfScenes: z.number().min(1).max(20),
        style: z.string().optional().default("Disney Pixar 3D animation style")
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { script, numberOfScenes, style } = validationResult.data;

      // Get Gemini API key from app settings
      const appSettingsData = await storage.getAppSettings();
      const geminiApiKey = appSettingsData?.geminiApiKey;
      
      if (!geminiApiKey) {
        return res.status(400).json({ 
          error: "Gemini API key not configured. Please add it in Admin Settings." 
        });
      }

      console.log(`[Script-to-Prompts] Processing script with ${numberOfScenes} scenes, style: ${style}`);

      // Import and use Gemini API
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });

      const systemPrompt = `You are an expert at converting narrative scripts into visual image prompts for AI image generation.

Your task is to analyze the provided script and create exactly ${numberOfScenes} image prompts that capture the key moments of the story.

IMPORTANT RULES:
1. Each prompt should describe a SINGLE static scene/frame that can be generated as an image
2. Use the style: "${style}" for all prompts
3. Include specific visual details: characters, environment, lighting, camera angle, mood
4. Each prompt should flow naturally into the next to create visual continuity
5. For video transitions: Scene N's END frame should seamlessly connect to Scene N+1's START frame
6. Focus on character consistency - describe characters consistently across all scenes
7. Include specific colors, textures, and atmospheric details

OUTPUT FORMAT:
Return a JSON array with exactly ${numberOfScenes} objects. Each object should have:
- "sceneNumber": number (1 to ${numberOfScenes})
- "prompt": string (the detailed image prompt, 100-200 words)
- "description": string (brief summary of what happens in this scene, 10-20 words)

Example output format:
[
  {
    "sceneNumber": 1,
    "prompt": "A cozy woodland cottage at golden hour, ${style}, a small rabbit character with fluffy white fur and big blue eyes standing at the door, warm sunlight filtering through oak trees, autumn leaves scattered on the ground, peaceful atmosphere, cinematic composition",
    "description": "Rabbit character at home during sunset"
  }
]

Only respond with the JSON array, no additional text.`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          { role: "user", parts: [{ text: systemPrompt + "\n\nSCRIPT TO CONVERT:\n" + script }] }
        ]
      });

      // Parse the response - @google/genai returns GenerateContentResponse with text getter property
      let prompts;
      try {
        const responseText = response.text || "";
        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          throw new Error("No JSON array found in response");
        }
        prompts = JSON.parse(jsonMatch[0]);
        
        if (!Array.isArray(prompts) || prompts.length === 0) {
          throw new Error("Invalid prompts array");
        }
      } catch (parseError) {
        console.error("[Script-to-Prompts] Failed to parse Gemini response:", parseError);
        return res.status(500).json({ 
          error: "Failed to parse AI response",
          message: parseError instanceof Error ? parseError.message : "Unknown error"
        });
      }

      console.log(`[Script-to-Prompts] Generated ${prompts.length} image prompts`);

      res.json({ 
        success: true,
        prompts,
        totalScenes: prompts.length
      });
    } catch (error) {
      console.error("Error in /api/script-to-prompts:", error);
      res.status(500).json({ 
        error: "Failed to convert script to prompts",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Helper: Generate image using Media API (IMAGEN_3_5) model
  // When reference images are provided, uses whisk:runImageRecipe endpoint
  // Otherwise uses whisk:generateImage endpoint
  async function generateWithMediaGen(
    apiKey: string, 
    prompt: string, 
    aspectRatio: string,
    previousScenePrompt?: string,
    referenceMediaIds?: string[]
  ): Promise<string> {
    const workflowId = crypto.randomUUID();
    const sessionId = `;${Date.now()}`;
    
    // Combine current prompt with simplified previous scene context for visual continuity
    let finalPrompt = prompt;
    if (previousScenePrompt) {
      const simplifiedContext = previousScenePrompt.substring(0, 200).trim();
      finalPrompt = `Continuing from previous scene (${simplifiedContext}...). ${prompt}`;
      console.log(`[MediaGen] Added simplified previous scene context for continuity`);
    }
    
    // If reference images are provided, use whisk:runImageRecipe
    if (referenceMediaIds && referenceMediaIds.length > 0) {
      console.log(`[MediaGen] Using runImageRecipe with ${referenceMediaIds.length} reference images`);
      
      const seed = Math.floor(Math.random() * 1000000);
      
      // Build recipeMediaInputs from media IDs - use SUBJECT category for character consistency
      const recipeMediaInputs = referenceMediaIds.map((mediaId, index) => ({
        caption: `character reference ${index + 1}`,
        mediaInput: {
          mediaCategory: "MEDIA_CATEGORY_SUBJECT",
          mediaGenerationId: mediaId
        }
      }));
      
      // Enhance prompt to explicitly use the character from reference
      const enhancedPrompt = `Using the exact same character/person from the reference image: ${finalPrompt}`;
      console.log(`[MediaGen Recipe] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      
      const recipeRequestBody = {
        clientContext: {
          workflowId: workflowId,
          tool: "BACKBONE",
          sessionId: sessionId
        },
        seed: seed,
        imageModelSettings: {
          imageModel: "GEM_PIX",
          aspectRatio: aspectRatio
        },
        userInstruction: enhancedPrompt,
        recipeMediaInputs: recipeMediaInputs
      };
      
      const recipeApiUrl = "https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe";
      
      const response = await fetch(recipeApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(recipeRequestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[MediaGen Recipe] API error ${response.status}:`, errorText);
        throw new Error(`Media Recipe API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`[MediaGen Recipe] Received response from Google AI`);

      // Extract base64 image from runImageRecipe response
      let base64Image: string | undefined;
      if (result.imagePanels && result.imagePanels.length > 0) {
        const firstPanel = result.imagePanels[0];
        if (firstPanel.generatedImages && firstPanel.generatedImages.length > 0) {
          const firstImage = firstPanel.generatedImages[0];
          base64Image = firstImage.encodedImage || firstImage.image;
          console.log(`[MediaGen Recipe] Extracted image from imagePanels structure`);
        }
      }
      
      if (!base64Image) {
        base64Image = result.encodedImage || result.image?.base64 || result.base64 || result.imageData || result.data;
      }
      
      if (!base64Image) {
        console.error('[MediaGen Recipe] No base64 image data in response:', JSON.stringify(result, null, 2));
        throw new Error("No image data received from Media Recipe API");
      }

      return base64Image;
    }
    
    // Standard flow without reference images - use whisk:generateImage
    const apiUrl = "https://aisandbox-pa.googleapis.com/v1/whisk:generateImage";
    
    const requestBody: any = {
      clientContext: {
        workflowId: workflowId,
        tool: "BACKBONE",
        sessionId: sessionId
      },
      imageModelSettings: {
        imageModel: "IMAGEN_3_5",
        aspectRatio: aspectRatio
      },
      prompt: finalPrompt,
      mediaCategory: "MEDIA_CATEGORY_BOARD"
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[MediaGen] API error ${response.status}:`, errorText);
      throw new Error(`Media API returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[MediaGen] Received response from Google AI`);

    // Extract base64 image from Media response structure
    let base64Image: string | undefined;
    if (result.imagePanels && result.imagePanels.length > 0) {
      const firstPanel = result.imagePanels[0];
      if (firstPanel.generatedImages && firstPanel.generatedImages.length > 0) {
        const firstImage = firstPanel.generatedImages[0];
        base64Image = firstImage.encodedImage || firstImage.image;
        console.log(`[MediaGen] Extracted image from imagePanels structure`);
      }
    }
    
    if (!base64Image) {
      base64Image = result.encodedImage || result.image?.base64 || result.base64 || result.imageData || result.data;
    }
    
    if (!base64Image) {
      console.error('[MediaGen] No base64 image data in response:', JSON.stringify(result, null, 2));
      throw new Error("No image data received from Media API");
    }

    return base64Image;
  }

  // Helper: Generate image using Nano Bana (GEM_PIX) model
  // When reference images are provided, uses whisk:runImageRecipe endpoint
  async function generateWithGemPix(
    apiKey: string,
    prompt: string,
    aspectRatio: string,
    previousScenePrompt?: string,
    referenceMediaIds?: string[]
  ): Promise<string> {
    const workflowId = crypto.randomUUID();
    const sessionId = `;${Date.now()}`;
    
    // Combine current prompt with simplified previous scene context for visual continuity
    let finalPrompt = prompt;
    if (previousScenePrompt) {
      const simplifiedContext = previousScenePrompt.substring(0, 200).trim();
      finalPrompt = `Continuing from previous scene (${simplifiedContext}...). ${prompt}`;
      console.log(`[GEM_PIX] Added simplified previous scene context for continuity`);
    }
    
    const seed = Math.floor(Math.random() * 1000000);

    // If reference images are provided, use whisk:runImageRecipe (same as MediaGen)
    if (referenceMediaIds && referenceMediaIds.length > 0) {
      console.log(`[GEM_PIX] Using runImageRecipe with ${referenceMediaIds.length} reference images`);
      console.log(`[GEM_PIX] Reference mediaIds: ${JSON.stringify(referenceMediaIds)}`);
      
      // Build recipeMediaInputs from media IDs - use SUBJECT category for character consistency
      const recipeMediaInputs = referenceMediaIds.map((mediaId, index) => ({
        caption: `character reference ${index + 1}`,
        mediaInput: {
          mediaCategory: "MEDIA_CATEGORY_SUBJECT",
          mediaGenerationId: mediaId
        }
      }));
      
      // Enhance prompt to explicitly use the character from reference
      const enhancedPrompt = `Using the exact same character/person from the reference image: ${finalPrompt}`;
      console.log(`[GEM_PIX Recipe] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      
      const recipeRequestBody = {
        clientContext: {
          workflowId: workflowId,
          tool: "BACKBONE",
          sessionId: sessionId
        },
        seed: seed,
        imageModelSettings: {
          imageModel: "GEM_PIX",
          aspectRatio: aspectRatio
        },
        userInstruction: enhancedPrompt,
        recipeMediaInputs: recipeMediaInputs
      };
      
      const recipeApiUrl = "https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe";
      
      const response = await fetch(recipeApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(recipeRequestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GEM_PIX Recipe] API error ${response.status}:`, errorText);
        throw new Error(`GEM_PIX Recipe API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`[GEM_PIX Recipe] Received response from Google AI`);

      // Extract base64 image from runImageRecipe response
      let base64Image: string | undefined;
      if (result.imagePanels && result.imagePanels.length > 0) {
        const firstPanel = result.imagePanels[0];
        if (firstPanel.generatedImages && firstPanel.generatedImages.length > 0) {
          const firstImage = firstPanel.generatedImages[0];
          base64Image = firstImage.encodedImage || firstImage.image;
          console.log(`[GEM_PIX Recipe] Extracted image from imagePanels structure`);
        }
      }
      
      if (!base64Image) {
        base64Image = result.encodedImage || result.image?.base64 || result.base64 || result.imageData || result.data;
      }
      
      if (!base64Image) {
        console.error('[GEM_PIX Recipe] No base64 image data in response:', JSON.stringify(result, null, 2));
        throw new Error("No image data received from GEM_PIX Recipe API");
      }

      return base64Image;
    }

    // Standard flow without reference images - use flowMedia:batchGenerateImages
    const projectId = process.env.GEM_PIX_PROJECT_ID || "881d362b-300e-4b8b-aab4-0dab0cf875d8";
    const apiUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`;

    const requestBody = {
      requests: [{
        clientContext: {
          sessionId: sessionId
        },
        seed: seed,
        imageModelName: "GEM_PIX",
        imageAspectRatio: aspectRatio,
        prompt: finalPrompt,
        imageInputs: []
      }]
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GEM_PIX] API error ${response.status}:`, errorText);
      throw new Error(`GEM_PIX API returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[GEM_PIX] Received response from Google AI`);

    // Extract base64 image from GEM_PIX response structure
    let base64Image: string | undefined;
    
    if (result.media && result.media.length > 0) {
      const mediaItem = result.media[0];
      if (mediaItem.image?.generatedImage?.encodedImage) {
        base64Image = mediaItem.image.generatedImage.encodedImage;
        console.log(`[GEM_PIX] Extracted base64 from media[0].image.generatedImage.encodedImage`);
      } else if (mediaItem.image) {
        base64Image = mediaItem.image;
        console.log(`[GEM_PIX] Extracted image directly from media[0].image`);
      }
    } else if (result.responses && result.responses.length > 0) {
      const firstResponse = result.responses[0];
      if (firstResponse.generatedImages && firstResponse.generatedImages.length > 0) {
        const firstImage = firstResponse.generatedImages[0];
        base64Image = firstImage.encodedImage || firstImage.image;
        console.log(`[GEM_PIX] Extracted image from batch responses structure`);
      }
    }
    
    if (!base64Image) {
      console.error('[GEM_PIX] No base64 image data in response:', JSON.stringify(result, null, 2));
      throw new Error("No image data received from GEM_PIX API");
    }

    return base64Image;
  }

  // Helper: Generate image using Nano Bana Pro (GEM_PIX_2) model
  // When reference images are provided, uses whisk:runImageRecipe endpoint
  async function generateWithGemPixPro(
    apiKey: string,
    prompt: string,
    aspectRatio: string,
    previousScenePrompt?: string,
    referenceMediaIds?: string[]
  ): Promise<string> {
    const workflowId = crypto.randomUUID();
    const sessionId = `;${Date.now()}`;
    
    // Combine current prompt with simplified previous scene context for visual continuity
    let finalPrompt = prompt;
    if (previousScenePrompt) {
      const simplifiedContext = previousScenePrompt.substring(0, 200).trim();
      finalPrompt = `Continuing from previous scene (${simplifiedContext}...). ${prompt}`;
      console.log(`[GEM_PIX_2] Added simplified previous scene context for continuity`);
    }
    
    const seed = Math.floor(Math.random() * 1000000);

    // If reference images are provided, use whisk:runImageRecipe (same as MediaGen)
    if (referenceMediaIds && referenceMediaIds.length > 0) {
      console.log(`[GEM_PIX_2] Using runImageRecipe with ${referenceMediaIds.length} reference images`);
      
      // Build recipeMediaInputs from media IDs
      const recipeMediaInputs = referenceMediaIds.map((mediaId, index) => ({
        caption: `reference ${index + 1}`,
        mediaInput: {
          mediaCategory: "MEDIA_CATEGORY_SUBJECT",
          mediaGenerationId: mediaId
        }
      }));
      
      const recipeRequestBody = {
        clientContext: {
          workflowId: workflowId,
          tool: "BACKBONE",
          sessionId: sessionId
        },
        seed: seed,
        imageModelSettings: {
          imageModel: "GEM_PIX_2",
          aspectRatio: aspectRatio
        },
        userInstruction: finalPrompt,
        recipeMediaInputs: recipeMediaInputs
      };
      
      const recipeApiUrl = "https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe";
      
      const response = await fetch(recipeApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(recipeRequestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GEM_PIX_2 Recipe] API error ${response.status}:`, errorText);
        throw new Error(`GEM_PIX_2 Recipe API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`[GEM_PIX_2 Recipe] Received response from Google AI`);

      // Extract base64 image from runImageRecipe response
      let base64Image: string | undefined;
      if (result.imagePanels && result.imagePanels.length > 0) {
        const firstPanel = result.imagePanels[0];
        if (firstPanel.generatedImages && firstPanel.generatedImages.length > 0) {
          const firstImage = firstPanel.generatedImages[0];
          base64Image = firstImage.encodedImage || firstImage.image;
          console.log(`[GEM_PIX_2 Recipe] Extracted image from imagePanels structure`);
        }
      }
      
      if (!base64Image) {
        base64Image = result.encodedImage || result.image?.base64 || result.base64 || result.imageData || result.data;
      }
      
      if (!base64Image) {
        console.error('[GEM_PIX_2 Recipe] No base64 image data in response:', JSON.stringify(result, null, 2));
        throw new Error("No image data received from GEM_PIX_2 Recipe API");
      }

      return base64Image;
    }

    // Standard flow without reference images - use flowMedia:batchGenerateImages
    const projectId = process.env.GEM_PIX_PROJECT_ID || "adc73f1d-c784-4817-8db0-4961c1f0f3ca";
    const apiUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`;

    const requestBody = {
      requests: [{
        clientContext: {
          sessionId: sessionId
        },
        seed: seed,
        imageModelName: "GEM_PIX_2",
        imageAspectRatio: aspectRatio,
        prompt: finalPrompt,
        imageInputs: []
      }]
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GEM_PIX_2] API error ${response.status}:`, errorText);
      throw new Error(`GEM_PIX_2 API returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[GEM_PIX_2] Received response from Google AI`);

    // Extract base64 image from GEM_PIX_2 response structure
    let base64Image: string | undefined;
    
    if (result.media && result.media.length > 0) {
      const mediaItem = result.media[0];
      if (mediaItem.image?.generatedImage?.encodedImage) {
        base64Image = mediaItem.image.generatedImage.encodedImage;
        console.log(`[GEM_PIX_2] Extracted base64 from media[0].image.generatedImage.encodedImage`);
      } else if (mediaItem.image) {
        base64Image = mediaItem.image;
        console.log(`[GEM_PIX_2] Extracted image directly from media[0].image`);
      }
    } else if (result.responses && result.responses.length > 0) {
      const firstResponse = result.responses[0];
      if (firstResponse.generatedImages && firstResponse.generatedImages.length > 0) {
        const firstImage = firstResponse.generatedImages[0];
        base64Image = firstImage.encodedImage || firstImage.image;
        console.log(`[GEM_PIX_2] Extracted image from batch responses structure`);
      }
    }
    
    if (!base64Image) {
      console.error('[GEM_PIX_2] No base64 image data in response:', JSON.stringify(result, null, 2));
      throw new Error("No image data received from GEM_PIX_2 API");
    }

    return base64Image;
  }

  // Helper: Generate image using IMAGEN_4 (IMAGEN_3_5) model
  // When reference images are provided, uses whisk:runImageRecipe endpoint
  async function generateWithImagen4(
    apiKey: string,
    prompt: string,
    aspectRatio: string,
    previousScenePrompt?: string,
    referenceMediaIds?: string[]
  ): Promise<string> {
    const workflowId = crypto.randomUUID();
    const sessionId = `;${Date.now()}`;
    
    // Combine current prompt with simplified previous scene context for visual continuity
    let finalPrompt = prompt;
    if (previousScenePrompt) {
      const simplifiedContext = previousScenePrompt.substring(0, 200).trim();
      finalPrompt = `Continuing from previous scene (${simplifiedContext}...). ${prompt}`;
      console.log(`[IMAGEN_4] Added simplified previous scene context for continuity`);
    }
    
    const seed = Math.floor(Math.random() * 1000000);

    // If reference images are provided, use whisk:runImageRecipe (same as MediaGen)
    if (referenceMediaIds && referenceMediaIds.length > 0) {
      console.log(`[IMAGEN_4] Using runImageRecipe with ${referenceMediaIds.length} reference images`);
      
      // Build recipeMediaInputs from media IDs - use SUBJECT category for character consistency
      const recipeMediaInputs = referenceMediaIds.map((mediaId, index) => ({
        caption: `character reference ${index + 1}`,
        mediaInput: {
          mediaCategory: "MEDIA_CATEGORY_SUBJECT",
          mediaGenerationId: mediaId
        }
      }));
      
      // Enhance prompt to explicitly use the character from reference
      const enhancedPrompt = `Using the exact same character/person from the reference image: ${finalPrompt}`;
      console.log(`[IMAGEN_4 Recipe] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      
      const recipeRequestBody = {
        clientContext: {
          workflowId: workflowId,
          tool: "BACKBONE",
          sessionId: sessionId
        },
        seed: seed,
        imageModelSettings: {
          imageModel: "IMAGEN_3_5",
          aspectRatio: aspectRatio
        },
        userInstruction: enhancedPrompt,
        recipeMediaInputs: recipeMediaInputs
      };
      
      const recipeApiUrl = "https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe";
      
      const response = await fetch(recipeApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(recipeRequestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IMAGEN_4 Recipe] API error ${response.status}:`, errorText);
        throw new Error(`IMAGEN_4 Recipe API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`[IMAGEN_4 Recipe] Received response from Google AI`);

      // Extract base64 image from runImageRecipe response
      let base64Image: string | undefined;
      if (result.imagePanels && result.imagePanels.length > 0) {
        const firstPanel = result.imagePanels[0];
        if (firstPanel.generatedImages && firstPanel.generatedImages.length > 0) {
          const firstImage = firstPanel.generatedImages[0];
          base64Image = firstImage.encodedImage || firstImage.image;
          console.log(`[IMAGEN_4 Recipe] Extracted image from imagePanels structure`);
        }
      }
      
      if (!base64Image) {
        base64Image = result.encodedImage || result.image?.base64 || result.base64 || result.imageData || result.data;
      }
      
      if (!base64Image) {
        console.error('[IMAGEN_4 Recipe] No base64 image data in response:', JSON.stringify(result, null, 2));
        throw new Error("No image data received from IMAGEN_4 Recipe API");
      }

      return base64Image;
    }

    // Standard flow without reference images - use flowMedia:batchGenerateImages
    const projectId = process.env.GEM_PIX_PROJECT_ID || "881d362b-300e-4b8b-aab4-0dab0cf875d8";
    const apiUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`;

    const requestBody = {
      requests: [{
        clientContext: {
          sessionId: sessionId
        },
        seed: seed,
        imageModelName: "IMAGEN_3_5",
        imageAspectRatio: aspectRatio,
        prompt: finalPrompt,
        imageInputs: []
      }]
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[IMAGEN_4] API error ${response.status}:`, errorText);
      throw new Error(`IMAGEN_4 API returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[IMAGEN_4] Received response from Google AI`);

    // Extract base64 image from IMAGEN_4 response structure
    let base64Image: string | undefined;
    
    if (result.media && result.media.length > 0) {
      const mediaItem = result.media[0];
      if (mediaItem.image?.generatedImage?.encodedImage) {
        base64Image = mediaItem.image.generatedImage.encodedImage;
        console.log(`[IMAGEN_4] Extracted base64 from media[0].image.generatedImage.encodedImage`);
      } else if (mediaItem.image) {
        base64Image = mediaItem.image;
        console.log(`[IMAGEN_4] Extracted image directly from media[0].image`);
      }
    } else if (result.responses && result.responses.length > 0) {
      const firstResponse = result.responses[0];
      if (firstResponse.generatedImages && firstResponse.generatedImages.length > 0) {
        const firstImage = firstResponse.generatedImages[0];
        base64Image = firstImage.encodedImage || firstImage.image;
        console.log(`[IMAGEN_4] Extracted image from batch responses structure`);
      }
    }
    
    if (!base64Image) {
      console.error('[IMAGEN_4] No base64 image data in response:', JSON.stringify(result, null, 2));
      throw new Error("No image data received from IMAGEN_4 API");
    }

    return base64Image;
  }

  // Convert image to media ID endpoint (for reference images)
  // Uses Google AI sandbox API to upload reference images for text-to-image generation
  // IMPORTANT: Returns tokenId which MUST be used for subsequent image generation
  // Accepts optional tokenIndex for batch mode to ensure different tokens for each request
  app.post("/api/convert-image-to-media-id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const schema = z.object({
        imageBase64: z.string().min(1, "Image data is required"),
        imageMimeType: z.string().min(1, "MIME type is required"),
        tokenIndex: z.number().optional(), // For batch mode: ensures different token per request
        tokenId: z.string().optional() // For token consistency: reuse the same token for multiple reference images
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { imageBase64, imageMimeType, tokenIndex, tokenId: requestedTokenId } = validationResult.data;

      console.log(`[Image to Media ID] Converting image (${imageMimeType}), tokenIndex: ${tokenIndex ?? 'auto'}, tokenId: ${requestedTokenId ?? 'auto'}`);

      // Get API key - priority: tokenId (consistency) > tokenIndex (batch mode) > rotation
      let rotationToken;
      if (requestedTokenId) {
        // Token consistency mode: Use the same token that was used for previous reference images
        const specificToken = await storage.getTokenById(requestedTokenId);
        if (specificToken && specificToken.isActive) {
          rotationToken = specificToken;
          console.log(`[Image to Media ID] Token consistency mode - reusing token ${specificToken.label} (ID: ${specificToken.id})`);
        } else {
          console.log(`[Image to Media ID] Requested token ${requestedTokenId} not found or inactive, falling back to rotation`);
          rotationToken = await storage.getNextRotationToken();
        }
      } else if (tokenIndex !== undefined) {
        // Batch mode: Use specific token index for round-robin distribution
        rotationToken = await storage.getTokenByIndex(tokenIndex);
        console.log(`[Image to Media ID] Batch mode - using token index ${tokenIndex}`);
      } else {
        // Single mode: Use normal rotation
        rotationToken = await storage.getNextRotationToken();
      }
      
      const apiKey = rotationToken?.token || process.env.GEMINI_API_KEY;
      const tokenId = rotationToken?.id;

      if (!apiKey) {
        return res.status(500).json({ 
          error: "No API key configured for image upload" 
        });
      }

      console.log(`[Image to Media ID] Using token: ${rotationToken?.label || 'ENV'} (ID: ${tokenId || 'N/A'})`);

      // Upload image to Google AI and get media ID
      const uploadPayload = {
        imageInput: {
          rawImageBytes: imageBase64,
          mimeType: imageMimeType
        }
      };

      const uploadResponse = await fetch('https://aisandbox-pa.googleapis.com/v1:uploadUserImage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(uploadPayload),
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error(`[Image to Media ID] Upload failed: ${errorText}`);
        return res.status(500).json({ 
          error: "Failed to upload image to Google AI",
          details: errorText
        });
      }

      const uploadData = await uploadResponse.json();
      const mediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;

      if (!mediaId) {
        console.error('[Image to Media ID] No media ID in response:', uploadData);
        return res.status(500).json({ 
          error: "No media ID returned from upload" 
        });
      }

      console.log(`[Image to Media ID] Success! Media ID: ${mediaId}, Token ID: ${tokenId}`);

      // Return both mediaId and tokenId - tokenId MUST be used for subsequent image generation
      res.json({ 
        mediaId,
        tokenId: tokenId || null,
        tokenLabel: rotationToken?.label || 'ENV',
        success: true 
      });

    } catch (error) {
      console.error("Error in /api/convert-image-to-media-id:", error);
      res.status(500).json({ 
        error: "Failed to convert image to media ID",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Text to Image endpoint - supports Media, Nano Bana (GEM_PIX), and IMAGEN_4 models
  app.post("/api/text-to-image", requireAuth, async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;
    
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Get user and check plan restrictions
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user can access text-to-image tool
      const toolCheck = canAccessTool(user, "textToImage");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const schema = z.object({
        prompt: z.string().min(3, "Prompt must be at least 3 characters"),
        aspectRatio: z.enum(["IMAGE_ASPECT_RATIO_LANDSCAPE", "IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_SQUARE"]).default("IMAGE_ASPECT_RATIO_LANDSCAPE"),
        previousScenePrompt: z.string().optional(),
        model: z.enum(["imagen", "nanoBana", "nanoBanaPro", "imagen4"]).default("imagen"),
        referenceMediaId: z.string().optional(), // Legacy: single media ID
        referenceMediaIds: z.array(z.string()).max(5).optional(), // New: multiple media IDs
        tokenId: z.string().optional() // For token consistency - use the same token that generated the media ID
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { prompt, aspectRatio, previousScenePrompt, model, referenceMediaId, referenceMediaIds, tokenId } = validationResult.data;

      // Support both legacy single mediaId and new array format
      const mediaIds = referenceMediaIds && referenceMediaIds.length > 0 
        ? referenceMediaIds 
        : (referenceMediaId ? [referenceMediaId] : undefined);

      console.log(`[Text to Image] User: ${user.username}, Plan: ${user.planType}, Model: ${model}, Aspect Ratio: ${aspectRatio}, Prompt: ${prompt}`);
      if (previousScenePrompt) {
        console.log(`[Text to Image] Previous scene prompt: ${previousScenePrompt}`);
      }
      if (mediaIds && mediaIds.length > 0) {
        console.log(`[Text to Image] ${mediaIds.length} reference media IDs provided`);
      }
      if (tokenId) {
        console.log(`[Text to Image] Using specific token ID for consistency: ${tokenId}`);
      }

      // Get token - either specific tokenId (for reference image consistency) or from rotation system
      if (tokenId) {
        // Use specific token for consistency with media ID generation
        const specificToken = await storage.getTokenById(tokenId);
        if (specificToken && specificToken.isActive) {
          rotationToken = specificToken;
          console.log(`[Token Consistency] Using matched token: ${specificToken.label} (ID: ${specificToken.id})`);
        } else {
          console.log(`[Token Consistency] Specified token ${tokenId} not found or inactive, falling back to rotation`);
          rotationToken = await storage.getNextRotationToken();
        }
      } else {
        // Get initial token from rotation system
        rotationToken = await storage.getNextRotationToken();
      }
      
      if (rotationToken) {
        console.log(`[Token Rotation] Using initial token: ${rotationToken.label} (ID: ${rotationToken.id})`);
        await storage.updateTokenUsage(rotationToken.id);
      } else {
        console.log('[Token Rotation] No active tokens found, will use environment variable if available');
      }

      // Use retry function with automatic token rotation
      const result = await retryTextToImageGeneration(
        prompt,
        aspectRatio,
        previousScenePrompt,
        model,
        generateWithMediaGen,
        generateWithGemPix,
        generateWithGemPixPro,
        generateWithImagen4,
        10,
        rotationToken,
        mediaIds
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      const base64Image = result.base64Image;
      rotationToken = result.token;

      // Return base64 image directly (no Cloudinary for text-to-image)
      const extension = 'png'; // Both APIs return PNG
      const dataUrl = `data:image/${extension};base64,${base64Image}`;
      console.log(`[Text to Image] Image generated successfully (no Cloudinary upload)`);

      res.json({ 
        imageUrl: dataUrl,
        prompt,
        aspectRatio,
        model,
        tokenUsed: rotationToken?.label,
        success: true 
      });
    } catch (error) {
      console.error("Error in /api/text-to-image:", error);
      res.status(500).json({ 
        error: "Failed to generate image",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // BATCH Text-to-Image endpoint - processes ALL images server-side for maximum parallelism
  // This bypasses browser's 6 connection limit by handling everything on the server
  app.post("/api/text-to-image/batch", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const toolCheck = canAccessTool(user, "textToImage");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const schema = z.object({
        prompts: z.array(z.string().min(3)).min(1).max(50),
        aspectRatio: z.enum(["IMAGE_ASPECT_RATIO_LANDSCAPE", "IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_SQUARE"]).default("IMAGE_ASPECT_RATIO_LANDSCAPE"),
        model: z.enum(["imagen", "nanoBana", "nanoBanaPro", "imagen4"]).default("nanoBana"),
        referenceImageBase64: z.string().optional(), // Legacy: single image
        referenceImageMimeType: z.string().optional(),
        referenceImagesData: z.array(z.object({
          base64: z.string(),
          mimeType: z.string()
        })).max(5).optional(), // New: multiple images
        isRetry: z.boolean().optional().default(false)
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }

      const { prompts, aspectRatio, model, referenceImageBase64, referenceImageMimeType, referenceImagesData, isRetry } = validationResult.data;
      
      // Support both legacy single image and new array format
      const refImages = referenceImagesData && referenceImagesData.length > 0 
        ? referenceImagesData 
        : (referenceImageBase64 && referenceImageMimeType 
            ? [{ base64: referenceImageBase64, mimeType: referenceImageMimeType }] 
            : []);
      
      // For retry requests, use a random offset to avoid using same tokens that failed
      const tokenOffset = isRetry ? Math.floor(Math.random() * 1000) : 0;
      
      console.log(`[Batch Text-to-Image] Starting batch of ${prompts.length} images, Model: ${model}, User: ${user.username}${isRetry ? ' (RETRY with offset ' + tokenOffset + ')' : ''}`);
      const batchStartTime = Date.now();

      // Get all active tokens for round-robin distribution
      const activeTokens = await storage.getActiveApiTokens();
      if (activeTokens.length === 0) {
        return res.status(500).json({ error: "No active API tokens available" });
      }
      console.log(`[Batch Text-to-Image] Using ${activeTokens.length} active tokens for distribution`);

      // PHASE 1: Generate media IDs for all prompts if reference images provided
      // Each prompt needs its own set of media IDs (one per reference image), all from the SAME token
      type MediaIdData = { mediaIds: string[]; token: typeof activeTokens[0]; promptIndex: number };
      let mediaIdDataList: MediaIdData[] = [];

      // All models support reference images via whisk:runImageRecipe
      if (refImages.length > 0) {
        console.log(`[Batch Phase 1] Generating media IDs for ${prompts.length} prompts with ${refImages.length} reference images each...`);
        
        const mediaIdPromises = prompts.map(async (_, promptIndex) => {
          // CRITICAL: Use SAME token for ALL media IDs of this prompt
          const token = activeTokens[(promptIndex + tokenOffset) % activeTokens.length];
          console.log(`[Phase 1] Prompt ${promptIndex}: Using Token ${token.label} (ID: ${token.id}) for ALL ${refImages.length} media ID uploads`);
          
          try {
            // Upload all reference images with the SAME token
            const uploadPromises = refImages.map(async (refImage, imgIndex) => {
              const uploadPayload = {
                imageInput: {
                  rawImageBytes: refImage.base64,
                  mimeType: refImage.mimeType
                }
              };

              const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(uploadPayload),
              });

              if (uploadResponse.ok) {
                const uploadData = await uploadResponse.json();
                const mediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;
                console.log(`[Phase 1] Prompt ${promptIndex} Image ${imgIndex}: MediaID generated with Token ${token.label}`);
                return mediaId;
              }
              console.error(`[Phase 1] Prompt ${promptIndex} Image ${imgIndex} failed: ${uploadResponse.status}`);
              return null;
            });

            const mediaIds = (await Promise.all(uploadPromises)).filter((id): id is string => id !== null);
            
            if (mediaIds.length > 0) {
              console.log(`[Phase 1] Prompt ${promptIndex}: Generated ${mediaIds.length}/${refImages.length} media IDs with SAME Token ${token.label}`);
              return { mediaIds, token, promptIndex };
            }
            return null;
          } catch (error) {
            console.error(`[Batch Phase 1] Prompt ${promptIndex} error:`, error);
            return null;
          }
        });

        const results = await Promise.all(mediaIdPromises);
        mediaIdDataList = results.filter((r): r is MediaIdData => r !== null);
        console.log(`[Batch Phase 1] Generated media IDs for ${mediaIdDataList.length}/${prompts.length} prompts`);
      }

      // PHASE 2: Generate all images in parallel with concurrency limit
      console.log(`[Batch Phase 2] Generating ${prompts.length} images in parallel...`);
      
      type BatchResult = { 
        prompt: string; 
        status: 'success' | 'failed'; 
        imageUrl?: string; 
        error?: string;
        tokenUsed?: string;
      };

      const generateSingleImage = async (prompt: string, index: number): Promise<BatchResult> => {
        const mediaIdData = mediaIdDataList.find(m => m.promptIndex === index);
        // Use same token as media ID, or apply tokenOffset for retry requests
        const token = mediaIdData?.token || activeTokens[(index + tokenOffset) % activeTokens.length];
        const referenceMediaIds = mediaIdData?.mediaIds || [];

        try {
          // Use retry function with the assigned token
          const result = await retryTextToImageGeneration(
            prompt,
            aspectRatio,
            undefined, // previousScenePrompt
            model,
            generateWithMediaGen,
            generateWithGemPix,
            generateWithGemPixPro,
            generateWithImagen4,
            3, // Max 3 retries per image in batch mode
            token,
            referenceMediaIds.length > 0 ? referenceMediaIds : undefined,
            true // silentMode - no logging until final error
          );

          if (result.success) {
            const dataUrl = `data:image/png;base64,${result.base64Image}`;
            return { prompt, status: 'success', imageUrl: dataUrl, tokenUsed: token.label };
          }
          // Log final error after all 3 silent retries failed
          console.log(`[Batch Image] Image ${index + 1} failed after 3 retries: ${result.error}`);
          return { prompt, status: 'failed', error: result.error, tokenUsed: token.label };
        } catch (error: any) {
          console.log(`[Batch Image] Image ${index + 1} failed with exception: ${error.message}`);
          return { prompt, status: 'failed', error: error.message || 'Unknown error', tokenUsed: token.label };
        }
      };

      // Process images with controlled concurrency - increased for faster generation
      const CONCURRENCY_LIMIT = 25;
      const results: BatchResult[] = [];
      const activePromises: Promise<void>[] = [];
      
      for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        const index = i;
        
        const imagePromise = generateSingleImage(prompt.trim(), index).then(result => {
          results[index] = result;
          const idx = activePromises.indexOf(imagePromise);
          if (idx > -1) activePromises.splice(idx, 1);
        }).catch(error => {
          results[index] = { prompt, status: 'failed' as const, error: error?.message || 'Unknown error' };
          const idx = activePromises.indexOf(imagePromise);
          if (idx > -1) activePromises.splice(idx, 1);
        });
        
        activePromises.push(imagePromise);
        
        if (activePromises.length >= CONCURRENCY_LIMIT) {
          await Promise.race(activePromises);
        }
      }
      
      await Promise.all(activePromises);

      const successCount = results.filter(r => r.status === 'success').length;
      const failedCount = results.filter(r => r.status === 'failed').length;
      const duration = ((Date.now() - batchStartTime) / 1000).toFixed(1);

      console.log(`[Batch Complete] ${successCount}/${prompts.length} succeeded, ${failedCount} failed, Duration: ${duration}s`);

      res.json({
        success: true,
        results,
        summary: {
          total: prompts.length,
          success: successCount,
          failed: failedCount,
          duration: `${duration}s`
        }
      });
    } catch (error) {
      console.error("Error in /api/text-to-image/batch:", error);
      res.status(500).json({ 
        error: "Batch generation failed",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // STREAMING Batch Text-to-Image endpoint - streams results as they complete
  app.post("/api/text-to-image/batch-stream", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const toolCheck = canAccessTool(user, "textToImage");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const schema = z.object({
        prompts: z.array(z.string().min(3)).min(1).max(50),
        aspectRatio: z.enum(["IMAGE_ASPECT_RATIO_LANDSCAPE", "IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_SQUARE"]).default("IMAGE_ASPECT_RATIO_LANDSCAPE"),
        model: z.enum(["imagen", "nanoBana", "nanoBanaPro", "imagen4"]).default("nanoBana"),
        referenceImageBase64: z.string().optional(),
        referenceImageMimeType: z.string().optional(),
        referenceImagesData: z.array(z.object({
          base64: z.string(),
          mimeType: z.string()
        })).max(5).optional(),
        isRetry: z.boolean().optional().default(false)
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }

      const { prompts, aspectRatio, model, referenceImageBase64, referenceImageMimeType, referenceImagesData, isRetry } = validationResult.data;
      
      const tokenOffset = isRetry ? Math.floor(Math.random() * 1000) : 0;
      
      console.log(`[Batch Stream] Starting streaming batch of ${prompts.length} images, Model: ${model}, User: ${user.username}`);
      const batchStartTime = Date.now();

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Transfer-Encoding', 'chunked');
      
      // Disable socket buffering for real-time streaming
      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
      }
      
      res.flushHeaders();

      // Helper to send SSE event
      const sendEvent = (event: string, data: any) => {
        const eventStr = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.write(eventStr);
        console.log(`[SSE] Sent ${event} event, index: ${data.index ?? 'N/A'}`);
      };

      // Get all active tokens
      const activeTokens = await storage.getActiveApiTokens();
      if (activeTokens.length === 0) {
        sendEvent('error', { error: "No active API tokens available" });
        res.end();
        return;
      }

      // PHASE 1: Generate media IDs if reference images provided
      // OPTIMIZED: Upload reference images ONCE and reuse for ALL prompts (up to 25 per token)
      type SharedMediaData = { mediaIds: string[]; token: typeof activeTokens[0] };
      let sharedMediaDataList: SharedMediaData[] = [];

      // Determine which reference images to use (new array format or legacy single image)
      const refImages = referenceImagesData && referenceImagesData.length > 0 
        ? referenceImagesData 
        : (referenceImageBase64 && referenceImageMimeType 
            ? [{ base64: referenceImageBase64, mimeType: referenceImageMimeType }] 
            : []);

      console.log(`[Batch Stream] refImages.length = ${refImages.length}, model = ${model}`);
      if (refImages.length > 0) {
        console.log(`[Batch Stream] Reference image received! Base64 length: ${refImages[0].base64.length}, MimeType: ${refImages[0].mimeType}`);
      }
      
      // OPTIMIZED: Upload reference images ONCE per token, reuse media IDs for 25 prompts each
      const PROMPTS_PER_TOKEN = 25;
      if (refImages.length > 0) {
        const tokensNeeded = Math.ceil(prompts.length / PROMPTS_PER_TOKEN);
        console.log(`[Batch Stream Phase 1] OPTIMIZED: Uploading reference images ${tokensNeeded} time(s) for ${prompts.length} prompts`);
        sendEvent('phase', { phase: 'mediaIds', message: `Uploading ${refImages.length} reference image(s) (optimized: ${tokensNeeded}x instead of ${prompts.length}x)...` });
        
        // Upload reference images once per token group
        for (let tokenGroupIndex = 0; tokenGroupIndex < tokensNeeded; tokenGroupIndex++) {
          const token = activeTokens[(tokenGroupIndex + tokenOffset) % activeTokens.length];
          console.log(`[Phase 1 Optimized] Token group ${tokenGroupIndex + 1}/${tokensNeeded}: Using Token ${token.label} for ${Math.min(PROMPTS_PER_TOKEN, prompts.length - tokenGroupIndex * PROMPTS_PER_TOKEN)} prompts`);
          
          const mediaIds: string[] = [];
          
          for (let imgIndex = 0; imgIndex < refImages.length; imgIndex++) {
            const refImg = refImages[imgIndex];
            try {
              const uploadPayload = {
                imageInput: {
                  rawImageBytes: refImg.base64,
                  mimeType: refImg.mimeType
                }
              };

              const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(uploadPayload),
              });

              if (uploadResponse.ok) {
                const uploadData = await uploadResponse.json();
                const mediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;
                console.log(`[Phase 1 Optimized] Token group ${tokenGroupIndex + 1}, Image ${imgIndex + 1}: Media ID created`);
                mediaIds.push(mediaId);
              } else {
                console.log(`[Phase 1 Optimized] Token group ${tokenGroupIndex + 1}, Image ${imgIndex + 1}: Upload failed`);
              }
            } catch (error) {
              console.log(`[Phase 1 Optimized] Token group ${tokenGroupIndex + 1}, Image ${imgIndex + 1}: Upload error:`, error);
            }
          }
          
          if (mediaIds.length > 0) {
            console.log(`[Phase 1 Optimized] Token group ${tokenGroupIndex + 1}: Created ${mediaIds.length}/${refImages.length} media IDs - Will reuse for ${Math.min(PROMPTS_PER_TOKEN, prompts.length - tokenGroupIndex * PROMPTS_PER_TOKEN)} prompts`);
            sharedMediaDataList.push({ mediaIds, token });
          }
        }
        
        console.log(`[Phase 1 Optimized] COMPLETE: ${sharedMediaDataList.length} token groups ready, each will serve ${PROMPTS_PER_TOKEN} prompts`);
      }

      sendEvent('phase', { phase: 'generation', message: 'Generating images...' });

      // PHASE 2: Generate images and stream results as they complete
      let successCount = 0;
      let failedCount = 0;

      const generateAndStream = async (prompt: string, index: number) => {
        // OPTIMIZED: Determine which token group this prompt belongs to (every 25 prompts share same token/mediaIds)
        const tokenGroupIndex = Math.floor(index / PROMPTS_PER_TOKEN);
        const sharedMediaData = sharedMediaDataList[tokenGroupIndex];
        const token = sharedMediaData?.token || activeTokens[(index + tokenOffset) % activeTokens.length];
        const referenceMediaIds = sharedMediaData?.mediaIds || [];
        
        // Debug: Log token being used for image generation
        if (sharedMediaData) {
          console.log(`[Phase 2 Optimized] Prompt ${index}: Token group ${tokenGroupIndex + 1}, Token ${token.label} - REUSING ${referenceMediaIds.length} mediaIds`);
        } else {
          console.log(`[Phase 2] Prompt ${index}: Using FALLBACK Token ${token.label} (ID: ${token.id}) - No shared media data`);
        }

        try {
          const result = await retryTextToImageGeneration(
            prompt,
            aspectRatio,
            undefined,
            model,
            generateWithMediaGen,
            generateWithGemPix,
            generateWithGemPixPro,
            generateWithImagen4,
            3,
            token,
            referenceMediaIds.length > 0 ? referenceMediaIds : undefined,
            true // silentMode - no logging until final error
          );

          if (result.success) {
            const dataUrl = `data:image/png;base64,${result.base64Image}`;
            successCount++;
            sendEvent('image', { 
              index, 
              prompt, 
              status: 'success', 
              imageUrl: dataUrl,
              progress: { current: successCount + failedCount, total: prompts.length }
            });
          } else {
            failedCount++;
            // Log final error after all retries failed
            console.log(`[Batch Image] Image ${index + 1} failed after 3 retries: ${result.error}`);
            sendEvent('image', { 
              index, 
              prompt, 
              status: 'failed', 
              error: result.error,
              progress: { current: successCount + failedCount, total: prompts.length }
            });
          }
        } catch (error: any) {
          failedCount++;
          sendEvent('image', { 
            index, 
            prompt, 
            status: 'failed', 
            error: error.message || 'Unknown error',
            progress: { current: successCount + failedCount, total: prompts.length }
          });
        }
      };

      // Process images with controlled concurrency for VPS stability
      // Limit to 25 concurrent requests for faster processing
      const CONCURRENCY_LIMIT = 25;
      const activePromises: Promise<void>[] = [];
      
      for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        
        // Create promise for this image
        const imagePromise = generateAndStream(prompt.trim(), i).then(() => {
          // Remove from active promises when done
          const idx = activePromises.indexOf(imagePromise);
          if (idx > -1) activePromises.splice(idx, 1);
        });
        
        activePromises.push(imagePromise);
        
        // If we hit the concurrency limit, wait for one to complete
        if (activePromises.length >= CONCURRENCY_LIMIT) {
          await Promise.race(activePromises);
        }
      }
      
      // Wait for remaining images to complete
      await Promise.all(activePromises);

      const duration = ((Date.now() - batchStartTime) / 1000).toFixed(1);
      console.log(`[Batch Stream Complete] ${successCount}/${prompts.length} succeeded in ${duration}s`);

      sendEvent('complete', {
        success: true,
        summary: {
          total: prompts.length,
          success: successCount,
          failed: failedCount,
          duration: `${duration}s`
        }
      });

      res.end();
    } catch (error) {
      console.error("Error in /api/text-to-image/batch-stream:", error);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Batch generation failed" })}\n\n`);
      res.end();
    }
  });

  // Character Consistent Video Stream - 5-step Whisk API flow (Admin only)
  // Step 1: backbone.uploadImage (cookies) -> uploadMediaGenerationId
  // Step 2: whisk:runImageRecipe (Bearer) -> generated image with character
  // Step 3: uploadUserImage (Bearer) -> new mediaGenerationId
  // Step 4: whisk:generateVideo (Bearer) -> video operation
  // Step 5: batchCheckAsyncVideoGenerationStatus (Bearer) -> poll for completion
  app.post("/api/character-video-stream", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Character consistency is for Empire plan users and admins
      if (!user.isAdmin && user.planType !== 'empire') {
        return res.status(403).json({ error: "Character Consistency is only available for Empire plan users" });
      }

      const schema = z.object({
        prompts: z.array(z.string().min(3)).min(1).max(50),
        aspectRatio: z.enum(["IMAGE_ASPECT_RATIO_LANDSCAPE", "IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_SQUARE"]).default("IMAGE_ASPECT_RATIO_LANDSCAPE"),
        characterImageBase64: z.string().min(100),
        characterImageMimeType: z.string(),
        imagesOnly: z.boolean().optional().default(false)
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }

      const { prompts, aspectRatio, characterImageBase64, characterImageMimeType, imagesOnly } = validationResult.data;
      
      // Generate unique batch ID for this generation request
      const charStreamBatchId = `char-stream-${Date.now()}`;
      
      console.log(`[Character Video Stream] Starting ${prompts.length} prompts, imagesOnly: ${imagesOnly}, User: ${user.username}, batchId: ${charStreamBatchId}`);

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
      }
      res.flushHeaders();

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Get active API token
      const activeTokens = await storage.getActiveApiTokens();
      if (activeTokens.length === 0) {
        sendEvent('error', { error: "No active API tokens available" });
        res.end();
        return;
      }

      const token = activeTokens[0];
      const sessionId = `;${Date.now()}`;
      const workflowId = crypto.randomUUID();

      // STEP 1: Upload character image using uploadUserImage (aisandbox API)
      // This returns mediaGenerationId which can be used with referenceMediaIds for character consistency
      console.log(`[Character Video] Step 1: Uploading character reference image...`);
      sendEvent('progress', { phase: 'uploading_character', message: 'Uploading character reference...' });

      let characterMediaId: string | null = null;
      
      try {
        const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            imageInput: {
              rawImageBytes: characterImageBase64,
              mimeType: characterImageMimeType,
              isUserUploaded: true,
              aspectRatio: aspectRatio
            },
            clientContext: {
              sessionId: sessionId,
              tool: "ASSET_MANAGER"
            }
          }),
        });

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          console.error(`[Character Video] Step 1 failed:`, errorText);
          sendEvent('error', { error: "Failed to upload character image. Please try again." });
          res.end();
          return;
        }

        const uploadData = await uploadResponse.json();
        characterMediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;
        console.log(`[Character Video] Step 1 success: mediaGenerationId = ${characterMediaId?.substring(0, 30)}...`);
        sendEvent('progress', { phase: 'character_uploaded', message: 'Character reference uploaded!' });

      } catch (uploadError: any) {
        console.error(`[Character Video] Step 1 error:`, uploadError);
        sendEvent('error', { error: "Failed to upload character: " + uploadError.message });
        res.end();
        return;
      }

      if (!characterMediaId) {
        sendEvent('error', { error: "No character media ID received" });
        res.end();
        return;
      }

      // Concurrent processing configuration
      const MAX_CONCURRENT = 20;
      let activeCount = 0;
      let nextIndex = 0;
      let completedCount = 0;
      let failedCount = 0;
      let isCancelled = false;
      const promptQueue = prompts.map((prompt, index) => ({ prompt: prompt.trim(), index }));
      
      // Handle client disconnect (abort) - cancel all pending work
      req.on('close', () => {
        if (!res.writableEnded) {
          console.log(`[Character Video] Client disconnected, cancelling ${prompts.length - completedCount - failedCount} pending videos`);
          isCancelled = true;
        }
      });
      
      // Process single prompt function
      const processPrompt = async (prompt: string, index: number) => {
        // Check if cancelled before processing
        if (isCancelled) {
          console.log(`[Character Video ${index}] Skipped - batch cancelled`);
          return;
        }
        
        // Add 1 second delay per video to prevent API throttling
        const delayMs = index * 1000;
        if (delayMs > 0) {
          console.log(`[Character Video ${index}] Waiting ${delayMs/1000}s before starting...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        // Each video gets its OWN token and uploads character image to that token
        // This avoids rate limiting while keeping mediaIds accessible
        const videoToken = activeTokens[index % activeTokens.length];
        console.log(`[Character Video ${index}] Using token: ${videoToken.name || videoToken.id.substring(0, 8)} for all steps`);
        
        // STEP 1B: Upload character image to THIS token (each token needs its own characterMediaId)
        console.log(`[Character Video ${index}] Uploading character to token...`);
        sendEvent('progress', { index, phase: 'uploading_character', message: 'Uploading character reference...' });
        
        let videoCharacterMediaId: string | null = null;
        try {
          const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${videoToken.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              imageInput: {
                rawImageBytes: characterImageBase64,
                mimeType: characterImageMimeType,
                isUserUploaded: true,
                aspectRatio: aspectRatio
              },
              clientContext: {
                sessionId: sessionId,
                tool: "ASSET_MANAGER"
              }
            }),
          });

          if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            console.error(`[Character Video ${index}] Character upload failed:`, errorText);
            sendEvent('result', { index, status: 'failed', error: 'Character upload failed', phase: 'upload' });
            failedCount++;
            return;
          }

          const uploadData = await uploadResponse.json();
          videoCharacterMediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;
          console.log(`[Character Video ${index}] Character uploaded: ${videoCharacterMediaId?.substring(0, 30)}...`);
        } catch (uploadError: any) {
          console.error(`[Character Video ${index}] Character upload error:`, uploadError);
          sendEvent('result', { index, status: 'failed', error: 'Character upload error: ' + uploadError.message, phase: 'upload' });
          failedCount++;
          return;
        }

        if (!videoCharacterMediaId) {
          sendEvent('result', { index, status: 'failed', error: 'No character media ID received', phase: 'upload' });
          failedCount++;
          return;
        }
        
        console.log(`[Character Video ${index}] Processing prompt: ${prompt.substring(0, 50)}...`);
        sendEvent('progress', { index, phase: 'generating_image', message: 'Generating image with character...' });

        try {
          // STEP 2: Generate image with character reference using whisk:runImageRecipe directly
          // This returns both base64 image AND mediaGenerationId for the generated image
          const recipeRequestBody = {
            clientContext: {
              workflowId: workflowId,
              tool: "BACKBONE",
              sessionId: sessionId
            },
            seed: Math.floor(Math.random() * 1000000),
            imageModelSettings: {
              imageModel: "GEM_PIX",
              aspectRatio: aspectRatio
            },
            userInstruction: `Using the exact same character/person from the reference image: ${prompt}`,
            recipeMediaInputs: [{
              caption: "character reference",
              mediaInput: {
                mediaCategory: "MEDIA_CATEGORY_SUBJECT",
                mediaGenerationId: videoCharacterMediaId
              }
            }]
          };

          // Use same videoToken for all steps - mediaIds are token-specific
          const recipeResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${videoToken.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(recipeRequestBody),
          });

          if (!recipeResponse.ok) {
            const errorText = await recipeResponse.text();
            console.error(`[Character Video ${index}] Step 2 failed:`, errorText);
            sendEvent('result', { index, status: 'failed', error: `Image generation failed: ${recipeResponse.status}`, phase: 'image' });
            failedCount++;
            return;
          }

          const recipeResult = await recipeResponse.json();
          
          // Extract base64 image AND mediaGenerationId from response
          let encodedImage: string | undefined;
          let generatedMediaId: string | undefined;
          
          if (recipeResult.imagePanels && recipeResult.imagePanels.length > 0) {
            const firstPanel = recipeResult.imagePanels[0];
            if (firstPanel.generatedImages && firstPanel.generatedImages.length > 0) {
              const firstImage = firstPanel.generatedImages[0];
              encodedImage = firstImage.encodedImage || firstImage.image;
              // Extract mediaGenerationId from the generated image
              generatedMediaId = firstImage.mediaGenerationId?.mediaGenerationId || firstImage.mediaGenerationId;
              console.log(`[Character Video ${index}] Step 2: Got mediaId from response: ${generatedMediaId?.substring(0, 30)}...`);
            }
          }

          if (!encodedImage) {
            console.error(`[Character Video ${index}] Step 2: No image in response`);
            sendEvent('result', { index, status: 'failed', error: 'No image data in response', phase: 'image' });
            failedCount++;
            return;
          }

          const imageDataUrl = `data:image/png;base64,${encodedImage}`;
          console.log(`[Character Video ${index}] Step 2 success: Image generated (${Math.round(encodedImage.length / 1024)}KB), mediaId: ${generatedMediaId ? 'YES' : 'NO'}`);
          sendEvent('progress', { index, phase: 'image_complete', imageUrl: imageDataUrl, message: 'Image generated!' });

          // If imagesOnly mode, stop here
          if (imagesOnly) {
            sendEvent('result', { index, status: 'completed', imageUrl: imageDataUrl, phase: 'image_only' });
            completedCount++;
            return;
          }

          // Check if cancelled after image generation
          if (isCancelled) {
            console.log(`[Character Video ${index}] Cancelled after image generation`);
            return;
          }

          // STEP 3 SKIPPED: Using mediaId from Step 2 directly
          // No separate upload needed - generatedMediaId already available from runImageRecipe response
          console.log(`[Character Video ${index}] Step 3: SKIPPED - Using mediaId from Step 2: ${generatedMediaId?.substring(0, 30)}...`);

          // STEP 4: Generate video using whisk:generateVideo
          // Using generatedMediaId from Step 2 (runImageRecipe response)
          console.log(`[Character Video ${index}] Step 4: Starting video generation with mediaId from Step 2...`);
          sendEvent('progress', { index, phase: 'generating_video', message: 'Generating video...' });

          const videoAspect = aspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE";
          const sceneId = crypto.randomUUID();

          const videoPayload = {
            clientContext: {
              sessionId: sessionId,
              tool: "BACKBONE",
              workflowId: workflowId
            },
            promptImageInput: {
              prompt: prompt,
              rawBytes: encodedImage,
              mediaGenerationId: generatedMediaId || characterMediaId  // Prefer Step 2 mediaId, fallback to Step 1
            },
            modelNameType: "VEO_3_1_I2V_12STEP",
            modelKey: "",
            userInstructions: prompt,
            loopVideo: false
          };

          // Use same videoToken for video generation - generatedMediaId belongs to this token
          const videoResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${videoToken.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(videoPayload),
          });

          if (!videoResponse.ok) {
            const errorText = await videoResponse.text();
            console.error(`[Character Video ${index}] Step 4 failed:`, errorText);
            sendEvent('result', { index, status: 'failed', error: 'Video generation failed to start', imageUrl: imageDataUrl, phase: 'video_start' });
            failedCount++;
            return;
          }

          const videoData = await videoResponse.json();
          const operationName = videoData.operation?.operation?.name || videoData.operation?.name;
          console.log(`[Character Video ${index}] Step 4 success: Video operation started = ${operationName}`);

          // Create history entry with scene number and batch ID for proper ordering
          const historyEntry = await storage.addVideoHistory({
            userId,
            prompt,
            aspectRatio: videoAspect,
            status: 'pending',
            title: `Character Consistent Video`,
            tokenUsed: videoToken.id,
            sceneNumber: index + 1, // 1-based scene number matching prompt order
            batchId: charStreamBatchId, // Group videos from same batch together
          });

          // STEP 5: Poll for video completion (use same token)
          console.log(`[Character Video ${index}] Step 5: Polling for video completion...`);
          sendEvent('progress', { index, phase: 'polling', message: 'Waiting for video...', historyId: historyEntry.id });

          let videoCompleted = false;
          let videoUrl: string | undefined;
          let pollAttempts = 0;
          const maxPolls = 60; // 5 minutes max (5 sec intervals)

          while (!videoCompleted && pollAttempts < maxPolls && !isCancelled) {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            
            // Check if cancelled during polling
            if (isCancelled) {
              console.log(`[Character Video ${index}] Polling cancelled - batch cancelled`);
              sendEvent('result', { index, status: 'failed', error: 'Cancelled - new batch started', imageUrl: imageDataUrl, phase: 'cancelled' });
              failedCount++;
              return;
            }
            
            pollAttempts++;

            try {
              const statusPayload = {
                operations: [{
                  operation: { name: operationName },
                  sceneId: sceneId,
                  status: "MEDIA_GENERATION_STATUS_PENDING"
                }]
              };

              const statusResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${videoToken.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(statusPayload),
              });

              if (!statusResponse.ok) {
                console.log(`[Character Video ${index}] Poll ${pollAttempts} failed, retrying...`);
                continue;
              }

              const statusData = await statusResponse.json();
              const operation = statusData.operations?.[0];
              const status = operation?.status;

              if (status === "MEDIA_GENERATION_STATUS_SUCCEEDED" || status === "SUCCEEDED" || status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
                // First check for fifeUrl (direct Google URL - preferred)
                const fifeUrl = operation?.operation?.metadata?.video?.fifeUrl;
                const encodedVideo = operation?.result?.video?.encodedVideo;
                
                if (fifeUrl) {
                  // Use direct Google URL (no upload needed)
                  const decodedUrl = fifeUrl.replace(/&amp;/g, '&');
                  console.log(`[Character Video ${index}] Video complete with fifeUrl, using direct URL`);
                  videoUrl = decodedUrl;
                  await storage.updateVideoHistoryStatus(historyEntry.id, String(userId), 'completed', videoUrl);
                } else if (encodedVideo) {
                  console.log(`[Character Video ${index}] Video complete, uploading to storage...`);
                  const uploadResult = await uploadBase64VideoWithFallback(encodedVideo, `character_${index}_${Date.now()}`);
                  videoUrl = uploadResult?.url;
                  
                  if (videoUrl) {
                    await storage.updateVideoHistoryStatus(historyEntry.id, String(userId), 'completed', videoUrl);
                  } else {
                    await storage.updateVideoHistoryStatus(historyEntry.id, String(userId), 'failed', undefined, 'Video upload failed');
                  }
                } else {
                  await storage.updateVideoHistoryStatus(historyEntry.id, String(userId), 'failed', undefined, 'No video data received');
                }
                videoCompleted = true;
              } else if (status === "MEDIA_GENERATION_STATUS_FAILED" || status === "FAILED") {
                console.error(`[Character Video ${index}] Video generation failed`);
                await storage.updateVideoHistoryStatus(historyEntry.id, String(userId), 'failed');
                sendEvent('result', { index, status: 'failed', error: 'Video generation failed', imageUrl: imageDataUrl, phase: 'video_failed' });
                videoCompleted = true;
              } else {
                console.log(`[Character Video ${index}] Poll ${pollAttempts}: Status = ${status}`);
              }
            } catch (pollError) {
              console.error(`[Character Video ${index}] Poll error:`, pollError);
            }
          }

          if (videoUrl) {
            console.log(`[Character Video ${index}] Complete! Video URL: ${videoUrl}`);
            sendEvent('result', { index, status: 'completed', imageUrl: imageDataUrl, videoUrl: videoUrl, historyId: historyEntry.id, phase: 'complete' });
            completedCount++;
          } else if (!videoCompleted) {
            console.log(`[Character Video ${index}] Timed out waiting for video`);
            await storage.updateVideoHistoryStatus(historyEntry.id, String(userId), 'failed');
            sendEvent('result', { index, status: 'failed', error: 'Video generation timed out', imageUrl: imageDataUrl, phase: 'timeout' });
            failedCount++;
          }

        } catch (error: any) {
          console.error(`[Character Video ${index}] Error:`, error);
          sendEvent('result', { index, status: 'failed', error: error.message || 'Unknown error' });
          failedCount++;
        }
      };

      // Start concurrent workers
      const startNext = () => {
        while (activeCount < MAX_CONCURRENT && nextIndex < promptQueue.length) {
          const item = promptQueue[nextIndex];
          nextIndex++;
          activeCount++;
          
          processPrompt(item.prompt, item.index).finally(() => {
            activeCount--;
            sendEvent('queue_status', { 
              active: activeCount, 
              completed: completedCount, 
              failed: failedCount, 
              total: prompts.length,
              remaining: prompts.length - completedCount - failedCount
            });
            
            // Start next prompt when slot available
            if (nextIndex < promptQueue.length) {
              startNext();
            }
            
            // Check if all done
            if (completedCount + failedCount === prompts.length) {
              sendEvent('complete', { 
                message: 'All prompts processed',
                completed: completedCount,
                failed: failedCount,
                total: prompts.length
              });
              res.end();
            }
          });
        }
      };

      // Initialize concurrent processing
      console.log(`[Character Video] Starting concurrent processing: ${prompts.length} prompts, max ${MAX_CONCURRENT} concurrent`);
      startNext();

    } catch (error: any) {
      console.error("[Character Video Stream] Error:", error);
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message || "Generation failed" })}\n\n`);
        res.end();
      } catch (writeError) {
        console.error("[Character Video Stream] Error writing SSE:", writeError);
        if (!res.headersSent) {
          res.status(500).json({ error: "Generation failed" });
        }
      }
    }
  });

  // Video download proxy - bypasses CORS restrictions for direct download
  app.post("/api/download-video", requireAuth, async (req, res) => {
    try {
      const { videoUrl, filename } = req.body;
      
      if (!videoUrl || typeof videoUrl !== 'string') {
        return res.status(400).json({ error: "Video URL is required" });
      }

      console.log(`[Download Video] Proxying download for: ${videoUrl.substring(0, 100)}...`);

      const response = await fetch(videoUrl);
      
      if (!response.ok) {
        console.error(`[Download Video] Failed to fetch: ${response.status}`);
        return res.status(response.status).json({ error: "Failed to fetch video" });
      }

      const contentType = response.headers.get('content-type') || 'video/mp4';
      const contentLength = response.headers.get('content-length');
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename || 'video.mp4'}"`);
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      // Stream the response body directly to client
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
      
      console.log(`[Download Video] Successfully proxied video (${Math.round(buffer.byteLength / 1024)}KB)`);
    } catch (error: any) {
      console.error("[Download Video] Error:", error);
      res.status(500).json({ error: error.message || "Download failed" });
    }
  });

  // Bulk Video Generation Stream - Same as character consistency but without character reference
  // Flow: text-to-image -> upload image -> whisk:generateVideo -> poll for completion
  app.post("/api/bulk-video-stream", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Only Empire and Enterprise users can access Bulk Video Generation
      const toolCheck = canAccessTool(user, "bulk");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason || "This tool is only available for Empire plan users. Please upgrade your plan." });
      }

      const schema = z.object({
        prompts: z.array(z.string().min(3)).min(1).max(100),
        aspectRatio: z.enum(["IMAGE_ASPECT_RATIO_LANDSCAPE", "IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_SQUARE"]).default("IMAGE_ASPECT_RATIO_LANDSCAPE"),
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }

      const { prompts, aspectRatio } = validationResult.data;
      
      console.log(`[Bulk Video Stream] Starting ${prompts.length} prompts, User: ${user.username}`);

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
      }
      res.flushHeaders();

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Get active API token
      const activeTokens = await storage.getActiveApiTokens();
      if (activeTokens.length === 0) {
        sendEvent('error', { error: "No active API tokens available" });
        res.end();
        return;
      }

      const token = activeTokens[0];
      const sessionId = `;${Date.now()}`;
      const workflowId = crypto.randomUUID();

      // CRITICAL FIX: Create ALL video history entries UPFRONT so they appear in History immediately
      console.log(`[Bulk Video Stream] Creating ${prompts.length} video entries upfront...`);
      const videoEntries: Array<{ id: string; prompt: string; index: number }> = [];
      const streamBatchId = `stream-batch-${Date.now()}`; // Unique batch ID for this stream request
      
      for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i].trim();
        const videoAspect = (aspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT" || aspectRatio === "portrait" || aspectRatio === "9:16")
          ? "VIDEO_ASPECT_RATIO_PORTRAIT" 
          : "VIDEO_ASPECT_RATIO_LANDSCAPE";
        
        const historyEntry = await storage.addVideoHistory({
          userId,
          prompt,
          aspectRatio: videoAspect,
          status: 'pending',
          title: `Bulk Video Scene ${i + 1}`,
          tokenUsed: token.id,
          sceneNumber: i + 1, // Sequential scene number
          batchId: streamBatchId // Group videos from same batch together
        });
        
        videoEntries.push({ id: historyEntry.id, prompt, index: i });
      }
      
      console.log(`[Bulk Video Stream] Created ${videoEntries.length} video entries in database`);
      sendEvent('entries_created', { count: videoEntries.length, message: 'All video entries created - check History page!' });

      // Concurrent processing configuration
      const MAX_CONCURRENT = 20;
      let activeCount = 0;
      let nextIndex = 0;
      let completedCount = 0;
      let failedCount = 0;
      const promptQueue = videoEntries.map((entry) => ({ 
        prompt: entry.prompt, 
        index: entry.index, 
        historyId: entry.id 
      }));
      
      // Process single prompt function with retry logic (similar to BulkFlow)
      const MAX_RETRIES = 3;
      
      const processPrompt = async (prompt: string, index: number, historyId: string) => {
        console.log(`[Bulk Video ${index}] Processing prompt: ${prompt.substring(0, 50)}...`);
        sendEvent('progress', { index, phase: 'generating_image', message: 'Generating image...', historyId });

        // Normalize aspect ratio (accept both short and long formats)
        const imageAspectRatio = (aspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT" || aspectRatio === "portrait" || aspectRatio === "9:16")
          ? "IMAGE_ASPECT_RATIO_PORTRAIT" 
          : "IMAGE_ASPECT_RATIO_LANDSCAPE";

        const usedTokenIds = new Set<string>();
        let lastError = '';
        let encodedImage: string | undefined;
        let mediaGenerationId: string | undefined;
        let imageDataUrl: string | undefined;
        let currentToken = activeTokens[index % activeTokens.length] || token;

        // Retry loop for image generation
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          // Get a different token if previous failed
          if (attempt > 1) {
            const availableTokens = activeTokens.filter(t => !usedTokenIds.has(t.id));
            if (availableTokens.length > 0) {
              currentToken = availableTokens[Math.floor(Math.random() * availableTokens.length)];
            }
          }
          usedTokenIds.add(currentToken.id);
          
          const promptWorkflowId = crypto.randomUUID();
          const promptSessionId = `;${Date.now()}-${index}-${attempt}`;
          const seed = Math.floor(Math.random() * 1000000);

          try {
            // STEP 1: Generate image using whisk:generateImage (same as BulkFlow - more reliable)
            const imageRequestBody = {
              clientContext: {
                workflowId: promptWorkflowId,
                tool: "BACKBONE",
                sessionId: promptSessionId
              },
              imageModelSettings: {
                imageModel: "IMAGEN_3_5",
                aspectRatio: imageAspectRatio
              },
              seed: seed,
              prompt: prompt,
              mediaCategory: "MEDIA_CATEGORY_BOARD"
            };

            const imageResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateImage", {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${currentToken.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(imageRequestBody),
            });

            if (!imageResponse.ok) {
              const errorText = await imageResponse.text();
              lastError = `Image generation failed: ${imageResponse.status}`;
              console.log(`[Bulk Video ${index}] Attempt ${attempt}/${MAX_RETRIES} failed:`, errorText.substring(0, 100));
              storage.recordTokenError(currentToken.id);
              if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
                continue;
              }
            } else {
              const imageData = await imageResponse.json();
              
              if (!imageData.imagePanels || imageData.imagePanels.length === 0 || 
                  !imageData.imagePanels[0].generatedImages || imageData.imagePanels[0].generatedImages.length === 0) {
                lastError = 'No image generated from API';
                console.log(`[Bulk Video ${index}] Attempt ${attempt}/${MAX_RETRIES}: No image in response`);
                if (attempt < MAX_RETRIES) {
                  await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
                  continue;
                }
              } else {
                const generatedImage = imageData.imagePanels[0].generatedImages[0];
                encodedImage = generatedImage.encodedImage;
                mediaGenerationId = generatedImage.mediaGenerationId;
                imageDataUrl = `data:image/png;base64,${encodedImage}`;
                console.log(`[Bulk Video ${index}] Step 1 success (attempt ${attempt}): Image generated (${Math.round(encodedImage.length / 1024)}KB)`);
                sendEvent('progress', { index, phase: 'image_complete', imageUrl: imageDataUrl, message: 'Image generated!' });
                break; // Success, exit retry loop
              }
            }
          } catch (err: any) {
            lastError = err.message || 'Network error';
            console.log(`[Bulk Video ${index}] Attempt ${attempt}/${MAX_RETRIES} error:`, lastError);
            storage.recordTokenError(currentToken.id);
            if (attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
              continue;
            }
          }
        }

        // Check if image generation succeeded
        if (!encodedImage || !mediaGenerationId) {
          console.error(`[Bulk Video ${index}] Step 1 failed after ${MAX_RETRIES} attempts: ${lastError}`);
          await storage.updateVideoHistoryStatus(historyId, String(userId), 'failed', undefined, lastError || 'Image generation failed');
          sendEvent('result', { index, status: 'failed', error: lastError || 'Image generation failed', phase: 'image', historyId });
          failedCount++;
          return;
        }
        
        // Update token usage
        await storage.updateTokenUsage(currentToken.id);

        try {
          // STEP 2: Generate video using whisk:generateVideo (same as BulkFlow)
          console.log(`[Bulk Video ${index}] Step 2: Starting video generation...`);
          sendEvent('progress', { index, phase: 'generating_video', message: 'Generating video...' });

          const videoAspect = imageAspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE";
          const sceneId = crypto.randomUUID();
          const videoWorkflowId = crypto.randomUUID();
          const videoSessionId = `;${Date.now()}-video-${index}`;

          const videoPayload = {
            clientContext: {
              sessionId: videoSessionId,
              tool: "BACKBONE",
              workflowId: videoWorkflowId
            },
            promptImageInput: {
              prompt: prompt,
              rawBytes: encodedImage,
              mediaGenerationId: mediaGenerationId
            },
            modelNameType: "VEO_3_1_I2V_12STEP",
            modelKey: "",
            userInstructions: prompt,
            loopVideo: false
          };

          const videoResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${currentToken.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(videoPayload),
          });

          if (!videoResponse.ok) {
            const errorText = await videoResponse.text();
            console.error(`[Bulk Video ${index}] Step 2 failed:`, errorText);
            sendEvent('result', { index, status: 'failed', error: 'Video generation failed to start', imageUrl: imageDataUrl, phase: 'video_start' });
            failedCount++;
            return;
          }

          const videoData = await videoResponse.json();
          const operationName = videoData.operation?.operation?.name || videoData.operation?.name;
          console.log(`[Bulk Video ${index}] Step 2 success: Video operation started`);

          // Update existing history entry status to 'generating'
          await storage.updateVideoHistoryStatus(historyId, String(userId), 'generating');

          // STEP 3: Poll for video completion
          console.log(`[Bulk Video ${index}] Step 3: Polling for video completion...`);
          sendEvent('progress', { index, phase: 'polling', message: 'Waiting for video...', historyId });

          let videoCompleted = false;
          let videoUrl: string | undefined;
          let pollAttempts = 0;
          const maxPolls = 60; // 5 minutes max

          while (!videoCompleted && pollAttempts < maxPolls) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            pollAttempts++;

            try {
              const statusPayload = {
                operations: [{
                  operation: { name: operationName },
                  sceneId: sceneId,
                  status: "MEDIA_GENERATION_STATUS_PENDING"
                }]
              };

              const statusResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${currentToken.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(statusPayload),
              });

              if (!statusResponse.ok) {
                console.log(`[Bulk Video ${index}] Poll ${pollAttempts} failed, retrying...`);
                continue;
              }

              const statusData = await statusResponse.json();
              const operation = statusData.operations?.[0];
              const status = operation?.status;

              if (status === "MEDIA_GENERATION_STATUS_SUCCEEDED" || status === "SUCCEEDED" || status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
                const fifeUrl = operation?.operation?.metadata?.video?.fifeUrl;
                const encodedVideo = operation?.result?.video?.encodedVideo;
                
                if (fifeUrl) {
                  const decodedUrl = fifeUrl.replace(/&amp;/g, '&');
                  console.log(`[Bulk Video ${index}] Video complete with fifeUrl`);
                  videoUrl = decodedUrl;
                  await storage.updateVideoHistoryStatus(historyId, String(userId), 'completed', videoUrl);
                } else if (encodedVideo) {
                  console.log(`[Bulk Video ${index}] Video complete, uploading to storage...`);
                  const uploadResult = await uploadBase64VideoWithFallback(encodedVideo, `bulk_${index}_${Date.now()}`);
                  videoUrl = uploadResult?.url;
                  
                  if (videoUrl) {
                    await storage.updateVideoHistoryStatus(historyId, String(userId), 'completed', videoUrl);
                  } else {
                    await storage.updateVideoHistoryStatus(historyId, String(userId), 'failed', undefined, 'Video upload failed');
                  }
                } else {
                  await storage.updateVideoHistoryStatus(historyId, String(userId), 'failed', undefined, 'No video data received');
                }
                videoCompleted = true;
              } else if (status === "MEDIA_GENERATION_STATUS_FAILED" || status === "FAILED") {
                console.error(`[Bulk Video ${index}] Video generation failed`);
                await storage.updateVideoHistoryStatus(historyId, String(userId), 'failed');
                sendEvent('result', { index, status: 'failed', error: 'Video generation failed', imageUrl: imageDataUrl, phase: 'video_failed', historyId });
                videoCompleted = true;
              } else {
                console.log(`[Bulk Video ${index}] Poll ${pollAttempts}: Status = ${status}`);
              }
            } catch (pollError) {
              console.error(`[Bulk Video ${index}] Poll error:`, pollError);
            }
          }

          if (videoUrl) {
            console.log(`[Bulk Video ${index}] Complete! Video URL: ${videoUrl}`);
            sendEvent('result', { index, status: 'completed', imageUrl: imageDataUrl, videoUrl: videoUrl, historyId, phase: 'complete' });
            completedCount++;
          } else if (!videoCompleted) {
            console.log(`[Bulk Video ${index}] Timed out waiting for video`);
            await storage.updateVideoHistoryStatus(historyId, String(userId), 'failed', undefined, 'Video generation timed out');
            sendEvent('result', { index, status: 'failed', error: 'Video generation timed out', imageUrl: imageDataUrl, phase: 'timeout', historyId });
            failedCount++;
          }

        } catch (error: any) {
          console.error(`[Bulk Video ${index}] Error:`, error);
          await storage.updateVideoHistoryStatus(historyId, String(userId), 'failed', undefined, error.message || 'Unknown error');
          sendEvent('result', { index, status: 'failed', error: error.message || 'Unknown error', historyId });
          failedCount++;
        }
      };

      // Start concurrent workers
      const startNext = () => {
        while (activeCount < MAX_CONCURRENT && nextIndex < promptQueue.length) {
          const item = promptQueue[nextIndex];
          nextIndex++;
          activeCount++;
          
          processPrompt(item.prompt, item.index, item.historyId).finally(() => {
            activeCount--;
            sendEvent('queue_status', { 
              active: activeCount, 
              completed: completedCount, 
              failed: failedCount, 
              total: prompts.length,
              remaining: prompts.length - completedCount - failedCount
            });
            
            if (nextIndex < promptQueue.length) {
              startNext();
            }
            
            if (completedCount + failedCount === prompts.length) {
              sendEvent('complete', { 
                message: 'All prompts processed',
                completed: completedCount,
                failed: failedCount,
                total: prompts.length
              });
              res.end();
            }
          });
        }
      };

      console.log(`[Bulk Video Stream] Starting concurrent processing: ${videoEntries.length} videos, max ${MAX_CONCURRENT} concurrent`);
      startNext();

    } catch (error: any) {
      console.error("[Bulk Video Stream] Error:", error);
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message || "Generation failed" })}\n\n`);
        res.end();
      } catch (writeError) {
        console.error("[Bulk Video Stream] Error writing SSE:", writeError);
        if (!res.headersSent) {
          res.status(500).json({ error: "Generation failed" });
        }
      }
    }
  });

  // Generate VEO video directly from prompt
  app.post("/api/generate-veo-video", requireAuth, async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;
    
    try {
      const schema = z.object({
        prompt: z.string().min(10, "Prompt must be at least 10 characters"),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape")
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { prompt, aspectRatio } = validationResult.data;
      
      // Get user and check plan restrictions
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user can access VEO tool
      const toolCheck = canAccessTool(user, "veo");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      // Check if user can generate video (plan expiry and daily limit)
      const videoCheck = canGenerateVideo(user);
      if (!videoCheck.allowed) {
        return res.status(403).json({ error: videoCheck.reason });
      }
      
      console.log(`[VEO Direct] Request received - User: ${user.username}, Aspect Ratio: ${aspectRatio}, Prompt: ${prompt}`);
      
      // Get API key from token rotation system or fallback to environment variable
      let apiKey: string | undefined;
      rotationToken = await storage.getNextRotationToken();
      
      if (rotationToken) {
        apiKey = rotationToken.token;
        console.log(`[Token Rotation] Using token: ${rotationToken.label} (ID: ${rotationToken.id})`);
        await storage.updateTokenUsage(rotationToken.id);
      } else {
        apiKey = process.env.VEO3_API_KEY;
        console.log('[Token Rotation] No active tokens found, using environment variable VEO3_API_KEY');
      }

      if (!apiKey) {
        return res.status(500).json({ 
          error: "No API key configured. Please add tokens in the admin panel or set VEO3_API_KEY environment variable." 
        });
      }

      const veoProjectId = process.env.VEO3_PROJECT_ID || "5fdc3f34-d4c6-4afb-853a-aba4390bafdc";
      const sceneId = `veo-${Date.now()}`;
      const seed = Math.floor(Math.random() * 100000);

      // Build the payload based on aspect ratio
      const payload = {
        clientContext: {
          projectId: veoProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO"
        },
        requests: [{
          aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
          seed: seed,
          textInput: {
            prompt: prompt
          },
          videoModelKey: aspectRatio === "portrait" ? "veo_3_1_t2v_fast_portrait_ultra" : "veo_3_1_t2v_fast_ultra",
          metadata: {
            sceneId: sceneId
          }
        }]
      };

      console.log(`[VEO Direct] === TEXT-TO-VIDEO GENERATION (with Auto-Retry) ===`);
      console.log(`[VEO Direct] User: ${user.username} (Plan: ${user.planType})`);
      console.log(`[VEO Direct] Scene ID: ${sceneId}`);
      console.log(`[VEO Direct] Aspect Ratio: ${aspectRatio} (${aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE"})`);
      console.log(`[VEO Direct] Video Model: ${aspectRatio === "portrait" ? "veo_3_1_t2v_fast_portrait_ultra" : "veo_3_1_t2v_fast_ultra"}`);
      console.log(`[VEO Direct] Seed: ${seed}`);
      console.log(`[VEO Direct] Prompt: "${prompt}"`);
      console.log(`[VEO Direct] Initial Token: ${rotationToken?.label || 'Environment Variable'} (ID: ${rotationToken?.id || 'N/A'})`);
      console.log(`[VEO Direct] Full Payload:`, JSON.stringify(payload, null, 2));

      // Use retry function with automatic token rotation (20 retries with different tokens)
      const result = await retryVeoGeneration(payload, 20, rotationToken);

      if (!result.success) {
        throw new Error(result.error);
      }

      const operationName = result.data.operations[0].operation.name;
      rotationToken = result.token; // Update to the token that succeeded

      // Record credits snapshot if available
      if (result.data.remainingCredits !== undefined) {
        try {
          await storage.addCreditsSnapshot(result.data.remainingCredits, 'veo_generation', rotationToken?.id);
        } catch (error) {
          console.error('[Credits Snapshot] Failed to record:', error);
        }
      }

      res.json({
        operationName,
        sceneId,
        status: "PENDING",
        tokenId: rotationToken?.id || null,
        remainingCredits: result.data.remainingCredits
      });
    } catch (error) {
      console.error("Error in /api/generate-veo-video:", error);
      
      res.status(500).json({ 
        error: "Failed to start video generation",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Selenium/Playwright video endpoint removed - now using Media API

  // ==================== BACKGROUND VIDEO GENERATION (POLLING) ====================
  
  // Start video generation in background - returns immediately with video ID
  app.post("/api/start-video-generation", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const schema = z.object({
        prompt: z.string().min(1, "Prompt is required"),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape"),
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: validationResult.error.errors.map((e) => e.message).join(", "),
        });
      }

      const { prompt, aspectRatio } = validationResult.data;
      
      // Get user and check plan restrictions
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const toolCheck = canAccessTool(user, "veo");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const videoCheck = canGenerateVideo(user);
      if (!videoCheck.allowed) {
        return res.status(403).json({ error: videoCheck.reason });
      }

      // Check if we have active API tokens
      const activeTokens = await storage.getActiveApiTokens();
      if (!activeTokens || activeTokens.length === 0) {
        return res.status(500).json({ 
          error: "No active API tokens available. Please add API Tokens in admin settings." 
        });
      }

      // Get API token using rotation
      const rotationToken = await storage.getNextRotationToken();
      const apiKey = rotationToken?.token || process.env.VEO3_API_KEY;
      
      if (!apiKey) {
        return res.status(500).json({ error: "No API key configured" });
      }

      // Create pending history entry
      const videoEntry = await storage.addVideoHistory({
        userId: String(user.id),
        prompt,
        aspectRatio,
        status: 'pending',
        title: `VEO ${aspectRatio} video`,
        tokenUsed: rotationToken?.id || null,
      });

      console.log(`[Single Video] Created video entry ${videoEntry.id} - using Media flow (Image → Video) SAME as character/bulk`);
      console.log(`[Single Video] Initial Token: ${rotationToken?.label || 'ENV'}`);

      // Use MEDIA FLOW (Image → Video) - SAME as character/bulk - NO reCAPTCHA issues!
      const result = await retryMediaVeoGeneration(prompt, aspectRatio, 20, rotationToken);
      
      if (!result.success) {
        await storage.updateVideoHistoryFields(videoEntry.id, { status: 'failed' });
        console.error(`[Single Video] Media API Error after retries:`, result.error);
        return res.status(500).json({ error: result.error });
      }

      const operationName = result.operationName;
      const sceneId = result.sceneId;
      const usedToken = result.token;

      // Increment daily video count
      await storage.incrementDailyVideoCount(userId);

      console.log(`[Single Video] ✅ Operation started: ${operationName}, Scene: ${sceneId}, Token: ${usedToken?.label || 'unknown'}`);

      // NO background polling - frontend polls /api/check-video-status directly (SAME as character video)
      // This ensures ZERO VPS bandwidth - video URL comes directly from VEO to frontend
      res.json({
        success: true,
        videoId: videoEntry.id,
        operationName,
        sceneId,
        tokenId: usedToken?.id || null,
        message: "Video generation started"
      });
    } catch (error) {
      console.error("Error in /api/start-video-generation:", error);
      res.status(500).json({ 
        error: "Failed to start video generation",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Poll for video generation status
  app.get("/api/video-status/:id", requireAuth, async (req, res) => {
    try {
      const videoId = req.params.id;
      const userId = req.session.userId;

      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // First check in-memory job status (faster)
      const jobStatus = getJobStatus(videoId);
      if (jobStatus) {
        const response: any = {
          videoId: jobStatus.videoId,
          status: jobStatus.status,
          error: jobStatus.error,
          elapsedSeconds: Math.floor((Date.now() - jobStatus.startedAt) / 1000)
        };
        
        // Direct to user mode - return raw base64 data (not URL)
        if (jobStatus.videoData) {
          response.videoData = jobStatus.videoData;
          console.log(`[API] Returning direct video data (${(jobStatus.videoData.length / 1024 / 1024).toFixed(2)}MB) for video ${videoId}`);
        } else if (jobStatus.videoUrl) {
          response.videoUrl = jobStatus.videoUrl;
        }
        
        return res.json(response);
      }

      // Fall back to database
      const video = await storage.getVideoById(videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }

      // Check user owns this video
      if (video.userId !== userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({
        videoId: video.id,
        status: video.status,
        videoUrl: video.videoUrl,
        error: video.errorMessage,
        prompt: video.prompt,
        aspectRatio: video.aspectRatio
      });
    } catch (error) {
      console.error("Error in /api/video-status:", error);
      res.status(500).json({ error: "Failed to get video status" });
    }
  });

  // Test Selenium connection endpoint removed - now using Media API

  // Generate VEO video from image + prompt (Image to Video)
  app.post("/api/generate-image-to-video", requireAuth, async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;
    
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Get user and check plan restrictions
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user can access image-to-video tool
      const toolCheck = canAccessTool(user, "imageToVideo");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      // Check if user can generate video (plan expiry and daily limit)
      const videoCheck = canGenerateVideo(user);
      if (!videoCheck.allowed) {
        return res.status(403).json({ error: videoCheck.reason });
      }

      const schema = z.object({
        imageBase64: z.string().min(100, "Image data required"),
        mimeType: z.string().default("image/jpeg"),
        prompt: z.string().min(10, "Prompt must be at least 10 characters"),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape")
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { imageBase64, mimeType, prompt, aspectRatio } = validationResult.data;
      
      console.log(`[Image to Video] User: ${user.username}, Plan: ${user.planType}, Request received - Aspect Ratio: ${aspectRatio}`);
      
      // Get API key from token rotation system
      rotationToken = await storage.getNextRotationToken();
      
      if (!rotationToken) {
        return res.status(500).json({ 
          error: "No API tokens configured. Please add tokens in the admin panel." 
        });
      }

      console.log(`[Token Rotation] Using initial token: ${rotationToken.label} (ID: ${rotationToken.id})`);
      await storage.updateTokenUsage(rotationToken.id);

      const veoProjectId = process.env.VEO3_PROJECT_ID || "5fdc3f34-d4c6-4afb-853a-aba4390bafdc";
      // Generate UUID for sceneId (required format for image-to-video)
      const sceneId = crypto.randomUUID();
      const sessionId = `;${Date.now()}`;
      const seed = Math.floor(Math.random() * 100000);

      // Build video payload (mediaId will be filled by retry function) - VEO 3.1 Format
      const videoPayload = {
        clientContext: {
          sessionId: sessionId,
          projectId: veoProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO"
        },
        requests: [{
          aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
          seed: seed,
          textInput: {
            prompt: prompt
          },
          videoModelKey: aspectRatio === "portrait" ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra",
          startImage: {
            mediaId: "" // Will be filled by retry function
          },
          metadata: {
            sceneId: sceneId
          }
        }]
      };

      console.log(`[Image to Video] === IMAGE-TO-VIDEO GENERATION (VEO 3.1 with Auto-Retry) ===`);
      console.log(`[Image to Video] User: ${user.username} (Plan: ${user.planType})`);
      console.log(`[Image to Video] Scene ID: ${sceneId}`);
      console.log(`[Image to Video] Session ID: ${sessionId}`);
      console.log(`[Image to Video] Seed: ${seed}`);
      console.log(`[Image to Video] Aspect Ratio: ${aspectRatio} (${aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE"})`);
      console.log(`[Image to Video] Video Model: ${aspectRatio === "portrait" ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra"}`);
      console.log(`[Image to Video] Prompt: "${prompt}"`);
      console.log(`[Image to Video] Initial Token: ${rotationToken?.label || 'N/A'} (ID: ${rotationToken?.id || 'N/A'})`);

      // Use retry function with automatic token rotation (20 retries with different tokens)
      const result = await retryImageToVideoGeneration(imageBase64, mimeType, videoPayload, 20, rotationToken);

      if (!result.success) {
        throw new Error(result.error);
      }

      const videoData = result.data;
      const mediaGenId = result.mediaGenId;
      rotationToken = result.token; // Update to the token that succeeded
      const operationName = videoData.operations?.[0]?.operation?.name;

      console.log(`[Image to Video] ✅ Video generation started. Operation: ${operationName}`);

      // Use base64 directly for reference image (no Cloudinary for image-to-video)
      const imageExtension = mimeType.includes('jpeg') ? 'jpg' : 'png';
      const referenceImageUrl = `data:image/${imageExtension};base64,${imageBase64}`;

      // Create video history entry
      const historyEntry = await storage.addVideoHistory({
        userId,
        prompt,
        aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
        status: 'pending',
        title: `Image to Video ${aspectRatio}`,
        tokenUsed: rotationToken?.id,
        referenceImageUrl: referenceImageUrl, // Store reference image URL
      });

      // Record credits snapshot if available
      if (videoData.remainingCredits !== undefined) {
        try {
          await storage.addCreditsSnapshot(videoData.remainingCredits, 'image_to_video', rotationToken?.id);
        } catch (error) {
          console.error('[Credits Snapshot] Failed to record:', error);
        }
      }

      res.json({
        operationName,
        sceneId,
        status: "PENDING",
        tokenId: rotationToken?.id || null,
        historyId: historyEntry.id,
        remainingCredits: videoData.remainingCredits
      });
    } catch (error) {
      console.error("Error in /api/generate-image-to-video:", error);
      
      // Handle token error (auto-disable on auth errors)
      await handleTokenError(rotationToken?.id, error);
      
      // Always show unified content policy message for any error
      const userFriendlyError = "Video generation failed due to content policy. Your image may contain children, celebrities, copyrighted characters, inappropriate content, or other material that violates Google's content guidelines. Please try with a different image.";
      
      res.status(500).json({ 
        error: userFriendlyError
      });
    }
  });

  // Generate video from image URL - for Character Consistent bulk videos
  app.post("/api/generate-video-from-url", requireAuth, async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;
    
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check if user can access this tool (same restrictions as image-to-video)
      const toolCheck = canAccessTool(user, "imageToVideo");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const videoCheck = canGenerateVideo(user);
      if (!videoCheck.allowed) {
        return res.status(403).json({ error: videoCheck.reason });
      }

      const schema = z.object({
        imageUrl: z.string().url("Valid image URL required"),
        prompt: z.string().min(3, "Prompt required"),
        aspectRatio: z.enum(["16:9", "9:16"]).default("16:9")
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { imageUrl, prompt, aspectRatio } = validationResult.data;
      const aspectRatioInternal = aspectRatio === "9:16" ? "portrait" : "landscape";
      
      console.log(`[Video from URL] User: ${user.username}, fetching image from URL: ${imageUrl.substring(0, 100)}...`);

      // Fetch image from URL on server side (bypasses CORS)
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch image: ${imageResponse.status}`);
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      const contentType = imageResponse.headers.get('content-type') || 'image/png';
      const mimeType = contentType.split(';')[0].trim();

      console.log(`[Video from URL] Image fetched successfully (${Math.round(imageBuffer.byteLength / 1024)}KB, ${mimeType})`);

      // Get token for video generation
      rotationToken = await storage.getNextRotationToken();
      if (!rotationToken) {
        return res.status(500).json({ error: "No API tokens available" });
      }

      console.log(`[Video from URL] Using token: ${rotationToken.label}`);
      await storage.updateTokenUsage(rotationToken.id);

      const veoProjectId = process.env.VEO3_PROJECT_ID || "5fdc3f34-d4c6-4afb-853a-aba4390bafdc";
      const sceneId = crypto.randomUUID();
      const sessionId = `;${Date.now()}`;
      const seed = Math.floor(Math.random() * 100000);

      const videoPayload = {
        clientContext: {
          sessionId: sessionId,
          projectId: veoProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO"
        },
        requests: [{
          aspectRatio: aspectRatioInternal === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
          seed: seed,
          textInput: { prompt: prompt },
          videoModelKey: aspectRatioInternal === "portrait" ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra",
          startImage: { mediaId: "" },
          metadata: { sceneId: sceneId }
        }]
      };

      const result = await retryImageToVideoGeneration(imageBase64, mimeType, videoPayload, 20, rotationToken);

      if (!result.success) {
        throw new Error(result.error);
      }

      const videoData = result.data;
      rotationToken = result.token;
      const operationName = videoData.operations?.[0]?.operation?.name;

      console.log(`[Video from URL] Video generation started. Operation: ${operationName}`);

      // Create video history entry
      const historyEntry = await storage.addVideoHistory({
        userId,
        prompt,
        aspectRatio: aspectRatioInternal === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
        status: 'pending',
        title: `Character Consistent Video`,
        tokenUsed: rotationToken?.id,
      });

      res.json({
        operationName,
        sceneId,
        status: "PENDING",
        historyId: historyEntry.id,
      });
    } catch (error) {
      console.error("[Video from URL] Error:", error);
      await handleTokenError(rotationToken?.id, error);
      
      const errorMessage = error instanceof Error ? error.message : 'Video generation failed';
      res.status(500).json({ error: errorMessage });
    }
  });

  // Regenerate a failed video from history - Uses EXACT same flow as bulk generation
  app.post("/api/regenerate-video", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const schema = z.object({
        videoId: z.string(),
        prompt: z.string().min(10, "Prompt must be at least 10 characters"),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape"),
        projectId: z.string().optional(),
        sceneNumber: z.number().optional(),
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { videoId, prompt, aspectRatio, sceneNumber } = validationResult.data;
      
      // Check if this is a merged video (cannot be regenerated)
      const existingVideo = await storage.getVideoById(videoId);
      if (existingVideo?.metadata && typeof existingVideo.metadata === 'object' && 'mergedVideoIds' in existingVideo.metadata) {
        return res.status(400).json({ 
          error: "Merged videos cannot be regenerated. Please generate individual videos instead." 
        });
      }
      
      // Verify video exists and belongs to user
      if (!existingVideo || existingVideo.userId !== userId) {
        return res.status(404).json({ 
          error: "Video not found or you don't have permission to regenerate it" 
        });
      }

      // Check if flow cookies are available (same check as bulk-generate)
      const activeCookies = await storage.getActiveFlowCookies();
      if (activeCookies.length === 0) {
        return res.status(400).json({ error: "No Flow Cookies available. Please add cookies in Admin panel." });
      }

      // Import bulk queue flow (same as bulk-generate)
      const { addToFlowQueue } = await import('./bulkQueueFlow');
      
      // Reset video status to pending, update prompt, and clear old error/url (match bulk-generate status)
      await db
        .update(videoHistory)
        .set({
          status: 'pending',
          prompt: prompt, // Update to new edited prompt
          videoUrl: null,
          errorMessage: null,
          // Note: Don't update updatedAt here to preserve ordering - only update on completion/failure
        })
        .where(eq(videoHistory.id, videoId));
      
      // Create queue item - EXACTLY like bulk-generate does (no assignedToken - queue handles it)
      const queueItem = {
        videoId,
        prompt,
        aspectRatio,
        sceneNumber: sceneNumber || existingVideo.sceneNumber || 1,
        userId,
        // NO assignedToken - let the queue assign cookies internally like bulk-generate
      };
      
      console.log(`[Regenerate Video] Adding video ${videoId} to Flow queue (same as bulk-generate)`);
      
      // Add to the bulk queue - isNewBatch=false to not clear existing queue
      await addToFlowQueue([queueItem], false);
      
      res.json({
        success: true,
        videoId,
        message: "Video regeneration queued.",
        status: "pending"
      });
    } catch (error) {
      console.error("Error in /api/regenerate-video:", error);
      res.status(500).json({ 
        error: "Failed to regenerate video",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Regenerate all failed videos for the current user - Uses EXACT same flow as bulk generation
  app.post("/api/regenerate-all-failed", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      console.log(`[Regenerate All Failed] Starting for user ${userId}`);

      // Check if flow cookies are available (same check as bulk-generate)
      const activeCookies = await storage.getActiveFlowCookies();
      if (activeCookies.length === 0) {
        return res.status(400).json({ error: "No Flow Cookies available. Please add cookies in Admin panel." });
      }

      // Get all failed videos for the user (direct query - more efficient than filtering all videos)
      const failedVideos = await db
        .select()
        .from(videoHistory)
        .where(and(
          eq(videoHistory.userId, userId),
          eq(videoHistory.status, 'failed'),
          eq(videoHistory.deletedByUser, false)
        ))
        .orderBy(desc(videoHistory.createdAt));

      if (failedVideos.length === 0) {
        return res.json({ 
          success: true, 
          count: 0, 
          message: "No failed videos to regenerate" 
        });
      }

      console.log(`[Regenerate All Failed] Found ${failedVideos.length} failed videos`);
      
      // Convert failed videos to QueuedVideo format - EXACTLY like bulk-generate (no assignedToken)
      const queuedVideos = failedVideos.map((video) => ({
        videoId: video.id,
        prompt: video.prompt || '',
        aspectRatio: video.aspectRatio || 'landscape',
        sceneNumber: video.sceneNumber || 1,
        userId: userId,
        // NO assignedToken - let the queue assign cookies internally like bulk-generate
      }));
      
      // Reset all videos to pending status and clear old error/url
      await db
        .update(videoHistory)
        .set({
          status: 'pending',
          videoUrl: null,
          errorMessage: null,
          updatedAt: sql`now()::text` as any
        })
        .where(and(
          eq(videoHistory.userId, userId),
          eq(videoHistory.status, 'failed'),
          eq(videoHistory.deletedByUser, false)
        ));
      
      // Add to bulk queue - same as bulk-generate
      await addToFlowQueue(queuedVideos, false); // false = don't cancel existing batch
      
      console.log(`[Regenerate All Failed] Added ${queuedVideos.length} videos to Flow queue (same as bulk-generate)`);

      res.json({
        success: true,
        count: queuedVideos.length,
        message: `${queuedVideos.length} video(s) queued for regeneration.`
      });
    } catch (error) {
      console.error("[Regenerate All Failed] Error:", error);
      res.status(500).json({ 
        error: "Failed to regenerate videos",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Delete all processing/pending videos for the current user
  app.post("/api/mark-all-processing-failed", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      console.log(`[Delete Processing] Starting for user ${userId}`);

      // Get all videos for the user that are processing/pending/retrying
      const allVideos = await storage.getUserVideoHistory(userId);
      const processingVideos = allVideos.filter(video => 
        video.status === 'pending' || 
        video.status === 'processing' || 
        video.status === 'retrying' ||
        video.status === 'queued'
      );

      if (processingVideos.length === 0) {
        return res.json({ 
          success: true, 
          count: 0, 
          message: "No processing videos to delete" 
        });
      }

      console.log(`[Delete Processing] Found ${processingVideos.length} processing videos to delete`);

      // Delete each video permanently
      let deletedCount = 0;
      for (const video of processingVideos) {
        try {
          await storage.deleteVideoHistoryById(video.id);
          deletedCount++;
        } catch (err) {
          console.error(`[Delete Processing] Error deleting video ${video.id}:`, err);
        }
      }

      console.log(`[Delete Processing] Successfully deleted ${deletedCount} videos`);

      res.json({
        success: true,
        count: deletedCount,
        message: `${deletedCount} video(s) deleted permanently`
      });
    } catch (error) {
      console.error("[Delete Processing] Error:", error);
      res.status(500).json({ 
        error: "Failed to delete processing videos",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Regenerate an image-to-video from history
  app.post("/api/regenerate-image-to-video", requireAuth, async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;
    
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const schema = z.object({
        videoId: z.string(),
        prompt: z.string().min(3, "Prompt must be at least 3 characters"),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape"),
        referenceImageUrl: z.string().url("Invalid reference image URL"),
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { videoId, prompt, aspectRatio, referenceImageUrl } = validationResult.data;
      
      // Check if this is a merged video (cannot be regenerated)
      const existingVideo = await storage.getVideoById(videoId);
      if (existingVideo?.metadata && typeof existingVideo.metadata === 'object' && 'mergedVideoIds' in existingVideo.metadata) {
        return res.status(400).json({ 
          error: "Merged videos cannot be regenerated. Please generate individual videos instead." 
        });
      }
      
      // Verify the video exists and belongs to the user
      const updatedVideo = await storage.updateVideoHistoryStatus(videoId, userId, 'pending');
      
      if (!updatedVideo) {
        return res.status(404).json({ 
          error: "Video not found or you don't have permission to regenerate it" 
        });
      }

      // Get API key from token rotation system
      rotationToken = await storage.getNextRotationToken();
      
      if (!rotationToken) {
        return res.status(500).json({ 
          error: "No API tokens configured. Please add tokens in the admin panel." 
        });
      }

      const apiKey = rotationToken.token;
      console.log(`[Image to Video Regenerate] Using token: ${rotationToken.label} (ID: ${rotationToken.id})`);
      await storage.updateTokenUsage(rotationToken.id);

      const veoProjectId = process.env.VEO3_PROJECT_ID || "5fdc3f34-d4c6-4afb-853a-aba4390bafdc";
      const sceneId = crypto.randomUUID();

      // Fetch the image from Cloudinary
      console.log(`[Image to Video Regenerate] Fetching image from: ${referenceImageUrl}`);
      const imageResponse = await fetch(referenceImageUrl);
      
      if (!imageResponse.ok) {
        throw new Error(`Failed to fetch image from Cloudinary: ${imageResponse.statusText}`);
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      
      // Detect mime type from URL or default to jpeg
      const mimeType = referenceImageUrl.includes('.png') ? 'image/png' : 'image/jpeg';

      // Step 1: Upload image to Google AI
      console.log(`[Image to Video Regenerate] Step 1: Uploading image to Google AI...`);
      const uploadPayload = {
        imageInput: {
          rawImageBytes: imageBase64,
          mimeType: mimeType
        }
      };

      const uploadResponse = await fetch('https://aisandbox-pa.googleapis.com/v1:uploadUserImage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(uploadPayload),
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error(`[Image to Video Regenerate] Image upload failed: ${errorText}`);
        throw new Error(`Image upload failed: ${uploadResponse.statusText}`);
      }

      const uploadData = await uploadResponse.json();
      const mediaGenId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;

      if (!mediaGenId) {
        throw new Error('No media generation ID returned from image upload');
      }

      console.log(`[Image to Video Regenerate] Image uploaded. Media ID: ${mediaGenId}`);

      // Step 2: Generate video with reference image - VEO 3.1 Format
      console.log(`[Image to Video Regenerate] Step 2: Generating video...`);
      const sessionId = `;${Date.now()}`;
      const seed = Math.floor(Math.random() * 100000);
      
      const videoPayload = {
        clientContext: {
          sessionId: sessionId,
          projectId: veoProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO"
        },
        requests: [{
          aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
          seed: seed,
          textInput: {
            prompt: prompt
          },
          videoModelKey: aspectRatio === "portrait" ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra",
          startImage: {
            mediaId: mediaGenId
          },
          metadata: {
            sceneId: sceneId
          }
        }]
      };

      console.log(`[Image to Video Regenerate] === REGENERATION DETAILS (VEO 3.1) ===`);
      console.log(`[Image to Video Regenerate] Video ID: ${videoId}`);
      console.log(`[Image to Video Regenerate] Scene ID: ${sceneId}`);
      console.log(`[Image to Video Regenerate] Session ID: ${sessionId}`);
      console.log(`[Image to Video Regenerate] Seed: ${seed}`);
      console.log(`[Image to Video Regenerate] Aspect Ratio: ${aspectRatio} (${aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE"})`);
      console.log(`[Image to Video Regenerate] Video Model: ${aspectRatio === "portrait" ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra"}`);
      console.log(`[Image to Video Regenerate] Reference Image Media ID: ${mediaGenId}`);
      console.log(`[Image to Video Regenerate] Reference Image URL: ${referenceImageUrl}`);
      console.log(`[Image to Video Regenerate] Prompt: "${prompt}"`);
      console.log(`[Image to Video Regenerate] Token: ${rotationToken?.label || 'Environment Variable'} (ID: ${rotationToken?.id || 'N/A'})`);
      console.log(`[Image to Video Regenerate] Full Payload:`, JSON.stringify(videoPayload, null, 2));

      const videoResponse = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(videoPayload),
      });

      if (!videoResponse.ok) {
        const errorText = await videoResponse.text();
        console.error(`[Image to Video Regenerate] Video generation failed: ${errorText}`);
        throw new Error(`Video generation failed: ${videoResponse.statusText}`);
      }

      const videoData = await videoResponse.json();
      const operationName = videoData.operations?.[0]?.operation?.name;

      if (!operationName) {
        throw new Error('No operation name returned from VEO API');
      }

      console.log(`[Image to Video Regenerate] Video generation started. Operation: ${operationName}`);

      // Start background polling
      (async () => {
        try {
          const maxWaitTime = 4 * 60 * 1000; // 4 minutes timeout
          const pollInterval = 15000; // Poll every 15 seconds
          const startTime = Date.now();
          let completed = false;
          let currentOperationName = operationName;
          let currentSceneId = sceneId;
          let currentApiKey = apiKey;
          let currentRotationToken = rotationToken;

          while (!completed && (Date.now() - startTime) < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));

            try {
              const statusResult = await checkVideoStatus(currentOperationName, currentSceneId, currentApiKey);

              if (statusResult.status === 'COMPLETED' || 
                  statusResult.status === 'MEDIA_GENERATION_STATUS_COMPLETE' || 
                  statusResult.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                completed = true;
                
                if (statusResult.videoUrl) {
                  try {
                    console.log(`[Image to Video Regenerate] Video ${videoId} completed, saving URL directly (no Cloudinary)`);
                    
                    await storage.updateVideoHistoryFields(videoId, {
                      videoUrl: statusResult.videoUrl,
                      status: 'completed',
                    });
                    console.log(`[Image to Video Regenerate] Video ${videoId} completed successfully`);
                  } catch (saveError) {
                    console.error(`[Image to Video Regenerate] Failed to save video ${videoId}:`, saveError);
                    throw saveError;
                  }
                }
              } else if (statusResult.status === 'FAILED' || 
                         statusResult.status === 'MEDIA_GENERATION_STATUS_FAILED') {
                completed = true;
                await storage.updateVideoHistoryFields(videoId, { status: 'failed' });
                console.error(`[Image to Video Regenerate] Video ${videoId} failed`);
                
                // Record token error (non-auth failure)
                if (currentRotationToken) {
                  storage.recordTokenError(currentRotationToken.id);
                }
              }
            } catch (pollError) {
              console.error(`[Image to Video Regenerate] Error polling status for ${videoId}:`, pollError);
            }
          }

          // Timeout - mark as failed
          if (!completed) {
            console.error(`[Image to Video Regenerate] Video ${videoId} timed out after 4 minutes`);
            await storage.updateVideoHistoryFields(videoId, { status: 'failed' });
            
            // Record token error for timeout (non-auth timeout error)
            if (currentRotationToken) {
              storage.recordTokenError(currentRotationToken.id);
            }
          }
        } catch (bgError) {
          console.error(`[Image to Video Regenerate] Background polling error for ${videoId}:`, bgError);
        }
      })();

      res.json({
        success: true,
        operationName,
        sceneId,
        videoId,
        message: "Image to video regeneration started",
        tokenId: rotationToken?.id || null,
        tokenLabel: rotationToken?.label || null
      });
    } catch (error) {
      console.error("Error in /api/regenerate-image-to-video:", error);
      
      // Handle token error (auto-disable on auth errors)
      await handleTokenError(rotationToken?.id, error);
      
      // Always show unified content policy message for any error
      const userFriendlyError = "Video generation failed due to content policy. Your image may contain children, celebrities, copyrighted characters, inappropriate content, or other material that violates Google's content guidelines. Please try with a different image.";
      
      res.status(500).json({ 
        error: userFriendlyError
      });
    }
  });

  // Check video generation status
  app.post("/api/check-video-status", async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;
    
    try {
      const schema = z.object({
        operationName: z.string(),
        sceneId: z.string(),
        tokenId: z.string().optional(), // Optional: use specific token if provided
        historyId: z.string().optional() // Optional: update history when video completes
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { operationName, sceneId, tokenId, historyId } = validationResult.data;
      
      console.log(`[Status Check Debug] Received tokenId: ${tokenId} (type: ${typeof tokenId})`);
      
      // Get API key - use specific token if provided, otherwise use rotation
      let apiKey: string | undefined;
      
      if (tokenId) {
        // Use the specific token that created this video
        const specificToken = await storage.getTokenById(tokenId);
        if (specificToken) {
          rotationToken = specificToken;
          apiKey = specificToken.token;
          console.log(`[Status Check] Using specific token: ${specificToken.label} (ID: ${specificToken.id})`);
          await storage.updateTokenUsage(specificToken.id);
        } else {
          console.log(`[Status Check] Requested token ${tokenId} not found, falling back to rotation`);
          rotationToken = await storage.getNextRotationToken();
          if (rotationToken) {
            apiKey = rotationToken.token;
            console.log(`[Token Rotation] Using token: ${rotationToken.label} (ID: ${rotationToken.id})`);
            await storage.updateTokenUsage(rotationToken.id);
          }
        }
      } else {
        // No specific token provided, use rotation
        rotationToken = await storage.getNextRotationToken();
        if (rotationToken) {
          apiKey = rotationToken.token;
          console.log(`[Token Rotation] Using token: ${rotationToken.label} (ID: ${rotationToken.id})`);
          await storage.updateTokenUsage(rotationToken.id);
        }
      }
      
      if (!rotationToken) {
        apiKey = process.env.VEO3_API_KEY;
        console.log('[Token Rotation] No active tokens found, using environment variable VEO3_API_KEY');
      }

      if (!apiKey) {
        return res.status(500).json({ 
          error: "No API key configured. Please add tokens in the admin panel or set VEO3_API_KEY environment variable." 
        });
      }

      const status = await checkVideoStatus(operationName, sceneId, apiKey);

      // Record token error if video generation failed (non-auth failure)
      if (status.status === 'FAILED' || status.status === 'MEDIA_GENERATION_STATUS_FAILED') {
        if (rotationToken) {
          storage.recordTokenError(rotationToken.id);
        }
      }

      // Video is completed - update history if historyId provided
      if (status.videoUrl && (status.status === 'COMPLETED' || status.status === 'MEDIA_GENERATION_STATUS_COMPLETE' || status.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL')) {
        console.log(`[Video Status] Video completed for ${sceneId} (no Cloudinary upload)`);
        
        // Update video history if historyId is provided
        if (historyId) {
          try {
            await storage.updateVideoHistoryFields(historyId, {
              videoUrl: status.videoUrl,
              status: 'completed',
            });
            console.log(`[Video Status] Updated history ${historyId} with completed video`);
          } catch (err) {
            console.error(`[Video Status] Failed to update history ${historyId}:`, err);
          }
        }
      }
      
      // Update history with failed status if historyId provided
      if (historyId && (status.status === 'FAILED' || status.status === 'MEDIA_GENERATION_STATUS_FAILED')) {
        try {
          await storage.updateVideoHistoryFields(historyId, {
            status: 'failed',
            errorMessage: status.error || 'Video generation failed',
          });
          console.log(`[Video Status] Updated history ${historyId} with failed status`);
        } catch (err) {
          console.error(`[Video Status] Failed to update history ${historyId}:`, err);
        }
      }

      res.json(status);
    } catch (error) {
      console.error("Error in /api/check-video-status:", error);
      
      // Handle token error (auto-disable on auth errors)
      await handleTokenError(rotationToken?.id, error);
      
      res.status(500).json({ 
        error: "Failed to check video status",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // BATCH Video Status Check - Checks multiple videos in PARALLEL
  // IMPORTANT: Must use the SAME token that was used to generate the video
  app.post("/api/check-videos-batch", async (req, res) => {
    try {
      const schema = z.object({
        videos: z.array(z.object({
          operationName: z.string(),
          sceneId: z.string(),
          tokenId: z.string().nullable().optional(),
          historyId: z.string().nullable().optional()
        }))
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { videos } = validationResult.data;
      console.log(`[Batch Status Check] Checking ${videos.length} videos with SAME TOKEN...`);

      // Cache tokens to avoid repeated DB lookups
      const tokenCache = new Map<string, { token: string; label: string } | null>();

      // Check all videos in parallel
      const results = await Promise.all(videos.map(async (video) => {
        try {
          // MUST use the same token that was used to generate this video
          let apiKey: string | undefined;
          let tokenLabel: string = 'unknown';

          if (video.tokenId) {
            // Check cache first
            if (tokenCache.has(video.tokenId)) {
              const cached = tokenCache.get(video.tokenId);
              if (cached) {
                apiKey = cached.token;
                tokenLabel = cached.label;
              }
            } else {
              // Fetch from DB
              const specificToken = await storage.getTokenById(video.tokenId);
              if (specificToken) {
                tokenCache.set(video.tokenId, { token: specificToken.token, label: specificToken.label });
                apiKey = specificToken.token;
                tokenLabel = specificToken.label;
              } else {
                tokenCache.set(video.tokenId, null);
              }
            }
          }

          // Fallback to env token only if no tokenId was provided
          if (!apiKey && !video.tokenId) {
            apiKey = process.env.VEO3_API_KEY;
            tokenLabel = 'env';
          }

          if (!apiKey) {
            console.log(`[Batch Status] ⚠️ Token ${video.tokenId} not found for video ${video.sceneId}`);
            return {
              sceneId: video.sceneId,
              historyId: video.historyId,
              status: 'PROCESSING',
              error: 'Original token not available'
            };
          }

          // Check video status with the SAME token
          const status = await checkVideoStatus(video.operationName, video.sceneId, apiKey);

          // Handle different status outcomes
          if (status.status === 'COMPLETED' || 
              status.status === 'MEDIA_GENERATION_STATUS_COMPLETE' || 
              status.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
            
            // Update database with video URL
            if (video.historyId && status.videoUrl) {
              await storage.updateVideoHistoryFields(video.historyId, {
                status: 'completed',
                videoUrl: status.videoUrl
              });
            }
            
            console.log(`[Batch Status] ✅ Video ${video.sceneId} completed`);
            return {
              sceneId: video.sceneId,
              historyId: video.historyId,
              status: 'COMPLETED',
              videoUrl: status.videoUrl
            };
          }

          // AUTO-RETRY WITH NEW TOKEN for retryable errors (HIGH_TRAFFIC, LMRoot/Gemini errors)
          if (status.needsTokenRetry && video.historyId) {
            const errorType = status.error?.includes('LMRoot') || status.error?.includes('Gemini') ? 'LMRoot/Gemini Error' : 'HIGH_TRAFFIC';
            console.log(`[Batch Status] 🔄 ${errorType} for ${video.sceneId} - triggering auto-retry with new token`);
            
            // Get current video history to check retry count and get reference image
            const videoHistory = await storage.getVideoById(video.historyId);
            
            if (videoHistory) {
              const currentRetryCount = videoHistory.retryCount || 0;
              const MAX_RETRIES = 3;
              
              if (currentRetryCount >= MAX_RETRIES) {
                console.log(`[Batch Status] ❌ Max retries (${MAX_RETRIES}) reached for ${video.sceneId} - marking as failed`);
                await storage.updateVideoHistoryFields(video.historyId, {
                  status: 'failed',
                  errorMessage: `${errorType} - Failed after ${MAX_RETRIES} auto-retries`
                });
                return {
                  sceneId: video.sceneId,
                  historyId: video.historyId,
                  status: 'FAILED',
                  error: `Failed after ${MAX_RETRIES} auto-retries (${errorType})`
                };
              }
              
              // Update retry count and status
              await storage.updateVideoHistoryFields(video.historyId, {
                status: 'pending',
                retryCount: currentRetryCount + 1,
                lastRetryAt: new Date().toISOString()
              });
              
              // TOKEN ROTATION RETRY LOOP - Try different tokens until success
              const usedTokenIds = new Set<string>();
              if (video.tokenId) usedTokenIds.add(video.tokenId); // Exclude original failed token
              
              const veoProjectId = process.env.VEO3_PROJECT_ID || "08ea5ad2-6dad-43cc-9963-072a0d1c7d36";
              const prompt = videoHistory.prompt;
              const aspectRatio = videoHistory.aspectRatio || 'landscape';
              
              let lastRetryError: string = '';
              const INTERNAL_RETRIES = 10; // Try up to 10 different tokens per auto-retry attempt
              
              for (let tokenAttempt = 0; tokenAttempt < INTERNAL_RETRIES; tokenAttempt++) {
                // Add 1 second delay between token attempts
                if (tokenAttempt > 0) {
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
                // Get a DIFFERENT token (exclude all previously used/failed tokens)
                const newToken = await getNextTokenExcluding(usedTokenIds);
                
                if (!newToken) {
                  console.log(`[Batch Retry] ⚠️ No more tokens available (tried ${usedTokenIds.size} tokens) for ${video.sceneId}`);
                  
                  if (tokenAttempt === 0) {
                    return {
                      sceneId: video.sceneId,
                      historyId: video.historyId,
                      status: 'PROCESSING',
                      error: 'Waiting for available token'
                    };
                  }
                  break; // Exit loop, will return failure below
                }
                
                usedTokenIds.add(newToken.id); // Track this token as used
                
                console.log(`[Batch Retry] 🔄 Token attempt ${tokenAttempt + 1}/${INTERNAL_RETRIES} (total used: ${usedTokenIds.size}): ${newToken.label} for ${video.sceneId}`);
                
                try {
                  const newSceneId = `retry-${video.historyId}-${Date.now()}`;
                  const seed = Math.floor(Math.random() * 100000);
                  
                  let veoResp: globalThis.Response;
                  
                  // Check if this is a character-consistent video
                  if (videoHistory.referenceImageUrl) {
                    // CHARACTER VIDEO: Re-upload image and use reference image API
                    console.log(`[Batch Retry] Character video - uploading image with token ${newToken.label}`);
                    
                    const uploadPayload = {
                      image: { imageUrl: videoHistory.referenceImageUrl },
                      mimeType: "image/jpeg"
                    };
                    
                    const uploadResp = await fetch('https://aisandbox-pa.googleapis.com/v1/images:upload', {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${newToken.token}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(uploadPayload),
                    });
                    
                    if (!uploadResp.ok) {
                      const uploadText = await uploadResp.text();
                      lastRetryError = `Image upload failed with token ${newToken.label}: ${uploadResp.status}`;
                      console.log(`[Batch Retry] ⚠️ ${lastRetryError} - trying next token...`);
                      await handleTokenError(newToken.id, new Error(lastRetryError));
                      continue; // Try next token
                    }
                    
                    const uploadData = await uploadResp.json();
                    const mediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;
                    
                    if (!mediaId) {
                      lastRetryError = `No mediaId returned from upload with token ${newToken.label}`;
                      console.log(`[Batch Retry] ⚠️ ${lastRetryError} - trying next token...`);
                      continue; // Try next token
                    }
                    
                    console.log(`[Batch Retry] ✓ Image uploaded with token ${newToken.label}, mediaId: ${mediaId}`);
                    
                    const payload = {
                      clientContext: {
                        sessionId: `retry-session-${Date.now()}`,
                        projectId: veoProjectId,
                        tool: "PINHOLE",
                        userPaygateTier: "PAYGATE_TIER_TWO"
                      },
                      requests: [{
                        aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
                        metadata: { sceneId: newSceneId },
                        referenceImages: [
                          { imageUsageType: "IMAGE_USAGE_TYPE_ASSET", mediaId: mediaId },
                          { imageUsageType: "IMAGE_USAGE_TYPE_ASSET", mediaId: mediaId }
                        ],
                        seed: seed,
                        textInput: { prompt: prompt },
                        videoModelKey: "veo_3_0_r2v_fast_ultra"
                      }]
                    };
                    
                    veoResp = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages', {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${newToken.token}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(payload),
                    });
                  } else {
                    // TEXT VIDEO
                    const payload = {
                      clientContext: {
                        projectId: veoProjectId,
                        tool: "PINHOLE",
                        userPaygateTier: "PAYGATE_TIER_TWO"
                      },
                      requests: [{
                        aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
                        seed: seed,
                        textInput: { prompt: prompt },
                        videoModelKey: aspectRatio === "portrait" ? "veo_3_1_t2v_fast_portrait_ultra" : "veo_3_1_t2v_fast_ultra",
                        metadata: { sceneId: newSceneId }
                      }]
                    };
                    
                    veoResp = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${newToken.token}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(payload),
                    });
                  }
                  
                  const result = await veoResp.json();
                  
                  if (!veoResp.ok || !result.operations || result.operations.length === 0) {
                    lastRetryError = result?.error?.message || `API error with token ${newToken.label}`;
                    console.log(`[Batch Retry] ⚠️ ${lastRetryError} - trying next token...`);
                    await handleTokenError(newToken.id, new Error(lastRetryError));
                    continue; // Try next token
                  }
                  
                  // SUCCESS!
                  const newOperationName = result.operations[0].operation.name;
                  
                  // Update video history with new operation details and token
                  await storage.updateVideoHistoryFields(video.historyId!, {
                    operationName: newOperationName,
                    sceneId: newSceneId,
                    tokenUsed: newToken.id,
                    status: 'pending'
                  });
                  
                  await storage.updateTokenUsage(newToken.id);
                  
                  console.log(`[Batch Retry] ✅ Started retry for ${video.historyId} with token ${newToken.label} - new operation: ${newOperationName}`);
                  
                  // Return new operation details so frontend can track correctly
                  return {
                    sceneId: video.sceneId,
                    historyId: video.historyId,
                    status: 'RETRYING',
                    newOperationName: newOperationName,
                    newSceneId: newSceneId,
                    tokenId: newToken.id,
                    message: `Auto-retrying with token ${newToken.label} (attempt ${currentRetryCount + 1}/${MAX_RETRIES})`
                  };
                  
                } catch (tokenError) {
                  lastRetryError = tokenError instanceof Error ? tokenError.message : 'Unknown error';
                  console.log(`[Batch Retry] ⚠️ Error with token ${newToken.label}: ${lastRetryError} - trying next token...`);
                  await handleTokenError(newToken.id, tokenError instanceof Error ? tokenError : new Error(lastRetryError));
                  continue; // Try next token
                }
              }
              
              // All tokens exhausted for this retry attempt
              console.error(`[Batch Retry] ❌ All ${usedTokenIds.size} tokens failed for ${video.historyId}. Last error: ${lastRetryError}`);
              await storage.updateVideoHistoryFields(video.historyId!, {
                status: 'failed',
                errorMessage: `Auto-retry failed after trying ${usedTokenIds.size} tokens: ${lastRetryError}`
              });
              
              return {
                sceneId: video.sceneId,
                historyId: video.historyId,
                status: 'FAILED',
                error: `Auto-retry failed after trying ${usedTokenIds.size} tokens: ${lastRetryError}`
              };
            }
          }

          if (status.status === 'PENDING' || 
              status.status === 'PROCESSING' || 
              status.status === 'MEDIA_GENERATION_STATUS_PENDING' ||
              status.status === 'MEDIA_GENERATION_STATUS_PROCESSING') {
            return {
              sceneId: video.sceneId,
              historyId: video.historyId,
              status: 'PROCESSING'
            };
          }

          // FAILED
          if (status.status === 'FAILED' || 
              status.status === 'MEDIA_GENERATION_STATUS_FAILED' ||
              status.error) {
            
            const errorMsg = status.error || 'Video generation failed';
            
            // Update database with error
            if (video.historyId) {
              await storage.updateVideoHistoryFields(video.historyId, {
                status: 'failed',
                errorMessage: errorMsg
              });
            }
            
            console.log(`[Batch Status] ❌ Video ${video.sceneId} failed: ${errorMsg}`);
            return {
              sceneId: video.sceneId,
              historyId: video.historyId,
              status: 'FAILED',
              error: errorMsg
            };
          }

          // Unknown status
          return {
            sceneId: video.sceneId,
            historyId: video.historyId,
            status: status.status || 'UNKNOWN'
          };

        } catch (error) {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[Batch Status] Error checking ${video.sceneId}:`, errMsg);
          return {
            sceneId: video.sceneId,
            historyId: video.historyId,
            status: 'PROCESSING',
            error: errMsg
          };
        }
      }));

      console.log(`[Batch Status Check] Completed. Results: ${results.filter(r => r.status === 'COMPLETED').length} completed, ${results.filter(r => r.status === 'PROCESSING').length} processing, ${results.filter(r => r.status === 'RETRYING').length} retrying, ${results.filter(r => r.status === 'FAILED').length} failed`);

      res.json({ results });
    } catch (error) {
      console.error("Error in /api/check-videos-batch:", error);
      res.status(500).json({ 
        error: "Failed to check video statuses",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Merge all videos into one
  app.post("/api/merge-videos", requireAuth, async (req, res) => {
    try {
      const schema = z.object({
        videos: z.array(z.object({
          sceneNumber: z.number(),
          videoUrl: z.string()
        }))
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { videos } = validationResult.data;
      const userId = req.session.userId!;

      if (videos.length === 0) {
        return res.status(400).json({ 
          error: "No videos to merge" 
        });
      }

      console.log(`[Merge Videos] Starting merge of ${videos.length} videos using fal.ai`);

      // Sort videos by scene number before merging to ensure correct sequence
      const sortedVideos = [...videos].sort((a, b) => a.sceneNumber - b.sceneNumber);
      const videoUrls = sortedVideos.map(v => v.videoUrl);

      // Merge videos using fal.ai API
      const mergedVideoUrl = await mergeVideosWithFalAI(videoUrls);
      console.log(`[Merge Videos] Videos merged successfully with fal.ai`);
      console.log(`[Merge Videos] Merged video URL: ${mergedVideoUrl}`);

      res.json({ 
        success: true,
        mergedVideoUrl: mergedVideoUrl
      });
    } catch (error) {
      console.error("Error in /api/merge-videos:", error);
      res.status(500).json({ 
        error: "Failed to merge videos",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Merge selected videos from history using FFmpeg
  app.post("/api/merge-selected-videos", requireAuth, async (req, res) => {
    try {
      const schema = z.object({
        videoIds: z.array(z.string()).min(2).max(30)
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { videoIds } = validationResult.data;
      const userId = req.session.userId!;

      console.log(`[Merge Selected] Starting FFmpeg merge of ${videoIds.length} selected videos for user ${userId}`);

      // Security: Verify all videos belong to the authenticated user
      const userVideos = await storage.getUserVideoHistory(userId);
      const videoUrls: string[] = [];

      for (const videoId of videoIds) {
        const video = userVideos.find(v => v.id === videoId);
        
        if (!video) {
          return res.status(403).json({ 
            error: "Forbidden",
            message: `Video ${videoId} not found or does not belong to you`
          });
        }

        if (video.status !== 'completed' || !video.videoUrl) {
          return res.status(400).json({ 
            error: "Invalid video",
            message: `Video ${videoId} is not completed or has no URL`
          });
        }

        // Additional security: Verify URL is from trusted sources
        const isCloudinary = video.videoUrl.startsWith('https://res.cloudinary.com/');
        const isGoogleStorage = video.videoUrl.startsWith('https://storage.googleapis.com/');
        
        if (!isCloudinary && !isGoogleStorage) {
          return res.status(400).json({ 
            error: "Invalid video URL",
            message: `Video ${videoId} has an invalid URL`
          });
        }

        // No migration needed - FFmpeg can download directly from any URL
        videoUrls.push(video.videoUrl);
      }

      console.log(`[Merge Selected] All videos verified, proceeding with merge`);

      // Create a video history entry for this merge operation
      const mergeHistoryEntry = await storage.addVideoHistory({
        userId,
        prompt: `Merged video from ${videoIds.length} selected videos`,
        aspectRatio: "16:9",
        status: "pending",
        metadata: JSON.stringify({ mergedVideoIds: videoIds }),
        title: `Merged Video (${videoIds.length} clips)`,
      });

      try {
        // Import the FFmpeg merger function
        const { mergeVideosWithFFmpeg } = await import('./videoMergerFFmpeg');
        
        // Merge videos using local FFmpeg
        const mergedVideoUrl = await mergeVideosWithFFmpeg(videoUrls);
        console.log(`[Merge Selected] Videos merged successfully with FFmpeg`);
        console.log(`[Merge Selected] Merged video URL: ${mergedVideoUrl}`);

        // Update the video history entry with success
        await storage.updateVideoHistoryFields(mergeHistoryEntry.id, {
          status: 'completed',
          videoUrl: mergedVideoUrl,
        });

        res.json({ 
          success: true,
          mergedVideoUrl: mergedVideoUrl,
          historyId: mergeHistoryEntry.id
        });
      } catch (mergeError) {
        console.error("[Merge Selected] Merge failed:", mergeError);
        
        // Update the video history entry with failure
        await storage.updateVideoHistoryFields(mergeHistoryEntry.id, {
          status: 'failed',
        });

        throw mergeError;
      }
    } catch (error) {
      console.error("Error in /api/merge-selected-videos:", error);
      res.status(500).json({ 
        error: "Failed to merge selected videos",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Retry a failed merge operation
  app.post("/api/retry-merge/:id", requireAuth, async (req, res) => {
    try {
      const videoId = req.params.id;
      const userId = req.session.userId!;

      console.log(`[Retry Merge] Starting retry for merge video ${videoId} by user ${userId}`);

      // Get the video history entry
      const userVideos = await storage.getUserVideoHistory(userId);
      const mergeVideo = userVideos.find(v => v.id === videoId);

      if (!mergeVideo) {
        return res.status(404).json({ 
          error: "Video not found",
          message: "Merge video not found or does not belong to you"
        });
      }

      // Parse metadata to get original video IDs
      if (!mergeVideo.metadata) {
        return res.status(400).json({ 
          error: "Invalid merge video",
          message: "This video does not have merge metadata"
        });
      }

      const metadata = JSON.parse(mergeVideo.metadata);
      const videoIds = metadata.mergedVideoIds as string[];

      if (!videoIds || !Array.isArray(videoIds) || videoIds.length < 2) {
        return res.status(400).json({ 
          error: "Invalid metadata",
          message: "Merge metadata is invalid or missing video IDs"
        });
      }

      console.log(`[Retry Merge] Retrying merge of ${videoIds.length} videos`);

      // Verify all videos still exist and are completed
      const videoUrls: string[] = [];
      for (const id of videoIds) {
        const video = userVideos.find(v => v.id === id);
        
        if (!video || video.status !== 'completed' || !video.videoUrl) {
          return res.status(400).json({ 
            error: "Invalid source videos",
            message: `One or more source videos are no longer available or completed`
          });
        }

        // Verify URL is from trusted sources
        const isCloudinary = video.videoUrl.startsWith('https://res.cloudinary.com/');
        const isGoogleStorage = video.videoUrl.startsWith('https://storage.googleapis.com/');
        
        if (!isCloudinary && !isGoogleStorage) {
          return res.status(400).json({ 
            error: "Invalid video URL",
            message: `Video ${id} has an invalid URL`
          });
        }

        // No migration needed - FFmpeg can download directly from any URL
        videoUrls.push(video.videoUrl);
      }

      // Update status to pending
      await storage.updateVideoHistoryFields(videoId, {
        status: 'pending',
        videoUrl: null,
      });

      // Send immediate response
      res.json({ 
        success: true,
        message: "Merge retry started",
        videoId: videoId
      });

      // Perform merge in background
      (async () => {
        try {
          const { mergeVideosWithFFmpeg } = await import('./videoMergerFFmpeg');
          const mergedVideoUrl = await mergeVideosWithFFmpeg(videoUrls);
          
          console.log(`[Retry Merge] Retry successful for video ${videoId}`);
          
          await storage.updateVideoHistoryFields(videoId, {
            status: 'completed',
            videoUrl: mergedVideoUrl,
          });
        } catch (mergeError) {
          console.error(`[Retry Merge] Retry failed for video ${videoId}:`, mergeError);
          
          await storage.updateVideoHistoryFields(videoId, {
            status: 'failed',
          });
        }
      })();

    } catch (error) {
      console.error("Error in /api/retry-merge:", error);
      res.status(500).json({ 
        error: "Failed to retry merge",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Merge videos with FFmpeg and store temporarily (24 hours)
  app.post("/api/merge-videos-temporary", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { videoIds, expiryHours = 24 } = req.body;

      if (!Array.isArray(videoIds) || videoIds.length < 2) {
        return res.status(400).json({ 
          error: "Invalid input",
          message: "Please provide at least 2 video IDs to merge"
        });
      }

      if (videoIds.length > 30) {
        return res.status(400).json({ 
          error: "Too many videos",
          message: "Cannot merge more than 30 videos at once"
        });
      }

      console.log(`[Merge Temporary] Starting temporary merge of ${videoIds.length} videos for user ${userId}`);

      // Get all user videos
      const userVideos = await storage.getUserVideoHistory(userId);

      // Verify all videos exist and are completed
      const videoUrls: string[] = [];
      for (const id of videoIds) {
        const video = userVideos.find(v => v.id === id);
        
        if (!video || video.status !== 'completed' || !video.videoUrl) {
          return res.status(400).json({ 
            error: "Invalid video selection",
            message: `Video ${id} is not available or not completed`
          });
        }

        // Verify URL is from trusted sources
        const isCloudinary = video.videoUrl.startsWith('https://res.cloudinary.com/');
        const isGoogleStorage = video.videoUrl.startsWith('https://storage.googleapis.com/');
        
        if (!isCloudinary && !isGoogleStorage) {
          return res.status(400).json({ 
            error: "Invalid video URL",
            message: `Video ${id} has an invalid URL`
          });
        }

        // No migration needed - FFmpeg can download directly from any URL
        videoUrls.push(video.videoUrl);
      }

      console.log(`[Merge Temporary] All videos verified, starting FFmpeg merge`);

      // Merge videos using FFmpeg with temporary storage
      const { mergeVideosWithFFmpegTemporary } = await import('./videoMergerFFmpeg');
      const { videoPath, expiresAt } = await mergeVideosWithFFmpegTemporary(videoUrls, expiryHours);

      console.log(`[Merge Temporary] Merge complete!`);
      console.log(`[Merge Temporary] Video path: ${videoPath}`);
      console.log(`[Merge Temporary] Expires at: ${expiresAt}`);

      res.json({ 
        success: true,
        videoPath,
        expiresAt,
        previewUrl: videoPath,
        message: `Video will be available for ${expiryHours} hours`
      });

    } catch (error) {
      console.error("Error in /api/merge-videos-temporary:", error);
      res.status(500).json({ 
        error: "Failed to merge videos temporarily",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Get temporary video expiry information
  app.get("/api/temp-video-info", requireAuth, async (req, res) => {
    try {
      const { videoPath } = req.query;

      if (!videoPath || typeof videoPath !== 'string') {
        return res.status(400).json({ 
          error: "Invalid input",
          message: "videoPath is required"
        });
      }

      const { ObjectStorageService } = await import('./objectStorage');
      const objectStorageService = new ObjectStorageService();
      
      const info = await objectStorageService.getVideoExpiryInfo(videoPath);

      res.json({ 
        success: true,
        ...info
      });

    } catch (error) {
      console.error("Error in /api/temp-video-info:", error);
      res.status(500).json({ 
        error: "Failed to get video info",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Cleanup expired temporary videos (admin only)
  app.post("/api/cleanup-expired-videos", requireAdmin, async (req, res) => {
    try {
      console.log(`[Cleanup] Starting cleanup of expired videos`);

      const { ObjectStorageService } = await import('./objectStorage');
      const objectStorageService = new ObjectStorageService();
      
      const deletedCount = await objectStorageService.cleanupExpiredVideos();

      console.log(`[Cleanup] Cleanup complete, deleted ${deletedCount} videos`);

      res.json({ 
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} expired videos`
      });

    } catch (error) {
      console.error("Error in /api/cleanup-expired-videos:", error);
      res.status(500).json({ 
        error: "Failed to cleanup expired videos",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Get server logs (admin only)
  app.get("/api/admin/logs", requireAdmin, async (req, res) => {
    try {
      const lines = parseInt(req.query.lines as string) || 200;
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs/promises');
      const path = await import('path');
      const execAsync = promisify(exec);

      let logs = '';

      try {
        // Try PM2 logs first (for VPS production environment)
        const { stdout } = await execAsync(`pm2 logs videoapp --lines ${lines} --nostream 2>/dev/null || pm2 logs --lines ${lines} --nostream 2>/dev/null || echo "PM2 not available"`);
        
        if (stdout && !stdout.includes('PM2 not available')) {
          logs = stdout;
        } else {
          // Fallback: Read from /tmp/logs directory (Replit environment)
          try {
            const logsDir = '/tmp/logs';
            const files = await fs.readdir(logsDir);
            
            // Find the most recent "Start application" log file
            const appLogFiles = files
              .filter(f => f.startsWith('Start_application_'))
              .sort()
              .reverse();
            
            if (appLogFiles.length > 0) {
              const latestLogFile = path.join(logsDir, appLogFiles[0]);
              const logContent = await fs.readFile(latestLogFile, 'utf-8');
              
              // Get last N lines
              const allLines = logContent.split('\n');
              const lastLines = allLines.slice(-lines);
              logs = `=== Real-time Application Logs (Last ${lines} lines) ===\n` +
                     `=== File: ${appLogFiles[0]} ===\n` +
                     `=== Auto-refreshing every 3 seconds ===\n\n` +
                     lastLines.join('\n');
            } else {
              logs = '=== No log files found ===\n\nWaiting for application to generate logs...';
            }
          } catch (fsError) {
            // If reading from /tmp/logs fails, show console output
            logs = `=== Recent Server Activity ===\n\n` +
                   `Server is running in ${process.env.NODE_ENV || 'development'} mode\n` +
                   `Uptime: ${process.uptime().toFixed(0)} seconds\n\n` +
                   `Console logs are being captured in real-time.\n` +
                   `Check the Console panel for detailed output.\n\n` +
                   `Error: ${fsError instanceof Error ? fsError.message : String(fsError)}`;
          }
        }
      } catch (error) {
        // If PM2 commands fail, return helpful message
        logs = `=== Logs Not Available ===\n\nError: ${error instanceof Error ? error.message : String(error)}`;
      }

      res.json({ 
        logs,
        timestamp: new Date().toISOString(),
        lines
      });

    } catch (error) {
      console.error("Error in /api/admin/logs:", error);
      res.status(500).json({ 
        error: "Failed to fetch logs",
        message: error instanceof Error ? error.message : "Unknown error",
        logs: `Error fetching logs: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });

  // Database backup download (Admin only) - exports all tables as JSON (excludes video history due to size)
  app.get("/api/admin/database-backup", requireAdmin, async (req, res) => {
    try {
      console.log("[Database Backup] Admin requested database backup");
      
      // Import all tables from schema (excluding videoHistory due to size)
      const { users, apiTokens, tokenSettings, planAvailability, appSettings, toolMaintenance, characters, adminMessages, resellers, resellerUsers, resellerCreditLedger, videoHistory } = await import("@shared/schema");
      
      // Get video history count only (not full data - too large)
      const videoCountResult = await db.select({ count: sql<number>`count(*)` }).from(videoHistory);
      const videoCount = Number(videoCountResult[0]?.count || 0);
      
      // Fetch all data from each table (except video history)
      const [
        usersData,
        apiTokensData,
        tokenSettingsData,
        planAvailabilityData,
        appSettingsData,
        toolMaintenanceData,
        charactersData,
        adminMessagesData,
        resellersData,
        resellerUsersData,
        resellerCreditLedgerData
      ] = await Promise.all([
        db.select().from(users),
        db.select().from(apiTokens),
        db.select().from(tokenSettings),
        db.select().from(planAvailability),
        db.select().from(appSettings),
        db.select().from(toolMaintenance),
        db.select().from(characters),
        db.select().from(adminMessages),
        db.select().from(resellers),
        db.select().from(resellerUsers),
        db.select().from(resellerCreditLedger),
      ]);

      const backup = {
        exportedAt: new Date().toISOString(),
        version: "1.0",
        note: "Video history excluded due to size. Use /api/admin/database-backup-videos for video data.",
        tables: {
          users: usersData,
          apiTokens: apiTokensData,
          tokenSettings: tokenSettingsData,
          planAvailability: planAvailabilityData,
          appSettings: appSettingsData,
          toolMaintenance: toolMaintenanceData,
          characters: charactersData,
          adminMessages: adminMessagesData,
          resellers: resellersData,
          resellerUsers: resellerUsersData,
          resellerCreditLedger: resellerCreditLedgerData,
        },
        stats: {
          users: usersData.length,
          apiTokens: apiTokensData.length,
          videoHistory: videoCount,
          characters: charactersData.length,
          resellers: resellersData.length,
          resellerUsers: resellerUsersData.length,
        }
      };

      // Set headers for file download
      const filename = `database-backup-${new Date().toISOString().split('T')[0]}.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      console.log(`[Database Backup] Backup created with ${usersData.length} users (${videoCount} videos excluded)`);
      
      res.json(backup);

    } catch (error) {
      console.error("Error in /api/admin/database-backup:", error);
      res.status(500).json({ 
        error: "Failed to create database backup",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Database backup - SQL format
  app.get("/api/admin/database-backup-sql", requireAdmin, async (req, res) => {
    try {
      console.log("[Database Backup SQL] Admin requested SQL database backup");
      
      const { getTableColumns } = await import('drizzle-orm');
      const { users, apiTokens, tokenSettings, planAvailability, appSettings, toolMaintenance, characters, adminMessages, resellers, resellerUsers, resellerCreditLedger, videoHistory } = await import("@shared/schema");
      
      const videoCountResult = await db.select({ count: sql<number>`count(*)` }).from(videoHistory);
      const videoCount = Number(videoCountResult[0]?.count || 0);
      
      const [
        usersData,
        apiTokensData,
        tokenSettingsData,
        planAvailabilityData,
        appSettingsData,
        toolMaintenanceData,
        charactersData,
        adminMessagesData,
        resellersData,
        resellerUsersData,
        resellerCreditLedgerData
      ] = await Promise.all([
        db.select().from(users),
        db.select().from(apiTokens),
        db.select().from(tokenSettings),
        db.select().from(planAvailability),
        db.select().from(appSettings),
        db.select().from(toolMaintenance),
        db.select().from(characters),
        db.select().from(adminMessages),
        db.select().from(resellers),
        db.select().from(resellerUsers),
        db.select().from(resellerCreditLedger),
      ]);

      // Helper function to escape SQL values with type awareness
      const escapeValue = (val: any, colType?: string): string => {
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        if (typeof val === 'number') return String(val);
        if (val instanceof Date) return `'${val.toISOString()}'`;
        if (Buffer.isBuffer(val)) return `E'\\\\x${val.toString('hex')}'`;
        if (Array.isArray(val)) {
          const arrayVals = val.map(v => typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));
          return `ARRAY[${arrayVals.join(', ')}]::text[]`;
        }
        if (typeof val === 'object') {
          const jsonStr = JSON.stringify(val).replace(/'/g, "''");
          return `'${jsonStr}'::jsonb`;
        }
        return `'${String(val).replace(/'/g, "''")}'`;
      };

      // Helper to generate INSERT statements using Drizzle column metadata
      const generateInserts = (tableName: string, table: any, data: any[]): string => {
        if (data.length === 0) return `-- No data in ${tableName}\n`;
        
        const columns = getTableColumns(table);
        const columnEntries = Object.entries(columns) as [string, { name: string; dataType: string }][];
        let sqlOutput = `-- Table: ${tableName} (${data.length} rows)\n`;
        
        for (const row of data) {
          const colNames = columnEntries.map(([, col]) => `"${col.name}"`);
          const values = columnEntries.map(([key, col]) => escapeValue(row[key], col.dataType));
          sqlOutput += `INSERT INTO "${tableName}" (${colNames.join(', ')}) VALUES (${values.join(', ')});\n`;
        }
        return sqlOutput + '\n';
      };

      let sqlContent = `-- Database Backup SQL Export\n`;
      sqlContent += `-- Generated at: ${new Date().toISOString()}\n`;
      sqlContent += `-- Note: Video history excluded due to size (${videoCount} videos)\n`;
      sqlContent += `-- Stats: ${usersData.length} users, ${apiTokensData.length} tokens, ${charactersData.length} characters\n\n`;
      sqlContent += `BEGIN;\n\n`;

      sqlContent += generateInserts('users', users, usersData);
      sqlContent += generateInserts('api_tokens', apiTokens, apiTokensData);
      sqlContent += generateInserts('token_settings', tokenSettings, tokenSettingsData);
      sqlContent += generateInserts('plan_availability', planAvailability, planAvailabilityData);
      sqlContent += generateInserts('app_settings', appSettings, appSettingsData);
      sqlContent += generateInserts('tool_maintenance', toolMaintenance, toolMaintenanceData);
      sqlContent += generateInserts('characters', characters, charactersData);
      sqlContent += generateInserts('admin_messages', adminMessages, adminMessagesData);
      sqlContent += generateInserts('resellers', resellers, resellersData);
      sqlContent += generateInserts('reseller_users', resellerUsers, resellerUsersData);
      sqlContent += generateInserts('reseller_credit_ledger', resellerCreditLedger, resellerCreditLedgerData);

      sqlContent += `COMMIT;\n`;

      const filename = `database-backup-${new Date().toISOString().split('T')[0]}.sql`;
      res.setHeader('Content-Type', 'application/sql');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      console.log(`[Database Backup SQL] SQL backup created with ${usersData.length} users`);
      res.send(sqlContent);

    } catch (error) {
      console.error("Error in /api/admin/database-backup-sql:", error);
      res.status(500).json({ 
        error: "Failed to create SQL database backup",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Database backup - CSV format (ZIP file)
  app.get("/api/admin/database-backup-csv", requireAdmin, async (req, res) => {
    try {
      console.log("[Database Backup CSV] Admin requested CSV database backup");
      
      const archiver = await import('archiver');
      const { users, apiTokens, tokenSettings, planAvailability, appSettings, toolMaintenance, characters, adminMessages, resellers, resellerUsers, resellerCreditLedger, videoHistory } = await import("@shared/schema");
      
      const videoCountResult = await db.select({ count: sql<number>`count(*)` }).from(videoHistory);
      const videoCount = Number(videoCountResult[0]?.count || 0);
      
      const [
        usersData,
        apiTokensData,
        tokenSettingsData,
        planAvailabilityData,
        appSettingsData,
        toolMaintenanceData,
        charactersData,
        adminMessagesData,
        resellersData,
        resellerUsersData,
        resellerCreditLedgerData
      ] = await Promise.all([
        db.select().from(users),
        db.select().from(apiTokens),
        db.select().from(tokenSettings),
        db.select().from(planAvailability),
        db.select().from(appSettings),
        db.select().from(toolMaintenance),
        db.select().from(characters),
        db.select().from(adminMessages),
        db.select().from(resellers),
        db.select().from(resellerUsers),
        db.select().from(resellerCreditLedger),
      ]);

      // Helper to convert data to CSV - handles complex types
      const toCsv = (data: any[]): string => {
        if (data.length === 0) return '';
        
        const headers = Object.keys(data[0]);
        const escapeCell = (val: any): string => {
          if (val === null || val === undefined) return '';
          if (typeof val === 'object') {
            const str = JSON.stringify(val);
            return `"${str.replace(/"/g, '""')}"`;
          }
          const str = String(val);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        };
        
        const rows = data.map(row => headers.map(h => escapeCell(row[h])).join(','));
        return [headers.join(','), ...rows].join('\n');
      };

      const filename = `database-backup-${new Date().toISOString().split('T')[0]}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const archive = archiver.default('zip', { zlib: { level: 9 } });
      
      // Create promise to wait for archive close (fully written)
      const archiveComplete = new Promise<void>((resolve, reject) => {
        archive.on('error', (err: Error) => {
          console.error("[Database Backup CSV] Archive error:", err);
          reject(err);
        });
        archive.on('close', () => {
          console.log(`[Database Backup CSV] Archive closed, ${archive.pointer()} bytes written`);
          resolve();
        });
      });

      // Pipe archive to response
      archive.pipe(res);

      // Add each table as a CSV file
      const tables = [
        { name: 'users', data: usersData },
        { name: 'api_tokens', data: apiTokensData },
        { name: 'token_settings', data: tokenSettingsData },
        { name: 'plan_availability', data: planAvailabilityData },
        { name: 'app_settings', data: appSettingsData },
        { name: 'tool_maintenance', data: toolMaintenanceData },
        { name: 'characters', data: charactersData },
        { name: 'admin_messages', data: adminMessagesData },
        { name: 'resellers', data: resellersData },
        { name: 'reseller_users', data: resellerUsersData },
        { name: 'reseller_credit_ledger', data: resellerCreditLedgerData },
      ];

      for (const table of tables) {
        const csv = toCsv(table.data);
        if (csv) {
          archive.append(csv, { name: `${table.name}.csv` });
        }
      }

      // Add a README with stats
      const readme = `Database Backup - CSV Export
Generated at: ${new Date().toISOString()}
Note: Video history excluded due to size (${videoCount} videos)

Stats:
- Users: ${usersData.length}
- API Tokens: ${apiTokensData.length}
- Characters: ${charactersData.length}
- Resellers: ${resellersData.length}
- Reseller Users: ${resellerUsersData.length}
`;
      archive.append(readme, { name: 'README.txt' });

      // Finalize archive and wait for it to fully complete
      await archive.finalize();
      await archiveComplete;
      console.log(`[Database Backup CSV] CSV backup created with ${usersData.length} users (${videoCount} videos excluded)`);

    } catch (error) {
      console.error("Error in /api/admin/database-backup-csv:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Failed to create CSV database backup",
          message: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }
  });

  // Google Drive OAuth setup helpers (Admin only)
  app.get("/api/google-drive/auth-url", requireAdmin, async (req, res) => {
    try {
      const { generateAuthUrl } = await import('./googleDriveOAuth');
      const authUrl = await generateAuthUrl();
      res.json({ authUrl });
    } catch (error) {
      console.error("Error generating auth URL:", error);
      res.status(500).json({ 
        error: "Failed to generate auth URL",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.post("/api/google-drive/exchange-token", requireAdmin, async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) {
        return res.status(400).json({ error: "Authorization code required" });
      }

      const { exchangeCodeForToken } = await import('./googleDriveOAuth');
      const refreshToken = await exchangeCodeForToken(code);
      
      res.json({ 
        refreshToken,
        message: "Add this token to your secrets as GOOGLE_DRIVE_REFRESH_TOKEN"
      });
    } catch (error) {
      console.error("Error exchanging token:", error);
      res.status(500).json({ 
        error: "Failed to exchange token",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Character Management Routes
  
  // Get user's characters (Admin only)
  app.get("/api/characters", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Character consistency is for Empire plan users and admins
      const user = await storage.getUser(userId);
      if (!user?.isAdmin && user?.planType !== 'empire') {
        return res.status(403).json({ error: "Character Consistency is only available for Empire plan users" });
      }

      const characters = await storage.getUserCharacters(userId);
      res.json({ characters });
    } catch (error) {
      console.error("Error fetching characters:", error);
      res.status(500).json({ 
        error: "Failed to fetch characters",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Upload and create a new character (Admin only)
  app.post("/api/characters", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Character consistency is for Empire plan users and admins
      const user = await storage.getUser(userId);
      if (!user?.isAdmin && user?.planType !== 'empire') {
        return res.status(403).json({ error: "Character Consistency is only available for Empire plan users" });
      }

      // Support both image-based and text-based characters
      const schema = z.object({
        name: z.string().min(1, "Character name is required"),
        characterType: z.enum(["image", "text"]),
        description: z.string().optional(),
        imageBase64: z.string().optional(),
        imageMimeType: z.string().optional()
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { name, characterType, description, imageBase64, imageMimeType } = validationResult.data;

      // Validate based on character type
      if (characterType === "image") {
        if (!imageBase64 || !imageMimeType) {
          return res.status(400).json({ error: "Image characters must have imageBase64 and imageMimeType" });
        }
      } else if (characterType === "text") {
        if (!description || description.trim().length < 10) {
          return res.status(400).json({ error: "Text characters must have description (at least 10 characters)" });
        }
      }

      console.log(`[Character Create] User: ${userId}, Name: ${name}, Type: ${characterType}`);
      if (characterType === "image") {
        console.log(`[Character Create] Image size: ${Math.round((imageBase64?.length || 0) / 1024)}KB, Type: ${imageMimeType}`);
      } else {
        console.log(`[Character Create] Description length: ${description?.length || 0} chars`);
      }

      // Save character to database
      const character = await storage.addCharacter({
        userId,
        name,
        characterType,
        imageUrl: null,
        mediaId: null,
        uploadTokenId: null,
        description: characterType === "text" ? description : null,
        imageBase64: characterType === "image" ? imageBase64 : null,
        imageMimeType: characterType === "image" ? imageMimeType : null
      });

      return res.json({ 
        character,
        message: "Character created successfully" 
      });

    } catch (error) {
      console.error("Error creating character:", error);
      res.status(500).json({ 
        error: "Failed to create character",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Delete a character (Admin only)
  app.delete("/api/characters/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Character consistency is for Empire plan users and admins
      const user = await storage.getUser(userId);
      if (!user?.isAdmin && user?.planType !== 'empire') {
        return res.status(403).json({ error: "Character Consistency is only available for Empire plan users" });
      }

      const characterId = req.params.id;
      
      // Verify character belongs to user
      const character = await storage.getCharacterById(characterId);
      if (!character) {
        return res.status(404).json({ error: "Character not found" });
      }

      if (character.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to delete this character" });
      }

      await storage.deleteCharacter(characterId, userId);
      
      console.log(`[Character Delete] User: ${userId}, Character: ${character.name} (${characterId})`);

      res.json({ message: "Character deleted successfully" });
    } catch (error) {
      console.error("Error deleting character:", error);
      res.status(500).json({ 
        error: "Failed to delete character",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Generate character-consistent video (Admin only)
  app.post("/api/generate-character-video", requireAuth, async (req, res) => {
    let rotationToken: Awaited<ReturnType<typeof storage.getNextRotationToken>> | undefined;

    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Character consistency is for Empire plan users and admins
      if (!user.isAdmin && user.planType !== 'empire') {
        return res.status(403).json({ error: "Character Consistency is only available for Empire plan users" });
      }

      const schema = z.object({
        characterId: z.string().min(1, "Character ID is required"),
        prompt: z.string().min(3, "Prompt must be at least 3 characters"),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape")
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { characterId, prompt, aspectRatio } = validationResult.data;

      // Verify character belongs to user
      const character = await storage.getCharacterById(characterId);
      if (!character) {
        return res.status(404).json({ error: "Character not found" });
      }

      if (character.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to use this character" });
      }

      console.log(`[Character Video] User: ${user.username}, Character: ${character.name}, Prompt: ${prompt}`);
      console.log(`[Character Video] Character mediaId: ${character.mediaId}`);
      console.log(`[Character Video] Upload token ID: ${character.uploadTokenId}`);

      // CRITICAL: Use the SAME token that uploaded this character's image
      // The mediaId is scoped to the specific API token
      if (character.uploadTokenId) {
        rotationToken = await storage.getTokenById(character.uploadTokenId);
        if (rotationToken) {
          console.log(`[Token Reuse] Using same token that uploaded character: ${rotationToken.label} (ID: ${rotationToken.id})`);
          await storage.updateTokenUsage(rotationToken.id);
        } else {
          console.error(`[Token Error] Upload token ${character.uploadTokenId} not found! Character may be unusable.`);
          return res.status(500).json({ 
            error: "Character upload token no longer available",
            details: "Please re-upload this character to fix the issue"
          });
        }
      } else {
        // Fallback for old characters without uploadTokenId
        console.warn('[Token Warning] Character has no uploadTokenId, using fallback token');
        rotationToken = await storage.getNextRotationToken();
        if (rotationToken) {
          console.log(`[Token Rotation] Using fallback token: ${rotationToken.label} (ID: ${rotationToken.id})`);
          await storage.updateTokenUsage(rotationToken.id);
        }
      }

      const apiKey = rotationToken?.token || process.env.VEO3_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "No API key configured" });
      }

      // VEO 3.0 reference image video generation using character's media ID
      const veoProjectId = process.env.VEO3_PROJECT_ID || "08ea5ad2-6dad-43cc-9963-072a0d1c7d36";
      const sessionId = `session-${Date.now()}`;
      const sceneId = `character-video-${Date.now()}`;
      const seed = Math.floor(Math.random() * 100000);

      const payload = {
        clientContext: {
          sessionId: sessionId,
          projectId: veoProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO"
        },
        requests: [{
          aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
          metadata: {
            sceneId: sceneId
          },
          referenceImages: [
            {
              imageUsageType: "IMAGE_USAGE_TYPE_ASSET",
              mediaId: character.mediaId
            },
            {
              imageUsageType: "IMAGE_USAGE_TYPE_ASSET",
              mediaId: character.mediaId
            }
          ],
          seed: seed,
          textInput: {
            prompt: prompt
          },
          videoModelKey: "veo_3_0_r2v_fast_ultra"
        }]
      };

      console.log(`[Character Video] Request payload:`, JSON.stringify(payload, null, 2));

      const response = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      console.log(`[Character Video] API Response status: ${response.status}`);
      console.log(`[Character Video] API Response:`, JSON.stringify(result, null, 2));

      if (!response.ok || !result.operations || result.operations.length === 0) {
        const errorMsg = result?.error?.message || 'Failed to start video generation';
        console.error(`[Character Video] Error: ${errorMsg}`, result);
        throw new Error(errorMsg);
      }

      const operationName = result.operations[0].operation.name;
      
      // Increment daily video count
      await storage.incrementDailyVideoCount(userId);

      // Create history entry
      const historyEntry = await storage.addVideoHistory({
        userId,
        prompt: `[Character: ${character.name}] ${prompt}`,
        aspectRatio,
        status: 'pending',
        tokenUsed: rotationToken?.id || null,
        referenceImageUrl: character.imageUrl
      });

      console.log(`[Character Video] Operation started: ${operationName}`);

      res.json({ 
        operationName,
        sceneId,
        historyId: historyEntry.id,
        tokenId: rotationToken?.id || null,
        characterName: character.name
      });

    } catch (error) {
      await handleTokenError(rotationToken?.id, error);
      
      console.error("Error generating character video:", error);
      res.status(500).json({ 
        error: "Failed to generate character video",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Bulk character-consistent video generation (Admin only)
  app.post("/api/character-bulk-generate", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Character consistency is for Empire plan users and admins
      if (!user.isAdmin && user.planType !== 'empire') {
        return res.status(403).json({ error: "Character Consistency is only available for Empire plan users" });
      }

      const schema = z.object({
        characterId: z.string().optional(),
        prompts: z.array(z.string().min(3, "Each prompt must be at least 3 characters")).min(1).max(100),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape"),
        lockSeed: z.boolean().default(false)
      });

      const validationResult = schema.safeParse(req.body);
      
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid input", 
          details: validationResult.error.errors 
        });
      }

      const { characterId, prompts, aspectRatio, lockSeed } = validationResult.data;

      // Character is optional - if provided, verify it belongs to user
      let character: Awaited<ReturnType<typeof storage.getCharacterById>> | null = null;
      if (characterId) {
        character = await storage.getCharacterById(characterId);
        if (!character) {
          return res.status(404).json({ error: "Character not found" });
        }
        if (character.userId !== userId) {
          return res.status(403).json({ error: "Not authorized to use this character" });
        }
      }

      // Generate locked seed if enabled (same seed for all videos)
      const lockedSeed = lockSeed ? Math.floor(Math.random() * 100000) : null;

      console.log(`[Character Bulk] User: ${user.username}, Character: ${character ? `${character.name} (Type: ${character.characterType})` : 'None'}, Prompts: ${prompts.length}, Lock Seed: ${lockSeed}${lockSeed ? ` (seed: ${lockedSeed})` : ''}`);

      // AUTO-CLEAR: Fast batch delete all pending/stuck videos
      // This ensures videos are only deleted when a new batch is actually being created
      try {
        stopAllProcessing(userId); // Stop any lingering queue processing
        
        // Single batch delete - much faster than one-by-one
        const deleteResult = await db
          .delete(videoHistory)
          .where(
            and(
              eq(videoHistory.userId, userId),
              or(
                eq(videoHistory.status, 'pending'),
                eq(videoHistory.status, 'generating'),
                eq(videoHistory.status, 'queued'),
                eq(videoHistory.status, 'retrying'),
                eq(videoHistory.status, 'initializing')
              )
            )
          )
          .returning({ id: videoHistory.id });
        
        if (deleteResult.length > 0) {
          console.log(`[Character Bulk] Fast-cleared ${deleteResult.length} stuck/pending videos for user ${user.username}`);
        }
      } catch (error) {
        console.error('[Character Bulk] Error auto-clearing stuck videos:', error);
        // Continue with new generation even if clearing fails
      }

      // Process each prompt with token rotation
      const results: Array<{
        prompt: string;
        operationName?: string;
        sceneId?: string;
        historyId?: string;
        tokenId?: string;
        error?: string;
      }> = [];

      // Branch based on character type (or no character)
      if (!character || character.characterType === "text") {
        // TEXT-BASED CHARACTER FLOW (or no character): Uses Media API (generateImage → generateVideo)
        // Same flow as bulk generator - works reliably
        
        console.log(`[Character Bulk Text] Using Media flow (Image → Video) - ${prompts.length} videos${!character ? ' (no character)' : ''}`);

        // Step 1: Get all active tokens for per-video rotation
        const allActiveTokens = await storage.getActiveApiTokens();
        if (allActiveTokens.length === 0) {
          throw new Error('No active API tokens available');
        }
        console.log(`[Character Bulk Text] Available tokens: ${allActiveTokens.length} for ${prompts.length} videos`);

        const MEDIA_API_URL = 'https://aisandbox-pa.googleapis.com/v1';
        const batchTimestamp = Date.now();

        // Step 2: Pre-create all video items with history entries
        interface TextVideoItem {
          index: number;
          prompt: string;
          augmentedPrompt: string;
          sceneId: string;
          seed: number;
          historyId: string;
          token: typeof allActiveTokens[0];
          operationName?: string;
          error?: string;
        }

        const allItems: TextVideoItem[] = [];
        
        // Create history entries in parallel batches
        const DB_BATCH_SIZE = 10;
        for (let dbBatchStart = 0; dbBatchStart < prompts.length; dbBatchStart += DB_BATCH_SIZE) {
          const dbBatchEnd = Math.min(dbBatchStart + DB_BATCH_SIZE, prompts.length);
          const dbBatchPrompts = prompts.slice(dbBatchStart, dbBatchEnd);
          
          const dbBatchResults = await Promise.all(
            dbBatchPrompts.map(async (currentPrompt, dbIdx) => {
              const globalIdx = dbBatchStart + dbIdx;
              const augmentedPrompt = character?.description 
                ? `${currentPrompt}\n\nCharacter details: ${character.description}` 
                : currentPrompt;
              const seed = lockedSeed !== null ? lockedSeed : Math.floor(Math.random() * 100000);
              const sceneId = `character-bulk-text-${batchTimestamp}-${globalIdx}`;
              
              // Assign token by index (round-robin)
              const token = allActiveTokens[globalIdx % allActiveTokens.length];
              
              const sceneNum = globalIdx + 1; // 1-based scene number
              const batchIdStr = `char-batch-${batchTimestamp}`; // Unique batch ID for this generation request
              const historyEntry = await storage.addVideoHistory({
                userId,
                prompt: character?.name ? `[Character: ${character.name}] ${augmentedPrompt}` : augmentedPrompt,
                aspectRatio,
                status: 'pending',
                tokenUsed: token.id,
                referenceImageUrl: null,
                sceneNumber: sceneNum, // Save scene number at creation for proper ordering
                batchId: batchIdStr // Group videos from same batch together
              });
              
              return {
                index: globalIdx,
                prompt: currentPrompt,
                augmentedPrompt,
                sceneId,
                seed,
                historyId: historyEntry.id,
                token
              } as TextVideoItem;
            })
          );
          
          allItems.push(...dbBatchResults);
        }
        
        console.log(`[Character Bulk Text] Created ${allItems.length} history entries - starting Media flow`);

        // Media helper functions (same as bulkQueueFlow)
        const generateMediaImage = async (
          apiKey: string,
          prompt: string,
          aspectRatio: string,
          seed: number
        ): Promise<{ encodedImage: string; mediaGenerationId: string; workflowId: string }> => {
          const MAX_RETRIES = 10;
          let lastError: Error | null = null;
          
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const workflowId = crypto.randomUUID();
              const sessionId = `;${Date.now()}`;
              
              const imageAspectRatio = aspectRatio === 'portrait' || aspectRatio === '9:16'
                ? 'IMAGE_ASPECT_RATIO_PORTRAIT' 
                : 'IMAGE_ASPECT_RATIO_LANDSCAPE';

              const requestBody = {
                clientContext: {
                  workflowId: workflowId,
                  tool: "BACKBONE",
                  sessionId: sessionId
                },
                imageModelSettings: {
                  imageModel: "IMAGEN_3_5",
                  aspectRatio: imageAspectRatio
                },
                seed: seed + attempt - 1,
                prompt: prompt,
                mediaCategory: "MEDIA_CATEGORY_BOARD"
              };

              const response = await fetch(`${MEDIA_API_URL}/whisk:generateImage`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              });

              if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Video generation failed: ${response.status} - ${errorText.substring(0, 200)}`);
              }

              const data = await response.json();
              
              if (!data.imagePanels || data.imagePanels.length === 0 || 
                  !data.imagePanels[0].generatedImages || data.imagePanels[0].generatedImages.length === 0) {
                throw new Error('No image generated from Media API');
              }

              const generatedImage = data.imagePanels[0].generatedImages[0];
              if (attempt > 1) {
                console.log(`[Character Bulk] Image generation succeeded on attempt ${attempt}`);
              }
              return {
                encodedImage: generatedImage.encodedImage,
                mediaGenerationId: generatedImage.mediaGenerationId,
                workflowId: data.workflowId || workflowId
              };
            } catch (error) {
              lastError = error instanceof Error ? error : new Error(String(error));
              if (attempt < MAX_RETRIES) {
                console.log(`[Character Bulk] Image generation attempt ${attempt} failed, retrying... (${lastError.message.substring(0, 100)})`);
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
              }
            }
          }
          
          throw lastError || new Error('Video generation failed after 10 retries');
        };

        const startMediaVideoGeneration = async (
          apiKey: string,
          prompt: string,
          encodedImage: string,
          mediaGenerationId: string,
          workflowId: string
        ): Promise<string> => {
          const sessionId = `;${Date.now()}`;

          const requestBody = {
            clientContext: {
              sessionId: sessionId,
              tool: "BACKBONE",
              workflowId: workflowId
            },
            promptImageInput: {
              prompt: prompt,
              rawBytes: encodedImage,
              mediaGenerationId: mediaGenerationId
            },
            modelNameType: "VEO_3_1_I2V_12STEP",
            modelKey: "",
            userInstructions: prompt,
            loopVideo: false
          };

          const response = await fetch(`${MEDIA_API_URL}/whisk:generateVideo`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Video generation start failed: ${response.status} - ${errorText.substring(0, 200)}`);
          }

          const data = await response.json();
          
          if (!data.operation?.operation?.name) {
            throw new Error('No operation name returned from video generation');
          }

          return data.operation.operation.name;
        };

        // Step 3: Process ALL videos in PARALLEL with Media flow
        const processTextVideo = async (item: TextVideoItem): Promise<void> => {
          const maxRetries = 20;
          const usedTokenIds = new Set<string>();
          let currentToken = item.token;
          usedTokenIds.add(currentToken.id);
          
          // Shuffle tokens for this video to ensure random distribution
          const shuffledTokens = [...allActiveTokens].sort(() => Math.random() - 0.5);
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // Add jittered delay between attempts (except first) - 200-500ms
            if (attempt > 1) {
              const jitter = 200 + Math.random() * 300;
              await new Promise(resolve => setTimeout(resolve, jitter));
              
              // Get a DIFFERENT token that we haven't tried yet
              const unusedToken = shuffledTokens.find(t => !usedTokenIds.has(t.id));
              if (unusedToken) {
                currentToken = unusedToken;
                usedTokenIds.add(currentToken.id);
              } else {
                // All tokens exhausted, try from beginning with random selection
                currentToken = shuffledTokens[Math.floor(Math.random() * shuffledTokens.length)];
              }
            }
            
            console.log(`[Character Bulk Text] Video ${item.index + 1}: Attempt ${attempt}/${maxRetries} with token ${currentToken.label}`);
            
            try {
              // Step A: Generate image first using Media API
              const imageResult = await generateMediaImage(
                currentToken.token,
                item.augmentedPrompt,
                aspectRatio,
                item.seed
              );
              
              console.log(`[Character Bulk Text] Video ${item.index + 1}: Image generated, starting video...`);
              
              // Step B: Generate video from image
              const operationName = await startMediaVideoGeneration(
                currentToken.token,
                item.augmentedPrompt,
                imageResult.encodedImage,
                imageResult.mediaGenerationId,
                imageResult.workflowId
              );

              item.operationName = operationName;
              
              // Update history with operationName and sceneId
              await storage.updateVideoHistoryFields(item.historyId, {
                operationName: item.operationName,
                sceneId: item.sceneId,
                tokenUsed: currentToken.id
              });
              
              await storage.incrementDailyVideoCount(userId);
              
              console.log(`[Character Bulk Text] Video ${item.index + 1} started successfully with token ${currentToken.label}`);
              return; // Success - exit retry loop
              
            } catch (retryError) {
              const errorMsg = retryError instanceof Error ? retryError.message : 'Unknown error';
              console.error(`[Character Bulk Text] Video ${item.index + 1} attempt ${attempt} failed:`, errorMsg);
              
              if (attempt === maxRetries) {
                item.error = `${errorMsg} (Failed after ${maxRetries} attempts)`;
                await storage.updateVideoHistoryFields(item.historyId, {
                  status: 'failed',
                  errorMessage: item.error
                });
              }
            }
          }
        };

        // Execute ALL videos in PARALLEL
        const startTime = Date.now();
        await Promise.all(allItems.map(item => processTextVideo(item)));
        const elapsed = Date.now() - startTime;
        
        console.log(`[Character Bulk Text] Media flow complete in ${elapsed}ms`);

        // Build results array from processed items
        for (const item of allItems) {
          if (item.operationName) {
            results.push({
              prompt: item.augmentedPrompt,
              operationName: item.operationName,
              sceneId: item.sceneId,
              historyId: item.historyId,
              tokenId: item.token.id
            });
          } else {
            results.push({
              prompt: item.augmentedPrompt,
              error: item.error || 'Unknown error'
            });
          }
        }

      } else {
        // IMAGE-BASED CHARACTER FLOW: OPTIMIZED - 1 token uploads image, reuses mediaId for 5 videos
        // This prevents Google throttling by minimizing image uploads per token
        // Token A uploads → mediaId A → 5 videos with Token A + mediaId A
        // Token B uploads → mediaId B → 5 videos with Token B + mediaId B
        
        const VIDEOS_PER_TOKEN = 5; // Reuse same token + mediaId for 5 videos
        
        console.log(`[Character Bulk] Image-based character flow - OPTIMIZED: ${VIDEOS_PER_TOKEN} videos per token+mediaId`);
        console.log(`[Character Bulk] Total prompts: ${prompts.length}`);

        // Step 1: Pre-download character image ONCE (reused for all uploads)
        console.log(`[Character Bulk] Step 1: Pre-downloading character image...`);
        if (!character.imageUrl) {
          throw new Error('Character has no image URL');
        }
        
        const imageResponse = await fetch(character.imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch character image: ${imageResponse.statusText}`);
        }
        
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const imageBase64 = imageBuffer.toString('base64');
        const imageMimeType = character.imageUrl.includes('.png') ? 'image/png' : 'image/jpeg';
        console.log(`[Character Bulk] Image pre-downloaded (${Math.round(imageBuffer.length / 1024)}KB)`);

        // Step 2: Get all active tokens
        const allActiveTokens = await storage.getActiveApiTokens();
        if (allActiveTokens.length === 0) {
          throw new Error('No active API tokens available');
        }
        
        // Calculate how many tokens needed (1 token per 5 videos)
        const tokensNeeded = Math.ceil(prompts.length / VIDEOS_PER_TOKEN);
        console.log(`[Character Bulk] Tokens needed: ${tokensNeeded} (${VIDEOS_PER_TOKEN} videos each), Available: ${allActiveTokens.length}`);

        const veoProjectId = process.env.VEO3_PROJECT_ID || "08ea5ad2-6dad-43cc-9963-072a0d1c7d36";
        const DB_BATCH_SIZE = 10;

        // Step 3: Create all history entries first (in DB batches of 10)
        console.log(`[Character Bulk] Creating history entries for ${prompts.length} videos...`);
        
        interface VideoItem {
          index: number;
          prompt: string;
          augmentedPrompt: string;
          sceneId: string;
          seed: number;
          historyId: string;
          tokenGroupIndex: number; // Which token group this video belongs to (0, 1, 2...)
          operationName?: string;
          error?: string;
        }

        const allItems: VideoItem[] = [];
        
        for (let dbBatchStart = 0; dbBatchStart < prompts.length; dbBatchStart += DB_BATCH_SIZE) {
          const dbBatchEnd = Math.min(dbBatchStart + DB_BATCH_SIZE, prompts.length);
          const dbBatchPrompts = prompts.slice(dbBatchStart, dbBatchEnd);
          
          const dbBatchResults = await Promise.all(
            dbBatchPrompts.map(async (currentPrompt, dbIdx) => {
              const globalIdx = dbBatchStart + dbIdx;
              const characterInfo = character.name ? `\n\nCharacter: ${character.name}` : '';
              const augmentedPrompt = `${currentPrompt}${characterInfo}`;
              const seed = lockedSeed !== null ? lockedSeed : Math.floor(Math.random() * 100000);
              const sceneId = `character-bulk-${Date.now()}-${globalIdx}`;
              
              // Token group: videos 0-4 → group 0, videos 5-9 → group 1, etc.
              const tokenGroupIndex = Math.floor(globalIdx / VIDEOS_PER_TOKEN);
              // Token for this group (round-robin if more groups than tokens)
              const token = allActiveTokens[tokenGroupIndex % allActiveTokens.length];
              
              const historyEntry = await storage.addVideoHistory({
                userId,
                prompt: augmentedPrompt,
                aspectRatio,
                status: 'pending',
                tokenUsed: token.id,
                referenceImageUrl: character.imageUrl
              });
              
              return {
                index: globalIdx,
                prompt: currentPrompt,
                augmentedPrompt,
                sceneId,
                seed,
                historyId: historyEntry.id,
                tokenGroupIndex
              } as VideoItem;
            })
          );
          
          allItems.push(...dbBatchResults);
        }
        
        console.log(`[Character Bulk] Created ${allItems.length} history entries`);

        // Step 4: Group videos by token group
        const tokenGroups = new Map<number, VideoItem[]>();
        for (const item of allItems) {
          const group = tokenGroups.get(item.tokenGroupIndex) || [];
          group.push(item);
          tokenGroups.set(item.tokenGroupIndex, group);
        }
        
        console.log(`[Character Bulk] Grouped into ${tokenGroups.size} token groups`);

        // Step 5: Process each token group - upload image ONCE, then generate all videos
        console.log(`[Character Bulk] Starting OPTIMIZED processing...`);
        const startTime = Date.now();
        
        // Process function for one token group
        const processTokenGroup = async (groupIndex: number, videos: VideoItem[]): Promise<void> => {
          const token = allActiveTokens[groupIndex % allActiveTokens.length];
          const maxUploadRetries = 3;
          let mediaId: string | null = null;
          
          console.log(`[Character Bulk] Group ${groupIndex + 1}: Token ${token.label} → ${videos.length} videos`);
          
          // Step A: Upload image ONCE with this token to get mediaId
          for (let uploadAttempt = 1; uploadAttempt <= maxUploadRetries; uploadAttempt++) {
            try {
              const uploadPayload = {
                imageInput: {
                  rawImageBytes: imageBase64,
                  mimeType: imageMimeType
                }
              };

              const uploadResponse = await fetch('https://aisandbox-pa.googleapis.com/v1:uploadUserImage', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(uploadPayload),
              });

              if (!uploadResponse.ok) {
                const uploadText = await uploadResponse.text();
                if (isAuthenticationError(new Error(uploadText))) {
                  await storage.toggleApiTokenStatus(token.id, false);
                }
                throw new Error(`Upload failed: ${uploadResponse.status} - ${uploadText}`);
              }

              const uploadData = await uploadResponse.json();
              mediaId = uploadData.mediaGenerationId?.mediaGenerationId || uploadData.mediaGenerationId;

              if (!mediaId) {
                throw new Error('No mediaId returned');
              }
              
              console.log(`[Character Bulk] Group ${groupIndex + 1}: Got mediaId ${mediaId} (upload attempt ${uploadAttempt})`);
              break; // Success!
              
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : 'Unknown error';
              console.error(`[Character Bulk] Group ${groupIndex + 1}: Upload attempt ${uploadAttempt}/${maxUploadRetries} failed: ${errMsg}`);
              
              if (uploadAttempt === maxUploadRetries) {
                // Mark all videos in this group as failed
                for (const video of videos) {
                  video.error = `Image upload failed after ${maxUploadRetries} attempts: ${errMsg}`;
                  await storage.updateVideoHistoryStatus(video.historyId, userId, 'failed', undefined, video.error);
                }
                return;
              }
              
              await new Promise(r => setTimeout(r, 1000)); // Wait before retry
            }
          }
          
          if (!mediaId) return;
          
          // Step B: Generate ALL videos in this group with SAME token + SAME mediaId
          // Process videos in this group in parallel
          await Promise.all(videos.map(async (item) => {
            const maxGenRetries = 3;
            
            for (let genAttempt = 1; genAttempt <= maxGenRetries; genAttempt++) {
              try {
                const payload = {
                  clientContext: {
                    sessionId: `session-${Date.now()}-${item.index}`,
                    projectId: veoProjectId,
                    tool: "PINHOLE",
                    userPaygateTier: "PAYGATE_TIER_TWO"
                  },
                  requests: [{
                    aspectRatio: aspectRatio === "portrait" ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE",
                    metadata: { sceneId: item.sceneId },
                    referenceImages: [
                      {
                        imageUsageType: "IMAGE_USAGE_TYPE_ASSET",
                        mediaId: mediaId
                      },
                      {
                        imageUsageType: "IMAGE_USAGE_TYPE_ASSET",
                        mediaId: mediaId
                      }
                    ],
                    seed: item.seed,
                    textInput: { prompt: item.augmentedPrompt },
                    videoModelKey: "veo_3_0_r2v_fast_ultra"
                  }]
                };

                const genResponse = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${token.token}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(payload),
                });

                const genResult = await genResponse.json();

                if (!genResponse.ok || !genResult.operations?.[0]?.operation?.name) {
                  const errorMsg = genResult?.error?.message || 'Video gen failed';
                  if (isAuthenticationError(new Error(errorMsg))) {
                    await storage.toggleApiTokenStatus(token.id, false);
                  }
                  throw new Error(errorMsg);
                }

                item.operationName = genResult.operations[0].operation.name;
                
                // Update history with operationName
                await storage.updateVideoHistoryFields(item.historyId, {
                  operationName: item.operationName,
                  sceneId: item.sceneId,
                  tokenUsed: token.id
                });
                
                await storage.incrementDailyVideoCount(userId);
                console.log(`[Character Bulk] ✅ Video ${item.index + 1}/${prompts.length} started (group ${groupIndex + 1}, token: ${token.label})`);
                return; // Success!
                
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : 'Unknown error';
                if (genAttempt === maxGenRetries) {
                  item.error = `Failed after ${maxGenRetries} attempts: ${errMsg}`;
                  await storage.updateVideoHistoryStatus(item.historyId, userId, 'failed', undefined, item.error);
                  console.error(`[Character Bulk] ❌ Video ${item.index + 1} failed: ${errMsg}`);
                } else {
                  await new Promise(r => setTimeout(r, 500)); // Brief delay before retry
                }
              }
            }
          }));
        };

        // Process all token groups in parallel
        const groupPromises: Promise<void>[] = [];
        tokenGroups.forEach((videos, groupIndex) => {
          groupPromises.push(processTokenGroup(groupIndex, videos));
        });
        await Promise.all(groupPromises);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const successCount = allItems.filter(i => i.operationName).length;
        const failCount = allItems.filter(i => i.error).length;
        
        console.log(`\n[Character Bulk] ========== OPTIMIZED COMPLETE ==========`);
        console.log(`[Character Bulk] Time: ${elapsed}s for ${prompts.length} videos`);
        console.log(`[Character Bulk] Success: ${successCount}, Failed: ${failCount}`);
        console.log(`[Character Bulk] Token groups used: ${tokenGroups.size} (${VIDEOS_PER_TOKEN} videos each)`);

        // Build results
        for (const item of allItems) {
          const token = allActiveTokens[item.tokenGroupIndex % allActiveTokens.length];
          if (item.operationName) {
            results.push({
              prompt: item.augmentedPrompt,
              operationName: item.operationName,
              sceneId: item.sceneId,
              historyId: item.historyId,
              tokenId: token.id
            });
          } else if (item.error) {
            results.push({
              prompt: item.augmentedPrompt,
              error: item.error,
              historyId: item.historyId
            });
          }
        }
      } // Close else block for image-based character flow

      res.json({ 
        results,
        characterName: character?.name || null,
        totalVideos: prompts.length,
        successfulStarts: results.filter(r => r.operationName).length,
        failedStarts: results.filter(r => r.error).length
      });

    } catch (error) {
      console.error("Error in character bulk generation:", error);
      res.status(500).json({ 
        error: "Failed to generate character videos",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Script-to-Frames: PARALLEL batch video generation with start/end images using SSE streaming
  // CRITICAL: Same token must be used for uploading start image, end image, and generating video for each scene
  // All scenes process in PARALLEL with different tokens assigned via round-robin
  app.post("/api/script-to-frames/generate-videos-stream", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const toolCheck = canAccessTool(user, "veo");
      if (!toolCheck.allowed) {
        return res.status(403).json({ error: toolCheck.reason });
      }

      const schema = z.object({
        scenes: z.array(z.object({
          sceneNumber: z.number(),
          videoPrompt: z.string().min(3),
          startImageBase64: z.string(),
          startImageMimeType: z.string(),
          endImageBase64: z.string(),
          endImageMimeType: z.string(),
        })).min(1).max(50),
        aspectRatio: z.enum(["landscape", "portrait"]).default("landscape"),
      });

      const validationResult = schema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }

      const { scenes, aspectRatio } = validationResult.data;
      
      console.log(`[Script-to-Frames Video PARALLEL] Starting batch of ${scenes.length} videos, User: ${user.username}`);
      const batchStartTime = Date.now();

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Transfer-Encoding', 'chunked');
      
      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
      }
      
      res.flushHeaders();

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Get all active tokens
      const activeTokens = await storage.getActiveApiTokens();
      if (activeTokens.length === 0) {
        sendEvent('error', { error: "No active API tokens available" });
        res.end();
        return;
      }

      // Video aspect ratio mapping
      const videoAspectRatio = aspectRatio === "landscape" 
        ? "VIDEO_ASPECT_RATIO_LANDSCAPE" 
        : "VIDEO_ASPECT_RATIO_PORTRAIT";
      
      const videoModelKey = "veo_3_1_i2v_s_fast_ultra_fl";

      // Pre-compute token assignments BEFORE launching workers (ensures stable assignment)
      const sceneTokenAssignments = scenes.map((scene, index) => {
        const token = activeTokens[index % activeTokens.length];
        return { scene, token, apiKey: token.token };
      });

      console.log(`[Script-to-Frames PARALLEL] Token assignments:`);
      sceneTokenAssignments.forEach(({ scene, token }) => {
        console.log(`  Scene ${scene.sceneNumber} -> Token ${token.label}`);
      });

      // Worker function to process a single scene (runs in parallel)
      // Token is passed in (pre-assigned) to ensure stability during parallel execution
      // Now includes silent fast retry with new token when needsTokenRetry is detected
      const processScene = async (scene: typeof scenes[0], initialToken: typeof activeTokens[0], initialApiKey: string, sceneIndex: number) => {
        const MAX_SILENT_RETRIES = 3;
        const excludedTokenIds = new Set<string>();
        let currentToken = initialToken;
        let currentApiKey = initialApiKey;
        let silentRetryCount = 0;
        
        // Outer retry loop for silent fast retries
        while (silentRetryCount <= MAX_SILENT_RETRIES) {
          console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Using Token ${currentToken.label} (ID: ${currentToken.id})${silentRetryCount > 0 ? ` [Silent Retry ${silentRetryCount}/${MAX_SILENT_RETRIES}]` : ''}`);
          
          sendEvent('status', { 
            sceneNumber: scene.sceneNumber, 
            status: 'uploading',
            message: silentRetryCount > 0 ? `Retrying with new token...` : 'Uploading start/end images...',
            tokenLabel: currentToken.label
          });

          try {
            // Step 1: Upload start image with this token
            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Uploading start image...`);
            const startUploadPayload = {
              imageInput: {
                rawImageBytes: scene.startImageBase64,
                mimeType: scene.startImageMimeType
              }
            };

            const startUploadResponse = await fetch('https://aisandbox-pa.googleapis.com/v1:uploadUserImage', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${currentApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(startUploadPayload),
            });

            if (!startUploadResponse.ok) {
              const errorText = await startUploadResponse.text();
              throw new Error(`Start image upload failed: ${startUploadResponse.statusText} - ${errorText.substring(0, 200)}`);
            }

            const startUploadData = await startUploadResponse.json();
            const startMediaId = startUploadData.mediaGenerationId?.mediaGenerationId || startUploadData.mediaGenerationId;
            
            if (!startMediaId) {
              throw new Error('No media ID returned for start image');
            }
            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Start image uploaded. Media ID: ${startMediaId}`);

            // Step 2: Upload end image with SAME token (critical for media ID consistency)
            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Uploading end image with SAME token...`);
            const endUploadPayload = {
              imageInput: {
                rawImageBytes: scene.endImageBase64,
                mimeType: scene.endImageMimeType
              }
            };

            const endUploadResponse = await fetch('https://aisandbox-pa.googleapis.com/v1:uploadUserImage', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${currentApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(endUploadPayload),
            });

            if (!endUploadResponse.ok) {
              const errorText = await endUploadResponse.text();
              throw new Error(`End image upload failed: ${endUploadResponse.statusText} - ${errorText.substring(0, 200)}`);
            }

            const endUploadData = await endUploadResponse.json();
            const endMediaId = endUploadData.mediaGenerationId?.mediaGenerationId || endUploadData.mediaGenerationId;
            
            if (!endMediaId) {
              throw new Error('No media ID returned for end image');
            }
            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: End image uploaded. Media ID: ${endMediaId}`);

            // Step 3: Generate video with SAME token using both media IDs (same token = valid media IDs)
            sendEvent('status', { 
              sceneNumber: scene.sceneNumber, 
              status: 'generating',
              message: 'Generating video...',
              tokenLabel: currentToken.label
            });

            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Generating video with start/end images using SAME token...`);
            
            const videoPayload = {
              clientContext: {
                sessionId: `;${Date.now()}`,
                projectId: crypto.randomUUID(),
                tool: "PINHOLE",
                userPaygateTier: "PAYGATE_TIER_TWO"
              },
              requests: [{
                aspectRatio: videoAspectRatio,
                seed: Math.floor(Math.random() * 100000),
                textInput: { prompt: scene.videoPrompt },
                videoModelKey: videoModelKey,
                startImage: { mediaId: startMediaId },
                endImage: { mediaId: endMediaId },
                metadata: { sceneId: `scene-${scene.sceneNumber}` }
              }]
            };

            const videoResponse = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${currentApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(videoPayload),
            });

            if (!videoResponse.ok) {
              const errorData = await videoResponse.json().catch(() => ({}));
              throw new Error(errorData.error?.message || `Video generation failed (${videoResponse.status})`);
            }

            const videoData = await videoResponse.json();
            const operationName = videoData.operations?.[0]?.operation?.name;
            
            if (!operationName) {
              throw new Error('No operation name returned from video generation');
            }

            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Video generation started. Operation: ${operationName}`);
            
            // Update token usage
            await storage.updateTokenUsage(currentToken.id);

            // Send status that video is processing
            sendEvent('status', { 
              sceneNumber: scene.sceneNumber, 
              status: 'processing',
              message: 'Video processing (~2 min)...',
              operationName: operationName,
              tokenLabel: currentToken.label
            });

            // Poll for video completion using the SAME token
            console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Waiting for video completion...`);
            const sceneIdForStatus = `scene-${scene.sceneNumber}`;
            const maxWaitTime = 300000; // 5 minutes
            const pollInterval = 15000; // 15 seconds
            const startWaitTime = Date.now();
            
            // Wait 15s before first check
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            let videoUrl: string | undefined;
            let pollAttempts = 0;
            let needsSilentRetry = false;
            
            while (Date.now() - startWaitTime < maxWaitTime) {
              pollAttempts++;
              try {
                const statusResult = await checkVideoStatus(operationName, sceneIdForStatus, currentApiKey);
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber} poll ${pollAttempts}: ${statusResult.status}`);
                
                // Check if we need to do a silent retry with a new token
                if (statusResult.needsTokenRetry) {
                  console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: needsTokenRetry detected! Initiating silent fast retry...`);
                  needsSilentRetry = true;
                  break;
                }
                
                if (statusResult.status === "COMPLETED" || 
                    statusResult.status === "MEDIA_GENERATION_STATUS_COMPLETE" || 
                    statusResult.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
                  if (statusResult.videoUrl) {
                    videoUrl = statusResult.videoUrl;
                    console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Video completed! URL received.`);
                    break;
                  }
                } else if (statusResult.status === "MEDIA_GENERATION_STATUS_FAILED" || 
                           statusResult.status === "FAILED") {
                  // Check if it's an INVALID_ARGUMENT error (token mismatch) - trigger silent retry
                  if (statusResult.error?.includes('INVALID_ARGUMENT') || statusResult.errorCode === 3) {
                    console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: INVALID_ARGUMENT error - token mismatch, triggering silent retry...`);
                    needsSilentRetry = true;
                    break;
                  }
                  throw new Error(statusResult.error || 'Video generation failed');
                }
                
                // Still pending, wait and poll again
                await new Promise(resolve => setTimeout(resolve, pollInterval));
              } catch (pollError: any) {
                console.error(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber} poll error:`, pollError);
                // Continue polling unless it's a definitive failure
                if (pollError.message?.includes('failed') && !pollError.message?.includes('INVALID_ARGUMENT')) {
                  throw pollError;
                }
                await new Promise(resolve => setTimeout(resolve, pollInterval));
              }
            }
            
            // Handle silent retry - get new token and restart from beginning
            if (needsSilentRetry) {
              silentRetryCount++;
              if (silentRetryCount > MAX_SILENT_RETRIES) {
                // Max retries exceeded, but don't throw - just mark as failed gracefully
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Max silent retries (${MAX_SILENT_RETRIES}) exceeded`);
                break; // Exit while loop, will hit final failure handler below
              }
              
              // Get a new token (excluding ones that have already failed in this session)
              const availableTokens = activeTokens.filter(t => !excludedTokenIds.has(t.id));
              
              if (availableTokens.length === 0) {
                // No alternate tokens available - try again with current token (don't throw)
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: No alternate tokens, retrying with same token ${currentToken.label}...`);
              } else if (availableTokens.length === 1 && availableTokens[0].id === currentToken.id) {
                // Only the current token is available - continue with it
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Only current token available, retrying with ${currentToken.label}...`);
              } else {
                // Mark current token as failed ONLY when we successfully switch to another
                excludedTokenIds.add(currentToken.id);
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Excluding failed token ${currentToken.label}, switching to new token...`);
                
                // Pick next available token (round-robin based on scene index + retry count)
                const filteredTokens = availableTokens.filter(t => t.id !== currentToken.id);
                if (filteredTokens.length > 0) {
                  currentToken = filteredTokens[(sceneIndex + silentRetryCount) % filteredTokens.length];
                  currentApiKey = currentToken.token;
                }
              }
              
              console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Silent retry ${silentRetryCount}/${MAX_SILENT_RETRIES} with token ${currentToken.label}`);
              
              // Brief delay before retry (exponential backoff: 2s, 4s, 8s)
              const retryDelay = Math.pow(2, silentRetryCount) * 1000;
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              
              // Continue to next iteration of outer retry loop
              continue;
            }
            
            if (!videoUrl) {
              throw new Error('Video generation timed out after 5 minutes');
            }

            // Success!
            sendEvent('video', {
              sceneNumber: scene.sceneNumber,
              status: 'completed',
              operationName: operationName,
              videoUrl: videoUrl,
              tokenId: currentToken.id,
              tokenLabel: currentToken.label
            });
            
            return { success: true, sceneNumber: scene.sceneNumber, videoUrl };

          } catch (error: any) {
            // Check if this error should trigger a silent retry
            const errorMsg = error.message || '';
            const shouldSilentRetry = errorMsg.includes('INVALID_ARGUMENT') || 
                                       errorMsg.includes('LMRoot') || 
                                       errorMsg.includes('code 13') ||
                                       errorMsg.includes('HIGH_TRAFFIC');
            
            if (shouldSilentRetry && silentRetryCount < MAX_SILENT_RETRIES) {
              silentRetryCount++;
              console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Error triggered silent retry ${silentRetryCount}/${MAX_SILENT_RETRIES}: ${errorMsg.substring(0, 100)}`);
              
              // Get a new token (excluding ones that already failed)
              const availableTokens = activeTokens.filter(t => !excludedTokenIds.has(t.id));
              
              if (availableTokens.length === 0) {
                // No alternate tokens - retry with same token
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: No alternate tokens, retrying with same token...`);
              } else if (availableTokens.length === 1 && availableTokens[0].id === currentToken.id) {
                // Only current token available - continue with it
                console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Only current token available, retrying...`);
              } else {
                // Switch to different token, mark current as failed
                excludedTokenIds.add(currentToken.id);
                const filteredTokens = availableTokens.filter(t => t.id !== currentToken.id);
                if (filteredTokens.length > 0) {
                  currentToken = filteredTokens[(sceneIndex + silentRetryCount) % filteredTokens.length];
                  currentApiKey = currentToken.token;
                  console.log(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: Switching to token ${currentToken.label}`);
                }
              }
              
              // Brief delay before retry
              const retryDelay = Math.pow(2, silentRetryCount) * 1000;
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              
              continue; // Retry with token
            }
            
            console.error(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber} failed:`, error);
            
            // Handle token errors
            await handleTokenError(currentToken.id, error);
            
            sendEvent('video', {
              sceneNumber: scene.sceneNumber,
              status: 'failed',
              error: error.message || 'Unknown error',
              tokenLabel: currentToken.label
            });
            
            return { success: false, sceneNumber: scene.sceneNumber, error: error.message };
          }
        }
        
        // If we exit the retry loop without returning, it's a failure
        console.error(`[Script-to-Frames PARALLEL] Scene ${scene.sceneNumber}: All retry attempts exhausted`);
        sendEvent('video', {
          sceneNumber: scene.sceneNumber,
          status: 'failed',
          error: `Failed after ${MAX_SILENT_RETRIES} silent retries`,
          tokenLabel: currentToken.label
        });
        
        return { success: false, sceneNumber: scene.sceneNumber, error: `Failed after ${MAX_SILENT_RETRIES} silent retries` };
      };

      // Send initial status for all scenes using pre-computed assignments
      sceneTokenAssignments.forEach(({ scene, token }) => {
        sendEvent('status', { 
          sceneNumber: scene.sceneNumber, 
          status: 'pending',
          message: 'Waiting to start...',
          tokenLabel: token.label,
          progress: { current: 0, total: scenes.length }
        });
      });

      // Process ALL scenes in PARALLEL using pre-assigned tokens
      console.log(`[Script-to-Frames PARALLEL] Starting ${scenes.length} scene workers in parallel...`);
      const workers = sceneTokenAssignments.map(({ scene, token, apiKey }, index) => 
        processScene(scene, token, apiKey, index)
      );
      
      // Wait for all workers to complete
      const results = await Promise.allSettled(workers);
      
      // Count results AFTER all workers complete (avoids race conditions)
      const successCount = results.filter(r => r.status === 'fulfilled' && (r.value as any)?.success).length;
      const failedCount = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !(r.value as any)?.success)).length;
      
      const duration = ((Date.now() - batchStartTime) / 1000).toFixed(1);
      console.log(`[Script-to-Frames PARALLEL Complete] ${successCount}/${scenes.length} succeeded in ${duration}s`);

      sendEvent('complete', {
        success: true,
        summary: {
          total: scenes.length,
          success: successCount,
          failed: failedCount,
          duration: `${duration}s`
        }
      });

      res.end();
    } catch (error) {
      console.error("Error in /api/script-to-frames/generate-videos-stream:", error);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Batch video generation failed" })}\n\n`);
      res.end();
    }
  });


  // ==================== UGC VIDEOS - WHISK API FLOW ====================
  
  // Step 1: Caption the uploaded image
  app.post("/api/ugc/caption-image", requireAuth, async (req: Request, res: Response) => {
    try {
      const { imageBase64 } = req.body;

      if (!imageBase64) {
        return res.status(400).json({ error: "Image is required" });
      }

      const appSettings = await storage.getAppSettings();
      const googleLabsCookie = appSettings?.googleLabsCookie;

      if (!googleLabsCookie) {
        return res.status(400).json({ 
          error: "Google Labs cookie not configured", 
          details: "Please configure the Google Labs cookie in admin settings" 
        });
      }

      const workflowId = uuidv4();
      const sessionId = `;${Date.now()}`;

      const response = await fetch("https://labs.google/fx/api/trpc/backbone.captionImage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": googleLabsCookie
        },
        body: JSON.stringify({
          json: {
            clientContext: {
              sessionId,
              workflowId
            },
            captionInput: {
              candidatesCount: 1,
              mediaInput: {
                mediaCategory: "MEDIA_CATEGORY_SUBJECT",
                rawBytes: imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
              }
            }
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[UGC Caption] API Error:", errorText);
        return res.status(response.status).json({ error: "Failed to caption image", details: errorText });
      }

      const data = await response.json();
      const caption = data?.result?.data?.json?.result?.candidates?.[0]?.output || "";

      res.json({ 
        success: true, 
        caption,
        workflowId,
        sessionId
      });

    } catch (error) {
      console.error("[UGC Caption] Error:", error);
      res.status(500).json({ error: "Caption generation failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Step 2: Upload image with caption to Whisk (via labs.google)
  app.post("/api/ugc/upload-image", requireAuth, async (req: Request, res: Response) => {
    try {
      const { imageBase64, caption, workflowId, sessionId } = req.body;

      if (!imageBase64 || !caption) {
        return res.status(400).json({ error: "Image and caption are required" });
      }

      const appSettings = await storage.getAppSettings();
      const googleLabsCookie = appSettings?.googleLabsCookie;

      if (!googleLabsCookie) {
        return res.status(400).json({ error: "Google Labs cookie not configured" });
      }

      const wfId = workflowId || uuidv4();
      const sessId = sessionId || `;${Date.now()}`;
      const imageData = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

      const response = await fetch("https://labs.google/fx/api/trpc/backbone.uploadImage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": googleLabsCookie
        },
        body: JSON.stringify({
          json: {
            clientContext: { workflowId: wfId, sessionId: sessId },
            uploadMediaInput: {
              mediaCategory: "MEDIA_CATEGORY_SUBJECT",
              rawBytes: imageData,
              caption
            }
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[UGC Upload] API Error:", errorText);
        return res.status(response.status).json({ error: "Failed to upload image", details: errorText });
      }

      const data = await response.json();
      const uploadMediaGenerationId = data?.result?.data?.json?.result?.uploadMediaGenerationId;

      res.json({ 
        success: true, 
        uploadMediaGenerationId,
        workflowId: wfId,
        sessionId: sessId
      });

    } catch (error) {
      console.error("[UGC Upload] Error:", error);
      res.status(500).json({ error: "Image upload failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Step 3: Generate UGC image with person holding product
  app.post("/api/ugc/generate-ugc-image", requireAuth, async (req: Request, res: Response) => {
    try {
      const { uploadMediaGenerationId, caption, userPrompt, workflowId, sessionId, aspectRatio } = req.body;

      if (!uploadMediaGenerationId || !caption) {
        return res.status(400).json({ error: "Upload media ID and caption are required" });
      }

      // Get an active API token from the token pool
      const tokenIndex = Math.floor(Math.random() * 1000);
      const apiToken = await storage.getTokenByIndex(tokenIndex);

      if (!apiToken) {
        return res.status(400).json({ 
          error: "No active API tokens available", 
          details: "Please add API tokens in admin panel" 
        });
      }

      const bearerToken = apiToken.token;

      const defaultPrompt = userPrompt || "Make a UGC image of this item with a person, 19 to 25 year old, showing the product clearly, natural lighting, authentic style";
      const seed = Math.floor(Math.random() * 1000000);

      console.log(`[UGC Generate Image] Using token: ${apiToken.label}`);
      const response = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          clientContext: {
            workflowId: workflowId || uuidv4(),
            tool: "BACKBONE",
            sessionId: sessionId || `;${Date.now()}`
          },
          seed,
          imageModelSettings: {
            imageModel: "GEM_PIX",
            aspectRatio: aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE"
          },
          userInstruction: defaultPrompt,
          recipeMediaInputs: [{
            caption,
            mediaInput: {
              mediaCategory: "MEDIA_CATEGORY_SUBJECT",
              mediaGenerationId: uploadMediaGenerationId
            }
          }]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[UGC Generate Image] API Error:", errorText);
        return res.status(response.status).json({ error: "Failed to generate UGC image", details: errorText });
      }

      const data = await response.json();
      const generatedImage = data?.imagePanels?.[0]?.generatedImages?.[0];
      
      if (!generatedImage) {
        return res.status(500).json({ error: "No image generated" });
      }

      res.json({ 
        success: true, 
        encodedImage: generatedImage.encodedImage,
        mediaGenerationId: generatedImage.mediaGenerationId,
        workflowId,
        sessionId
      });

    } catch (error) {
      console.error("[UGC Generate Image] Error:", error);
      res.status(500).json({ error: "UGC image generation failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Step 4: Generate video from UGC image
  app.post("/api/ugc/generate-video", requireAuth, async (req: Request, res: Response) => {
    try {
      const { encodedImage, mediaGenerationId, caption, videoPrompt, workflowId, sessionId } = req.body;

      if (!encodedImage || !mediaGenerationId) {
        return res.status(400).json({ error: "Encoded image and media generation ID are required" });
      }

      // Get an active API token from the token pool
      const tokenIndex = Math.floor(Math.random() * 1000);
      const apiToken = await storage.getTokenByIndex(tokenIndex);

      if (!apiToken) {
        return res.status(400).json({ error: "No active API tokens available" });
      }

      const bearerToken = apiToken.token;
      const defaultVideoPrompt = videoPrompt || `Make an intro UGC video of this product. ${caption || ""}`;

      console.log(`[UGC Generate Video] Using token: ${apiToken.label}`);
      const response = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          clientContext: {
            sessionId: sessionId || `;${Date.now()}`,
            tool: "BACKBONE",
            workflowId: workflowId || uuidv4()
          },
          promptImageInput: {
            prompt: defaultVideoPrompt,
            rawBytes: encodedImage,
            mediaGenerationId
          },
          modelNameType: "VEO_3_1_I2V_12STEP",
          modelKey: "",
          userInstructions: defaultVideoPrompt,
          loopVideo: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[UGC Generate Video] API Error:", errorText);
        return res.status(response.status).json({ error: "Failed to generate video", details: errorText });
      }

      const data = await response.json();
      const operationName = data?.operation?.operation?.name;
      const sceneId = data?.operation?.sceneId || "";

      if (!operationName) {
        return res.status(500).json({ error: "No operation name returned" });
      }

      res.json({ 
        success: true, 
        operationName,
        sceneId,
        status: "MEDIA_GENERATION_STATUS_PENDING"
      });

    } catch (error) {
      console.error("[UGC Generate Video] Error:", error);
      res.status(500).json({ error: "Video generation failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Step 5: Check video generation status
  app.post("/api/ugc/check-video-status", requireAuth, async (req: Request, res: Response) => {
    try {
      const { operationName, sceneId, tokenId, historyId, retryCount = 0, ugcImage, prompt } = req.body;
      const MAX_AUTO_RETRIES = 5;

      if (!operationName) {
        return res.status(400).json({ error: "Operation name is required" });
      }

      // Use specific token if provided (CRITICAL: must use same token that created video)
      let apiToken;
      if (tokenId) {
        apiToken = await storage.getTokenById(tokenId);
        console.log(`[UGC Check Status] Using specific token: ${apiToken?.label || 'NOT FOUND'}`);
      }
      
      if (!apiToken) {
        // Fallback to rotation if specific token not found
        const tokenIndex = Math.floor(Math.random() * 1000);
        apiToken = await storage.getTokenByIndex(tokenIndex);
        console.log(`[UGC Check Status] WARNING: Using rotation token (may cause "Video not found")`);
      }

      if (!apiToken) {
        return res.status(400).json({ error: "No active API tokens available" });
      }

      const bearerToken = apiToken.token;

      const response = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          operations: [{
            operation: { name: operationName },
            sceneId: sceneId || "",
            status: "MEDIA_GENERATION_STATUS_PENDING"
          }]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[UGC Check Status] API Error:", errorText);
        return res.status(response.status).json({ error: "Failed to check video status", details: errorText });
      }

      const data = await response.json();
      console.log("[UGC Check Status] Full API response:", JSON.stringify(data, null, 2));
      
      const operation = data?.operations?.[0];
      const status = operation?.status || "MEDIA_GENERATION_STATUS_PENDING";
      const videoUrl = operation?.result?.video?.uri || null;
      const encodedVideo = operation?.result?.video?.encodedVideo || null;

      // Check for video URL in the response structure (same as bulk flow)
      const fifeUrl = operation?.operation?.metadata?.video?.fifeUrl;
      // Decode HTML entities in URL - &amp; becomes &
      let decodedVideoUrl = fifeUrl || videoUrl;
      if (decodedVideoUrl) {
        decodedVideoUrl = decodedVideoUrl.split('&amp;').join('&');
      }
      
      const isComplete = status === "MEDIA_GENERATION_STATUS_SUCCESSFUL" || status === "MEDIA_GENERATION_STATUS_SUCCEEDED";
      const isFailed = status === "MEDIA_GENERATION_STATUS_FAILED";
      
      console.log(`[UGC Check Status] Status: ${status}, isComplete: ${isComplete}, isFailed: ${isFailed}, videoUrl: ${decodedVideoUrl}, retryCount: ${retryCount}`);

      // AUTO RETRY on failure if we have the required data and haven't exceeded max retries
      if (isFailed && retryCount < MAX_AUTO_RETRIES && ugcImage && prompt) {
        console.log(`[UGC Auto Retry] Attempt ${retryCount + 1}/${MAX_AUTO_RETRIES} - Starting auto retry with different token...`);
        
        // Get a different token for retry
        const excludeTokenId = tokenId;
        let retryToken = await storage.getTokenByIndex(Math.floor(Math.random() * 1000));
        
        // Try to get a different token
        let attempts = 0;
        while (retryToken?.id === excludeTokenId && attempts < 5) {
          retryToken = await storage.getTokenByIndex(Math.floor(Math.random() * 1000));
          attempts++;
        }
        
        if (!retryToken) {
          console.error("[UGC Auto Retry] No token available for retry");
          return res.json({ 
            success: true, 
            status,
            isComplete,
            isFailed: true,
            videoUrl: null,
            encodedVideo: null,
            retryCount,
            autoRetryExhausted: true
          });
        }
        
        console.log(`[UGC Auto Retry] Using token: ${retryToken.label} for retry`);
        
        const retrySessionId = `;${Date.now()}`;
        const retryWorkflowId = uuidv4();
        
        // Step 1: Upload the UGC image again
        const uploadPayload = {
          imageInput: {
            rawBytes: ugcImage,
            mimeType: "image/png"
          },
          clientContext: {
            sessionId: retrySessionId,
            tool: "ASSET_MANAGER"
          }
        };
        
        const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${retryToken.token}`
          },
          body: JSON.stringify(uploadPayload)
        });
        
        if (!uploadResponse.ok) {
          console.error("[UGC Auto Retry] Upload failed:", await uploadResponse.text());
          return res.json({ 
            success: true, 
            status,
            isComplete,
            isFailed: true,
            videoUrl: null,
            autoRetryFailed: true
          });
        }
        
        const uploadData = await uploadResponse.json();
        const newMediaId = uploadData?.mediaGenerationId?.mediaGenerationId || uploadData?.mediaGenerationId;
        console.log("[UGC Auto Retry] Upload successful, new media ID:", newMediaId);
        
        // Step 2: Generate video again
        const videoPayload = {
          clientContext: { sessionId: retrySessionId, tool: "BACKBONE", workflowId: retryWorkflowId },
          promptImageInput: {
            prompt: prompt,
            rawBytes: ugcImage,
            mediaGenerationId: newMediaId
          },
          modelNameType: "VEO_3_1_I2V_12STEP",
          modelKey: "",
          userInstructions: prompt,
          loopVideo: false
        };
        
        const videoResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            "Authorization": `Bearer ${retryToken.token}`
          },
          body: JSON.stringify(videoPayload)
        });
        
        if (!videoResponse.ok) {
          console.error("[UGC Auto Retry] Video generation failed:", await videoResponse.text());
          return res.json({ 
            success: true, 
            status,
            isComplete,
            isFailed: true,
            videoUrl: null,
            autoRetryFailed: true
          });
        }
        
        const videoData = await videoResponse.json();
        const newOperationName = videoData?.operation?.operation?.name;
        const newSceneId = videoData?.operation?.sceneId || "";
        
        if (!newOperationName) {
          console.error("[UGC Auto Retry] No operation name in response");
          return res.json({ 
            success: true, 
            status,
            isComplete,
            isFailed: true,
            videoUrl: null,
            autoRetryFailed: true
          });
        }
        
        console.log(`[UGC Auto Retry] SUCCESS - New operation: ${newOperationName}, new tokenId: ${retryToken.id}`);
        
        // Return the new operation for continued polling
        return res.json({ 
          success: true, 
          status: "MEDIA_GENERATION_STATUS_PENDING",
          isComplete: false,
          isFailed: false,
          videoUrl: null,
          encodedVideo: null,
          // New retry info
          isRetrying: true,
          newOperationName,
          newSceneId,
          newTokenId: retryToken.id,
          retryCount: retryCount + 1
        });
      }
      
      res.json({ 
        success: true, 
        status,
        isComplete,
        isFailed,
        videoUrl: decodedVideoUrl,
        encodedVideo,
        retryCount
      });

    } catch (error) {
      console.error("[UGC Check Status] Error:", error);
      res.status(500).json({ error: "Status check failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Extend Scene endpoint - extracts last frame, uploads, generates extended video
  app.post("/api/ugc/extend-scene", requireAuth, async (req: Request, res: Response) => {
    try {
      const { videoUrl, prompt, aspectRatio, caption, tokenId } = req.body;

      if (!videoUrl) {
        return res.status(400).json({ error: "Video URL is required" });
      }

      console.log("[UGC Extend Scene] Starting extend scene flow...");
      console.log("[UGC Extend Scene] Video URL:", videoUrl.substring(0, 100) + "...");

      // Use provided tokenId if available, otherwise select a new token
      let apiToken;
      if (tokenId) {
        apiToken = await storage.getTokenById(tokenId);
        console.log(`[UGC Extend Scene] Using provided token: ${apiToken?.label}`);
      }
      
      if (!apiToken) {
        const tokenIndex = Math.floor(Math.random() * 1000);
        apiToken = await storage.getTokenByIndex(tokenIndex);
        console.log(`[UGC Extend Scene] Using new token: ${apiToken?.label}`);
      }

      if (!apiToken) {
        return res.status(400).json({ error: "No active API tokens available" });
      }

      const bearerToken = apiToken.token;
      console.log(`[UGC Extend Scene] Token confirmed: ${apiToken.label}`);

      // Build default prompt if not provided
      const finalPrompt = prompt?.trim() || `extend this ugc video for this product ${caption || ""}`;
      console.log("[UGC Extend Scene] Using prompt:", finalPrompt);

      // Step 1: Download the video
      console.log("[UGC Extend Scene] Step 1: Downloading video...");
      const videoResponse = await fetch(videoUrl);
      if (!videoResponse.ok) {
        throw new Error("Failed to download video");
      }
      const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
      console.log("[UGC Extend Scene] Video downloaded, size:", videoBuffer.length);

      // Step 2: Extract last frame from video using ffmpeg
      console.log("[UGC Extend Scene] Step 2: Extracting last frame...");
      const fs = await import("fs");
      const path = await import("path");
      const { exec } = await import("child_process");
      const util = await import("util");
      const execPromise = util.promisify(exec);

      // Check if ffmpeg is available
      try {
        await execPromise("which ffmpeg");
        await execPromise("which ffprobe");
      } catch (checkError) {
        console.error("[UGC Extend Scene] FFmpeg/FFprobe not installed");
        throw new Error("FFmpeg is not available. Please install FFmpeg to use Extend Scene feature.");
      }

      const tempDir = "/tmp";
      const tempVideoPath = path.join(tempDir, `extend_video_${Date.now()}.mp4`);
      const tempFramePath = path.join(tempDir, `extend_frame_${Date.now()}.jpg`);

      // Write video to temp file
      fs.writeFileSync(tempVideoPath, videoBuffer);

      // Extract last frame using ffmpeg - go to last second and get frame
      try {
        // First get video duration
        const { stdout: durationOutput } = await execPromise(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempVideoPath}"`
        );
        const duration = parseFloat(durationOutput.trim());
        const lastFrameTime = Math.max(0, duration - 0.1);
        
        // Extract frame at last position
        await execPromise(
          `ffmpeg -y -ss ${lastFrameTime} -i "${tempVideoPath}" -frames:v 1 -q:v 2 "${tempFramePath}"`
        );
        console.log("[UGC Extend Scene] Last frame extracted at time:", lastFrameTime);
      } catch (ffmpegError) {
        console.error("[UGC Extend Scene] FFmpeg error:", ffmpegError);
        // Cleanup temp video file
        try { fs.unlinkSync(tempVideoPath); } catch (e) {}
        throw new Error("Failed to extract last frame from video");
      }

      // Read the extracted frame
      const frameBuffer = fs.readFileSync(tempFramePath);
      const frameBase64 = frameBuffer.toString("base64");
      console.log("[UGC Extend Scene] Frame extracted, size:", frameBuffer.length);

      // Cleanup temp files
      try { fs.unlinkSync(tempVideoPath); } catch (e) {}
      try { fs.unlinkSync(tempFramePath); } catch (e) {}

      // Step 3: Upload the last frame image to get media ID using uploadUserImage (same as UGC flow)
      console.log("[UGC Extend Scene] Step 3: Uploading last frame image via aisandbox...");
      
      // Determine aspect ratio for the upload
      const uploadAspectRatio = aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE";
      
      const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          imageInput: {
            rawImageBytes: frameBase64,
            mimeType: "image/jpeg",
            isUserUploaded: true,
            aspectRatio: uploadAspectRatio
          },
          clientContext: {
            sessionId: uuidv4(),
            tool: "ASSET_MANAGER"
          }
        })
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error("[UGC Extend Scene] Upload failed:", uploadResponse.status, errorText);
        throw new Error(`Failed to upload last frame image: ${uploadResponse.status}`);
      }

      const uploadData = await uploadResponse.json();
      console.log("[UGC Extend Scene] Upload response:", JSON.stringify(uploadData).substring(0, 500));
      
      // Response has nested structure: { mediaGenerationId: { mediaGenerationId: "actual_id" } }
      const mediaGenerationId = uploadData?.mediaGenerationId?.mediaGenerationId || uploadData?.mediaGenerationId;
      console.log("[UGC Extend Scene] Media ID:", mediaGenerationId);

      if (!mediaGenerationId) {
        console.error("[UGC Extend Scene] Full upload response:", JSON.stringify(uploadData));
        throw new Error("Failed to get media ID from upload");
      }

      // Step 4: Generate extended video using the last frame (whisk:generateVideo format)
      console.log("[UGC Extend Scene] Step 4: Generating extended video via whisk:generateVideo...");
      
      const sessionId = `;${Date.now()}`;
      const workflowId = uuidv4();
      
      // Use EXACT format from UGC full flow Step 5
      const generateVideoPayload = {
        clientContext: { 
          sessionId, 
          tool: "BACKBONE", 
          workflowId 
        },
        promptImageInput: {
          prompt: finalPrompt,
          rawBytes: frameBase64,
          mediaGenerationId: mediaGenerationId
        },
        modelNameType: "VEO_3_1_I2V_12STEP",
        modelKey: "",
        userInstructions: finalPrompt,
        loopVideo: false
      };

      console.log("[UGC Extend Scene] Video generation payload (without base64):", JSON.stringify({
        ...generateVideoPayload,
        promptImageInput: {
          ...generateVideoPayload.promptImageInput,
          rawBytes: "[BASE64_TRUNCATED]"
        }
      }, null, 2));

      const videoGenResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify(generateVideoPayload)
      });

      if (!videoGenResponse.ok) {
        const errorText = await videoGenResponse.text();
        console.error("[UGC Extend Scene] Video generation failed:", videoGenResponse.status, errorText);
        throw new Error("Failed to generate extended video");
      }

      const videoGenData = await videoGenResponse.json();
      console.log("[UGC Extend Scene] Video generation response:", JSON.stringify(videoGenData, null, 2));

      // Extract operation name from whisk response format (same as UGC full flow)
      const operationName = videoGenData?.operation?.operation?.name;
      const sceneId = videoGenData?.operation?.sceneId || "";

      if (!operationName) {
        throw new Error("Failed to get operation name from video generation");
      }

      console.log(`[UGC Extend Scene] Video operation started: ${operationName}`);

      res.json({
        success: true,
        operationName,
        sceneId,
        tokenId: apiToken.id
      });

    } catch (error) {
      console.error("[UGC Extend Scene] Error:", error);
      res.status(500).json({ error: "Extend scene failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Merge all UGC videos endpoint - first video full, subsequent videos trimmed 1s from start
  app.post("/api/ugc/merge-all-videos", requireAuth, async (req: Request, res: Response) => {
    try {
      const { videoUrls } = req.body;

      if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length < 2) {
        return res.status(400).json({ error: "At least 2 video URLs are required for merging" });
      }

      console.log(`[UGC Merge] Starting merge of ${videoUrls.length} videos...`);

      // Import the merge function
      const { mergeUGCVideosWithTrim } = await import('./videoMergerFFmpeg.js');
      
      const { filePath, tempDir } = await mergeUGCVideosWithTrim(videoUrls);
      
      console.log(`[UGC Merge] Merge complete! Serving file for download: ${filePath}`);

      // Set headers for file download
      const filename = `merged-ugc-video-${Date.now()}.mp4`;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      // Stream the file to the response
      const fileStream = createReadStream(filePath);
      
      fileStream.on('end', async () => {
        // Clean up temp directory after download completes
        try {
          await rm(tempDir, { recursive: true, force: true });
          console.log(`[UGC Merge] Cleanup successful: ${tempDir}`);
        } catch (cleanupError) {
          console.error(`[UGC Merge] Cleanup failed:`, cleanupError);
        }
      });
      
      fileStream.on('error', async (err) => {
        console.error(`[UGC Merge] File stream error:`, err);
        // Clean up on error too
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch (e) {}
      });
      
      fileStream.pipe(res);

    } catch (error) {
      console.error("[UGC Merge] Error:", error);
      res.status(500).json({ error: "Video merge failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  // Full UGC flow endpoint - orchestrates all steps
  app.post("/api/ugc/full-flow", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { imageBase64, userPrompt, videoPrompt, aspectRatio } = req.body;

      if (!imageBase64) {
        return res.status(400).json({ error: "Image is required" });
      }

      const appSettings = await storage.getAppSettings();
      const googleLabsCookie = appSettings?.googleLabsCookie;

      if (!googleLabsCookie) {
        return res.status(400).json({ error: "Google Labs cookie not configured" });
      }

      // Get an active API token from the token pool
      const tokenIndex = Math.floor(Math.random() * 1000);
      const apiToken = await storage.getTokenByIndex(tokenIndex);

      if (!apiToken) {
        return res.status(400).json({ error: "No active API tokens available" });
      }

      const bearerToken = apiToken.token;
      console.log(`[UGC Full Flow] Using token: ${apiToken.label}`);

      const workflowId = uuidv4();
      const sessionId = `;${Date.now()}`;
      const imageData = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

      // Step 1: Caption the image
      console.log("[UGC Full Flow] Step 1: Captioning image...");
      const captionResponse = await fetch("https://labs.google/fx/api/trpc/backbone.captionImage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": googleLabsCookie
        },
        body: JSON.stringify({
          json: {
            clientContext: { sessionId, workflowId },
            captionInput: {
              candidatesCount: 1,
              mediaInput: {
                mediaCategory: "MEDIA_CATEGORY_SUBJECT",
                rawBytes: imageData
              }
            }
          }
        })
      });

      if (!captionResponse.ok) {
        const errorText = await captionResponse.text();
        console.error("[UGC Full Flow] Caption failed:", errorText);
        return res.status(captionResponse.status).json({ error: "Failed to caption image", details: errorText });
      }

      const captionData = await captionResponse.json();
      const caption = captionData?.result?.data?.json?.result?.candidates?.[0]?.output || "";
      console.log("[UGC Full Flow] Caption:", caption.substring(0, 100) + "...");

      // Step 2: Upload original image via aisandbox (using bearer token)
      console.log("[UGC Full Flow] Step 2: Uploading original image via aisandbox...");
      const uploadResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          imageInput: {
            rawImageBytes: imageBase64,
            mimeType: "image/jpeg",
            isUserUploaded: true,
            aspectRatio: aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE"
          },
          clientContext: {
            sessionId,
            tool: "ASSET_MANAGER"
          }
        })
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error("[UGC Full Flow] Upload failed:", errorText);
        return res.status(uploadResponse.status).json({ error: "Failed to upload image", details: errorText });
      }

      const uploadData = await uploadResponse.json();
      console.log("[UGC Full Flow] Upload response:", JSON.stringify(uploadData).substring(0, 500));
      // Response has nested structure: { mediaGenerationId: { mediaGenerationId: "actual_id" } }
      const uploadMediaGenerationId = uploadData?.mediaGenerationId?.mediaGenerationId || uploadData?.mediaGenerationId;
      console.log("[UGC Full Flow] Upload ID:", uploadMediaGenerationId);
      
      if (!uploadMediaGenerationId || typeof uploadMediaGenerationId !== 'string') {
        console.error("[UGC Full Flow] No valid mediaGenerationId in upload response");
        return res.status(500).json({ error: "No mediaGenerationId returned from upload" });
      }

      // Step 3: Generate UGC image
      console.log("[UGC Full Flow] Step 3: Generating UGC image...");
      const defaultUserPrompt = userPrompt || "Make a UGC image of this item with a person, 19 to 25 year old, showing the product clearly, natural lighting, authentic influencer style";
      const seed = Math.floor(Math.random() * 1000000);

      const ugcImageResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:runImageRecipe", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          clientContext: { workflowId, tool: "BACKBONE", sessionId },
          seed,
          imageModelSettings: {
            imageModel: "GEM_PIX",
            aspectRatio: aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE"
          },
          userInstruction: defaultUserPrompt,
          recipeMediaInputs: [{
            caption,
            mediaInput: {
              mediaCategory: "MEDIA_CATEGORY_SUBJECT",
              mediaGenerationId: uploadMediaGenerationId
            }
          }]
        })
      });

      if (!ugcImageResponse.ok) {
        const errorText = await ugcImageResponse.text();
        console.error("[UGC Full Flow] UGC image failed:", errorText);
        return res.status(ugcImageResponse.status).json({ error: "Failed to generate UGC image", details: errorText });
      }

      const ugcImageData = await ugcImageResponse.json();
      const generatedImage = ugcImageData?.imagePanels?.[0]?.generatedImages?.[0];
      
      if (!generatedImage) {
        return res.status(500).json({ error: "No UGC image generated" });
      }

      // Note: generatedImage.mediaGenerationId may be nested object or string
      const step3MediaId = generatedImage.mediaGenerationId?.mediaGenerationId || generatedImage.mediaGenerationId;
      console.log("[UGC Full Flow] UGC image generated, mediaGenerationId:", step3MediaId);

      // Step 4: Upload generated image to aisandbox (creates accessible mediaGenerationId)
      console.log("[UGC Full Flow] Step 4: Uploading generated image to aisandbox...");
      const uploadUserImageResponse = await fetch("https://aisandbox-pa.googleapis.com/v1:uploadUserImage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          imageInput: {
            rawImageBytes: generatedImage.encodedImage,
            mimeType: "image/jpeg",
            isUserUploaded: true,
            aspectRatio: aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE"
          },
          clientContext: {
            sessionId,
            tool: "ASSET_MANAGER"
          }
        })
      });

      if (!uploadUserImageResponse.ok) {
        const errorText = await uploadUserImageResponse.text();
        console.error("[UGC Full Flow] Upload user image failed:", errorText);
        return res.status(uploadUserImageResponse.status).json({ error: "Failed to upload generated image", details: errorText });
      }

      const uploadUserImageData = await uploadUserImageResponse.json();
      console.log("[UGC Full Flow] Upload user image response:", JSON.stringify(uploadUserImageData).substring(0, 500));
      // Response has nested structure: { mediaGenerationId: { mediaGenerationId: "actual_id" } }
      const newMediaGenerationId = uploadUserImageData?.mediaGenerationId?.mediaGenerationId || uploadUserImageData?.mediaGenerationId;
      console.log("[UGC Full Flow] New mediaGenerationId:", newMediaGenerationId);
      
      if (!newMediaGenerationId || typeof newMediaGenerationId !== 'string') {
        console.error("[UGC Full Flow] No valid newMediaGenerationId in upload response");
        return res.status(500).json({ error: "No valid mediaGenerationId from generated image upload" });
      }

      // Step 5: Generate video
      console.log("[UGC Full Flow] Step 5: Generating video...");
      const defaultVideoPrompt = videoPrompt || `Make an engaging intro UGC video of this product. ${caption}`;

      const videoResponse = await fetch("https://aisandbox-pa.googleapis.com/v1/whisk:generateVideo", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Authorization": `Bearer ${bearerToken}`
        },
        body: JSON.stringify({
          clientContext: { sessionId, tool: "BACKBONE", workflowId },
          promptImageInput: {
            prompt: defaultVideoPrompt,
            rawBytes: generatedImage.encodedImage,
            mediaGenerationId: newMediaGenerationId || step3MediaId
          },
          modelNameType: "VEO_3_1_I2V_12STEP",
          modelKey: "",
          userInstructions: defaultVideoPrompt,
          loopVideo: false
        })
      });

      if (!videoResponse.ok) {
        const errorText = await videoResponse.text();
        console.error("[UGC Full Flow] Video generation failed:", errorText);
        return res.status(videoResponse.status).json({ error: "Failed to start video generation", details: errorText });
      }

      const videoData = await videoResponse.json();
      const operationName = videoData?.operation?.operation?.name;
      const sceneId = videoData?.operation?.sceneId || "";

      if (!operationName) {
        return res.status(500).json({ error: "No operation name returned for video" });
      }

      console.log("[UGC Full Flow] Video operation started:", operationName);

      // Save to history
      const historyEntry = await storage.addVideoHistory({
        userId,
        prompt: defaultVideoPrompt,
        status: "processing",
        aspectRatio: aspectRatio === "IMAGE_ASPECT_RATIO_PORTRAIT" ? "9:16" : aspectRatio === "IMAGE_ASPECT_RATIO_SQUARE" ? "1:1" : "16:9",
        referenceImageUrl: generatedImage.encodedImage ? `data:image/png;base64,${generatedImage.encodedImage}` : null,
        operationName,
        sceneId
      });

      res.json({ 
        success: true,
        caption,
        ugcImage: generatedImage.encodedImage,
        ugcImageMediaId: step3MediaId,
        operationName,
        sceneId,
        historyId: historyEntry.id,
        tokenId: apiToken.id,
        status: "processing"
      });

    } catch (error) {
      console.error("[UGC Full Flow] Error:", error);
      res.status(500).json({ error: "UGC generation failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
