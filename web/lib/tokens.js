import crypto from 'crypto';

export function generateToken() {
  const raw = crypto.randomBytes(24).toString('base64url');
  return `cdk_${raw}`;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
