import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import { secureApiKeys, usedNonces, securityAuditLog, ipBlocklist } from '@shared/schema';
import { eq, and, gt, lt } from 'drizzle-orm';

const REQUEST_TIMESTAMP_TOLERANCE_MS = 30000;
const NONCE_EXPIRY_MINUTES = 5;

export interface SecureRequest extends Request {
  secureApiKey?: {
    id: string;
    userId: string;
    role: string;
    label: string;
  };
}

async function logSecurityEvent(
  action: string,
  req: Request,
  apiKeyId?: string,
  userId?: string,
  statusCode?: number,
  errorMessage?: string
) {
  try {
    await db.insert(securityAuditLog).values({
      apiKeyId,
      userId,
      action,
      ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      endpoint: req.path,
      statusCode,
      errorMessage,
    });
  } catch (error) {
    console.error('[Security] Failed to log audit event:', error);
  }
}

export async function ipBlocklistMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    
    if (!clientIp) {
      return next();
    }

    const blockedIp = await db
      .select()
      .from(ipBlocklist)
      .where(
        and(
          eq(ipBlocklist.ipAddress, clientIp),
          eq(ipBlocklist.isActive, true)
        )
      )
      .limit(1);

    if (blockedIp.length > 0) {
      const block = blockedIp[0];
      if (block.expiresAt) {
        const expiresAt = new Date(block.expiresAt);
        if (expiresAt < new Date()) {
          await db.update(ipBlocklist).set({ isActive: false }).where(eq(ipBlocklist.id, block.id));
          return next();
        }
      }

      await logSecurityEvent('ip_blocked', req, undefined, undefined, 403, `Blocked IP: ${block.reason}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    next();
  } catch (error) {
    console.error('[Security] IP blocklist check failed:', error);
    next();
  }
}

export async function apiKeyAuthMiddleware(req: SecureRequest, res: Response, next: NextFunction) {
  try {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      await logSecurityEvent('auth_missing_key', req, undefined, undefined, 401);
      return res.status(401).json({ error: 'API key is required' });
    }

    const keyPrefix = apiKey.substring(0, 8);

    const potentialKeys = await db
      .select()
      .from(secureApiKeys)
      .where(
        and(
          eq(secureApiKeys.keyPrefix, keyPrefix),
          eq(secureApiKeys.isActive, true)
        )
      );

    let matchedKey = null;
    for (const key of potentialKeys) {
      const isMatch = await bcrypt.compare(apiKey, key.keyHash);
      if (isMatch) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      await logSecurityEvent('auth_invalid_key', req, undefined, undefined, 401, `Key prefix: ${keyPrefix}`);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (matchedKey.expiresAt) {
      const expiresAt = new Date(matchedKey.expiresAt);
      if (expiresAt < new Date()) {
        await logSecurityEvent('auth_expired_key', req, matchedKey.id, matchedKey.userId, 401);
        return res.status(401).json({ error: 'API key has expired' });
      }
    }

    await db.update(secureApiKeys)
      .set({
        lastUsedAt: new Date().toISOString(),
        requestCount: matchedKey.requestCount + 1,
      })
      .where(eq(secureApiKeys.id, matchedKey.id));

    req.secureApiKey = {
      id: matchedKey.id,
      userId: matchedKey.userId,
      role: matchedKey.role,
      label: matchedKey.label,
    };

    await logSecurityEvent('auth_success', req, matchedKey.id, matchedKey.userId, 200);
    next();
  } catch (error: any) {
    console.error('[Security] API key auth failed:', error);
    await logSecurityEvent('auth_error', req, undefined, undefined, 500, error.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function hmacVerificationMiddleware(req: SecureRequest, res: Response, next: NextFunction) {
  try {
    if (!req.secureApiKey) {
      return res.status(401).json({ error: 'API key authentication required first' });
    }

    const signature = req.headers['x-signature'] as string;
    const timestamp = req.headers['x-timestamp'] as string;
    const nonce = req.headers['x-nonce'] as string;

    if (!signature || !timestamp || !nonce) {
      await logSecurityEvent('hmac_missing_headers', req, req.secureApiKey.id, req.secureApiKey.userId, 400);
      return res.status(400).json({
        error: 'Missing required headers: X-Signature, X-Timestamp, X-Nonce',
      });
    }

    const requestTimestamp = parseInt(timestamp, 10);
    const currentTime = Date.now();
    const timeDiff = Math.abs(currentTime - requestTimestamp);

    if (timeDiff > REQUEST_TIMESTAMP_TOLERANCE_MS) {
      await logSecurityEvent('hmac_timestamp_expired', req, req.secureApiKey.id, req.secureApiKey.userId, 403);
      return res.status(403).json({
        error: 'Request timestamp expired. Ensure your system clock is synchronized.',
      });
    }

    const existingNonce = await db
      .select()
      .from(usedNonces)
      .where(eq(usedNonces.nonce, nonce))
      .limit(1);

    if (existingNonce.length > 0) {
      await logSecurityEvent('hmac_nonce_replay', req, req.secureApiKey.id, req.secureApiKey.userId, 403);
      return res.status(403).json({
        error: 'Nonce already used. Potential replay attack detected.',
      });
    }

    const apiKeyData = await db
      .select()
      .from(secureApiKeys)
      .where(eq(secureApiKeys.id, req.secureApiKey.id))
      .limit(1);

    if (apiKeyData.length === 0) {
      return res.status(401).json({ error: 'API key not found' });
    }

    const hmacSecret = apiKeyData[0].hmacSecret;

    const bodyString = req.body ? JSON.stringify(req.body) : '';
    const signaturePayload = `${timestamp}:${nonce}:${bodyString}`;
    const expectedSignature = crypto
      .createHmac('sha256', hmacSecret)
      .update(signaturePayload)
      .digest('hex');

    if (signature !== expectedSignature) {
      await logSecurityEvent('hmac_invalid_signature', req, req.secureApiKey.id, req.secureApiKey.userId, 403);
      return res.status(403).json({
        error: 'Invalid signature. Request may have been tampered with.',
      });
    }

    const nonceExpiresAt = new Date(Date.now() + NONCE_EXPIRY_MINUTES * 60 * 1000).toISOString();
    await db.insert(usedNonces).values({
      nonce,
      apiKeyId: req.secureApiKey.id,
      expiresAt: nonceExpiresAt,
    });

    await logSecurityEvent('hmac_verified', req, req.secureApiKey.id, req.secureApiKey.userId, 200);
    next();
  } catch (error: any) {
    console.error('[Security] HMAC verification failed:', error);
    await logSecurityEvent('hmac_error', req, req.secureApiKey?.id, req.secureApiKey?.userId, 500, error.message);
    return res.status(500).json({ error: 'Signature verification failed' });
  }
}

export function rbacMiddleware(allowedRoles: string[]) {
  return async (req: SecureRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.secureApiKey) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const userRole = req.secureApiKey.role;

      if (!allowedRoles.includes(userRole)) {
        await logSecurityEvent(
          'rbac_access_denied',
          req,
          req.secureApiKey.id,
          req.secureApiKey.userId,
          403,
          `Required roles: ${allowedRoles.join(', ')}, User role: ${userRole}`
        );
        return res.status(403).json({
          error: 'Access denied. Insufficient permissions.',
        });
      }

      await logSecurityEvent('rbac_access_granted', req, req.secureApiKey.id, req.secureApiKey.userId, 200);
      next();
    } catch (error: any) {
      console.error('[Security] RBAC check failed:', error);
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

export async function generateSecureApiKey(userId: string, role: string = 'user', label: string = 'Default API Key') {
  const apiKey = `sk_live_${crypto.randomBytes(32).toString('hex')}`;
  const keyPrefix = apiKey.substring(0, 8);
  const keyHash = await bcrypt.hash(apiKey, 12);
  const hmacSecret = crypto.randomBytes(32).toString('hex');

  const [newKey] = await db.insert(secureApiKeys).values({
    userId,
    keyHash,
    keyPrefix,
    label,
    role,
    hmacSecret,
  }).returning();

  return {
    apiKey,
    keyId: newKey.id,
    hmacSecret,
    label,
    role,
  };
}

export async function cleanupExpiredNonces() {
  try {
    const now = new Date().toISOString();
    await db.delete(usedNonces).where(lt(usedNonces.expiresAt, now));
    console.log('[Security] Expired nonces cleaned up');
  } catch (error) {
    console.error('[Security] Failed to cleanup nonces:', error);
  }
}

setInterval(cleanupExpiredNonces, 5 * 60 * 1000);

export function generateClientSignature(timestamp: number, nonce: string, body: any, hmacSecret: string): string {
  const bodyString = body ? JSON.stringify(body) : '';
  const signaturePayload = `${timestamp}:${nonce}:${bodyString}`;
  return crypto.createHmac('sha256', hmacSecret).update(signaturePayload).digest('hex');
}
